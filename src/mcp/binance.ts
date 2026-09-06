/**
 * Binance Agent OS MCP wiring.
 *
 * - Connects via the `agents` SDK MCP client (OAuth 2.1 + PKCE; tokens land in
 *   the DO's SQLite, auto-refreshed).
 * - Discovers the server's real tool names (not published — matched by pattern)
 *   and caches a capability -> name map.
 * - Hands the model ONLY read tools. Placing / cancelling / transferring is done
 *   by the DO via `mcp.callTool`, after the deterministic guard and the PIN.
 *
 * Exact tool names are confirmed by `scripts/spike-mcp-oauth` before Day 1 —
 * update DEFAULT_PATTERNS if the spike shows different names.
 */

import type { Agent } from "agents";
import type { ToolSet } from "ai";

export const BINANCE_SERVER_ID = "binance";

/** Tool-name substrings the model must NEVER be able to call. */
const WRITE_TOKENS = /(place|new|create|submit|cancel|replace|amend|transfer|withdraw|redeem|repay|borrow)/i;

/** capability -> RegExp used to resolve the server's actual tool names. */
const DEFAULT_PATTERNS: Record<string, RegExp> = {
  ticker: /(ticker|price|24hr|symbol.*price)/i,
  klines: /(kline|candle|ohlc)/i,
  orderBook: /(depth|order.?book)/i,
  balances: /(balance|account.*info|portfolio|positions)/i,
  openOrders: /open.?orders/i,
  placeOrder: /(place|new|create).*order/i,
  cancelOrder: /cancel.*order/i,
  cancelAllOrders: /cancel.*(all|open).*orders/i,
  convert: /convert/i,
};

export type ToolMap = Partial<Record<keyof typeof DEFAULT_PATTERNS, string>>;

export interface BinanceConn {
  serverId: string;
  state: string;
  authUrl?: string;
  error?: string | null;
}

/** Start (or resume) the connection. Returns `authUrl` when consent is needed. */
export async function connectBinance(
  agent: Agent<never>,
  opts: { url: string; publicHost: string },
): Promise<BinanceConn> {
  const res = await agent.addMcpServer(BINANCE_SERVER_ID, opts.url, {
    id: BINANCE_SERVER_ID,
    callbackHost: opts.publicHost.startsWith("http") ? opts.publicHost : `https://${opts.publicHost}`,
    transport: { type: "streamable-http" },
  });
  return {
    serverId: res.id,
    state: res.state,
    ...("authUrl" in res ? { authUrl: res.authUrl } : {}),
  };
}

/** Current connection status from stored server state. */
export function binanceStatus(agent: Agent<never>): { ready: boolean; state: string; error: string | null } {
  const server = agent.getMcpServers().servers[BINANCE_SERVER_ID];
  if (!server) return { ready: false, state: "absent", error: null };
  return { ready: server.state === "ready", state: server.state, error: server.error };
}

/** Resolve capability -> real tool name by matching the server's advertised tools. */
export function discoverToolMap(agent: Agent<never>): ToolMap {
  const tools = agent
    .getMcpServers()
    .tools.filter((t) => t.serverId === BINANCE_SERVER_ID)
    .map((t) => t.name);

  const map: ToolMap = {};
  for (const [cap, re] of Object.entries(DEFAULT_PATTERNS) as [keyof ToolMap, RegExp][]) {
    // Prefer the most specific match (e.g. "cancel all" before plain "cancel").
    const hit = tools.find((n) => re.test(n));
    if (hit) map[cap] = hit;
  }
  return map;
}

/** The read-only subset of Binance tools, for the model loop. Write tools are stripped. */
export function readOnlyBinanceTools(agent: Agent<never>): ToolSet {
  const all = agent.mcp.getAITools({ serverName: BINANCE_SERVER_ID }) as unknown as ToolSet;
  const safe: ToolSet = {};
  for (const [key, tool] of Object.entries(all)) {
    if (WRITE_TOKENS.test(key)) continue;
    safe[key] = tool;
  }
  return safe;
}

/** Live price for a symbol via the MCP ticker tool. Throws if the tool/shape is unexpected. */
export async function getTickerPrice(
  agent: Agent<never>,
  toolMap: ToolMap,
  symbol: string,
): Promise<number> {
  if (!toolMap.ticker) throw new Error("Binance ticker tool not found — run spike-mcp-oauth to refresh the tool map.");
  const raw = await agent.mcp.callTool({
    serverId: BINANCE_SERVER_ID,
    name: toolMap.ticker,
    arguments: { symbol },
  });
  const price = extractPrice(raw);
  if (price === undefined) throw new Error(`Could not read a price for ${symbol} from the ticker response.`);
  return price;
}

/** Best-effort price extraction — Binance ticker responses vary by tool. */
export function extractPrice(raw: unknown): number | undefined {
  const text = mcpText(raw);
  if (text) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const k of ["price", "lastPrice", "last", "c", "weightedAvgPrice"]) {
        const v = j[k];
        if (v !== undefined && Number.isFinite(Number(v))) return Number(v);
      }
    } catch {
      const m = /"?(?:price|lastPrice)"?\s*[:=]\s*"?([\d.]+)/i.exec(text);
      if (m) return Number(m[1]);
    }
  }
  return undefined;
}

/** Pull the text payload out of an MCP tool result. */
export function mcpText(raw: unknown): string | undefined {
  const content = (raw as { content?: Array<{ type: string; text?: string }> })?.content;
  if (Array.isArray(content)) {
    const t = content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
    if (t) return t;
  }
  if (typeof raw === "string") return raw;
  return undefined;
}
