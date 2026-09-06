/**
 * Order execution — the only place BinaText calls a Binance *write* tool.
 * Reached only after: deterministic guard passed at proposal time, a correct
 * single-use PIN, and here a fresh-price slippage check + a second guard pass.
 */

import type { Agent } from "agents";
import { BINANCE_SERVER_ID, getTickerPrice, mcpText, type ToolMap } from "../mcp/binance.ts";
import { enforceOrderPolicy, type OrderPolicyConfig } from "./policy.ts";
import { restate, type Proposal } from "./proposals.ts";
import type { AccessLevel } from "../agent/decide.ts";

export type ExecuteResult =
  | { kind: "stub"; message: string }
  | { kind: "filled"; message: string; spentUsd: number; orderId: string; raw: string }
  | { kind: "aborted"; message: string }
  | { kind: "auth_error"; message: string }
  | { kind: "error"; message: string };

export async function runProposal(
  agent: Agent<never>,
  proposal: Proposal,
  ctx: {
    toolMap: ToolMap;
    accessLevel: AccessLevel;
    policy: OrderPolicyConfig;
    dailyUsedUsd: number;
    slippageAbortPct: number;
    now: number;
  },
): Promise<ExecuteResult> {
  // 1. fresh price
  let price: number;
  try {
    price = await getTickerPrice(agent, ctx.toolMap, proposal.symbol);
  } catch (err) {
    return classify(err, "Couldn't fetch a current price to check the order — try again.");
  }

  // 2. slippage
  const movePct = Math.abs(price - proposal.quotePrice) / proposal.quotePrice * 100;
  if (movePct > ctx.slippageAbortPct) {
    return {
      kind: "aborted",
      message: `Price moved ${movePct.toFixed(1)}% since the proposal ($${proposal.quotePrice} → $${price}). Send the request again.`,
    };
  }

  // 3. second deterministic guard, on the live notional
  const liveNotional =
    proposal.type === "MARKET" ? proposal.notionalUsd * (price / proposal.quotePrice) : proposal.notionalUsd;
  const guard = enforceOrderPolicy(
    { symbol: proposal.symbol, side: proposal.side, notionalUsd: liveNotional, dailyUsedUsd: ctx.dailyUsedUsd },
    ctx.policy,
  );
  if (!guard.ok) return { kind: "aborted", message: `Blocked: ${guard.reason}` };

  const restated = restate({ ...proposal, quotePrice: price, notionalUsd: liveNotional });

  // 4a. read-only: never touch the exchange
  if (ctx.accessLevel === "read-only") {
    return { kind: "stub", message: `Read-only mode — would place: ${restated}. Connect with Full access to trade for real.` };
  }

  // 4b. full: place it
  if (!ctx.toolMap.placeOrder) {
    return { kind: "error", message: "Order tool not available — reconnect and grant the Trade scope." };
  }
  try {
    const raw = await agent.mcp.callTool({
      serverId: BINANCE_SERVER_ID,
      name: ctx.toolMap.placeOrder,
      arguments: {
        symbol: proposal.symbol,
        side: proposal.side,
        type: proposal.type,
        // Binance spot: quoteOrderQty for a USD-sized market buy; quantity otherwise.
        ...(proposal.type === "MARKET" && proposal.side === "BUY"
          ? { quoteOrderQty: round2(liveNotional) }
          : { quantity: round8(liveNotional / price) }),
        ...(proposal.limitPrice !== undefined ? { price: proposal.limitPrice } : {}),
      },
    });
    const fill = parseOrderResponse(raw, liveNotional);
    return {
      kind: "filled",
      spentUsd: fill.spentUsd,
      orderId: fill.orderId,
      raw: mcpText(raw) ?? JSON.stringify(raw),
      message:
        `Filled. ${proposal.side} ${fill.executedQty} ${proposal.symbol.replace(/USDT$/, "")} ` +
        `for ~$${fill.spentUsd.toFixed(2)}${fill.avgPrice ? ` (avg $${fill.avgPrice})` : ""}. Order ${fill.orderId}.`,
    };
  } catch (err) {
    return classify(err, `Order failed: ${shortReason(err)}`);
  }
}

export async function cancelOpenOrders(
  agent: Agent<never>,
  toolMap: ToolMap,
): Promise<{ message: string }> {
  const tool = toolMap.cancelAllOrders ?? toolMap.cancelOrder;
  if (!tool) return { message: "No cancel tool available on this connection." };
  try {
    const raw = await agent.mcp.callTool({ serverId: BINANCE_SERVER_ID, name: tool, arguments: {} });
    const txt = mcpText(raw) ?? "";
    return { message: `Open orders cancelled.${txt ? ` (${txt.slice(0, 120)})` : ""}` };
  } catch (err) {
    return { message: `Couldn't cancel open orders: ${shortReason(err)}` };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface Fill {
  executedQty: string;
  spentUsd: number;
  avgPrice: string | null;
  orderId: string;
}

export function parseOrderResponse(raw: unknown, fallbackUsd: number): Fill {
  const text = mcpText(raw) ?? "";
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* leave j empty; fall back below */
  }
  const num = (v: unknown) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const executedQty = num(j.executedQty);
  const cummQuote = num(j.cummulativeQuoteQty) ?? num(j.cumQuote);
  return {
    executedQty: executedQty !== undefined ? String(executedQty) : "?",
    spentUsd: cummQuote ?? fallbackUsd,
    avgPrice:
      executedQty && cummQuote && executedQty > 0 ? (cummQuote / executedQty).toFixed(2) : null,
    orderId: String(j.orderId ?? j.clientOrderId ?? "?"),
  };
}

function classify(err: unknown, generic: string): ExecuteResult {
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  if (/unauthor|401|token|invalid.?grant|expired/.test(msg)) {
    return { kind: "auth_error", message: "Your Binance session expired — reconnect, then resend the order." };
  }
  return { kind: "error", message: generic };
}

function shortReason(err: unknown): string {
  return String((err as Error)?.message ?? "unknown error").slice(0, 140);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round8 = (n: number) => Math.round(n * 1e8) / 1e8;
