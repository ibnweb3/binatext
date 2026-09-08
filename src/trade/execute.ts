/**
 * Order execution - the only place BinaText triggers a Binance *write*.
 * Reached only after: the deterministic guard passed at proposal time, a correct
 * single-use PIN, and here a fresh-price slippage check + a second guard pass.
 *
 * The write itself runs on the operator's machine via the bridge
 * (src/mcp/bridge.ts): a constrained `claude -p` call to the Binance Agent OS
 * `spot_newOrder` tool with exactly the arguments computed here.
 */

import type { Env } from "../shared/env.ts";
import { bridgeCall, bridgeGetPrice, BridgeError } from "../mcp/bridge.ts";
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
  env: Env,
  proposal: Proposal,
  ctx: {
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
    price = await bridgeGetPrice(env, proposal.symbol);
  } catch (err) {
    return classify(err, "Could not fetch a current price to check the order - try again.");
  }

  // 2. slippage
  const movePct = (Math.abs(price - proposal.quotePrice) / proposal.quotePrice) * 100;
  if (movePct > ctx.slippageAbortPct) {
    return {
      kind: "aborted",
      message: `Price moved ${movePct.toFixed(1)}% since the proposal ($${proposal.quotePrice} to $${price}). Send the request again.`,
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
    return {
      kind: "stub",
      message: `Read-only mode - would place: ${restated}. (Real trading runs on the operator's Binance via Agent OS.)`,
    };
  }

  // 4b. full: place it through the bridge
  const args: Record<string, unknown> = {
    symbol: proposal.symbol,
    side: proposal.side,
    type: proposal.type,
    ...(proposal.type === "MARKET" && proposal.side === "BUY"
      ? { quoteOrderQty: round2(liveNotional) }
      : { quantity: round8(liveNotional / price) }),
    ...(proposal.limitPrice !== undefined ? { price: proposal.limitPrice } : {}),
  };

  try {
    const raw = await bridgeCall<unknown>(env, "place_order", args, { timeoutMs: 45_000 });
    const fill = parseOrderResponse(raw, liveNotional);
    return {
      kind: "filled",
      spentUsd: fill.spentUsd,
      orderId: fill.orderId,
      raw: typeof raw === "string" ? raw : JSON.stringify(raw),
      message:
        `Filled. ${proposal.side} ${fill.executedQty} ${proposal.symbol.replace(/USDT$/, "")} ` +
        `for ~$${fill.spentUsd.toFixed(2)}${fill.avgPrice ? ` (avg $${fill.avgPrice})` : ""}. Order ${fill.orderId}.`,
    };
  } catch (err) {
    return classify(err, `Order failed: ${shortReason(err)}`);
  }
}

export async function cancelOpenOrders(env: Env, symbols: string[]): Promise<{ message: string }> {
  const done: string[] = [];
  for (const symbol of symbols) {
    try {
      await bridgeCall(env, "cancel_all", { symbol }, { timeoutMs: 30_000 });
      done.push(symbol.replace(/USDT$/, ""));
    } catch {
      /* no open orders on that symbol, or transient — ignore */
    }
  }
  return { message: done.length ? `Cancelled open orders on ${done.join(", ")}.` : "No open orders to cancel." };
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface Fill {
  executedQty: string;
  spentUsd: number;
  avgPrice: string | null;
  orderId: string;
}

export function parseOrderResponse(raw: unknown, fallbackUsd: number): Fill {
  let j: Record<string, unknown> = {};
  if (raw && typeof raw === "object") {
    j = raw as Record<string, unknown>;
  } else if (typeof raw === "string") {
    try {
      j = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* leave j empty */
    }
  }
  const num = (v: unknown) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const executedQty = num(j.executedQty);
  const cummQuote = num(j.cummulativeQuoteQty) ?? num(j.cumQuote);
  return {
    executedQty: executedQty !== undefined ? String(executedQty) : "?",
    spentUsd: cummQuote ?? fallbackUsd,
    avgPrice: executedQty && cummQuote && executedQty > 0 ? (cummQuote / executedQty).toFixed(2) : null,
    orderId: String(j.orderId ?? j.clientOrderId ?? "?"),
  };
}

function classify(err: unknown, generic: string): ExecuteResult {
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  if (err instanceof BridgeError && /offline|respond in time|not configured/.test(msg)) {
    return { kind: "error", message: "The trading service is offline right now - resend the order shortly." };
  }
  if (/unauthor|401|token|invalid.?grant|expired/.test(msg)) {
    return { kind: "auth_error", message: "The Binance session on the bridge expired - it needs reconnecting." };
  }
  return { kind: "error", message: generic };
}

function shortReason(err: unknown): string {
  return String((err as Error)?.message ?? "unknown error").slice(0, 140);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round8 = (n: number) => Math.round(n * 1e8) / 1e8;
