/**
 * Binance access via the local bridge.
 *
 * Binance Agent OS OAuth only accepts allowlisted host clients (Claude Code,
 * ChatGPT, VS Code, …) — a standalone Worker cannot complete consent. So BinaText
 * reaches Agent OS indirectly: it enqueues a job on the global AlertRegistry DO;
 * `bridge/run.mjs` (running on the operator's machine, signed in to Binance via
 * Claude Code) claims it, executes exactly that one MCP call through a
 * constrained `claude -p`, and posts the result back.
 *
 * The Worker still owns every safety decision — the deterministic policy guard,
 * the daily ledger, the rotating PIN. The bridge only ever runs the specific
 * operation the Worker asks for.
 */

import type { Env } from "../shared/env.ts";

export type BridgeOp = "ticker" | "balances" | "place_order" | "open_orders" | "cancel_all";

interface RegistryStub {
  bridgeEnqueue(op: string, argsJson: string): Promise<string> | string;
  bridgeGet(id: string): Promise<{ status: string; payload: string | null } | null> | { status: string; payload: string | null } | null;
  bridgeLastPoll(): Promise<number> | number;
}

function registry(env: Env): RegistryStub {
  return env.AlertRegistry.get(env.AlertRegistry.idFromName("global")) as unknown as RegistryStub;
}

/** Is the operator's bridge alive? (polled within the last 90s.) */
export async function bridgeReady(env: Env): Promise<boolean> {
  if (!env.BRIDGE_SECRET) return false;
  const last = await registry(env).bridgeLastPoll();
  return Date.now() - last < 90_000;
}

export class BridgeError extends Error {}

/**
 * Enqueue one Binance operation and wait for the bridge to run it.
 * Throws BridgeError on timeout or a reported failure.
 */
export async function bridgeCall<T = unknown>(
  env: Env,
  op: BridgeOp,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  if (!env.BRIDGE_SECRET) throw new BridgeError("Trading backend not configured.");
  const reg = registry(env);
  const id = await reg.bridgeEnqueue(op, JSON.stringify(args));

  const timeoutMs = opts.timeoutMs ?? 75_000;
  const pollMs = opts.pollMs ?? 700;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const row = await reg.bridgeGet(id);
    if (!row || row.status === "pending" || row.status === "claimed") continue;
    const payload = row.payload ? (JSON.parse(row.payload) as { data?: T; error?: string }) : {};
    if (row.status === "error") throw new BridgeError(payload.error ?? "Binance call failed.");
    return payload.data as T;
  }
  throw new BridgeError("The trading service didn't respond in time. Try again.");
}

/** Live spot price for a symbol, e.g. "BTCUSDT". */
export async function bridgeGetPrice(env: Env, symbol: string): Promise<number> {
  const r = await bridgeCall<{ price: number }>(env, "ticker", { symbol });
  const p = Number(r?.price);
  if (!Number.isFinite(p) || p <= 0) throw new BridgeError(`No price for ${symbol}.`);
  return p;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
