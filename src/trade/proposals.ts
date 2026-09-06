/**
 * Pending-order + PIN lifecycle. Pure functions over a `Proposal` value plus an
 * injected clock — the Durable Object owns persistence (one row) and calls
 * these. Keeping the rules here (not in the DO) is what lets `smoke-statemachine`
 * drive every transition with a fake clock and no Workers runtime.
 *
 * Invariant enforced by the DO: **at most one pending proposal per phone.**
 */

import type { OrderSide } from "./policy.ts";

export type OrderType = "MARKET" | "LIMIT";

export interface Proposal {
  id: string;
  symbol: string; // normalized, e.g. "BNBUSDT"
  side: OrderSide;
  type: OrderType;
  /** USD notional the guard approved. */
  notionalUsd: number;
  /** Spot price when the proposal was made — used for the slippage re-check on confirm. */
  quotePrice: number;
  limitPrice?: number;
  /** 4 digits. Single-use: the DO deletes the proposal on a correct PIN. */
  pin: string;
  /** Wrong-PIN attempts so far. */
  attempts: number;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

export interface NewProposalParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  notionalUsd: number;
  quotePrice: number;
  limitPrice?: number;
}

/** 4-digit PIN, never equal to `prev` (so a re-proposed order doesn't reuse the code). */
export function mintPin(prev?: string): string {
  for (;;) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    if (pin !== prev) return pin;
  }
}

export function createProposal(
  params: NewProposalParams,
  opts: { now: number; ttlSeconds: number; prevPin?: string; id?: string },
): Proposal {
  return {
    id: opts.id ?? crypto.randomUUID(),
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    notionalUsd: params.notionalUsd,
    quotePrice: params.quotePrice,
    ...(params.limitPrice !== undefined ? { limitPrice: params.limitPrice } : {}),
    pin: mintPin(opts.prevPin),
    attempts: 0,
    createdAt: opts.now,
    expiresAt: opts.now + opts.ttlSeconds * 1000,
  };
}

export function isExpired(p: Proposal, now: number): boolean {
  return now >= p.expiresAt;
}

export type PinVerdict =
  | { status: "OK" }
  | { status: "EXPIRED" }
  | { status: "BAD_PIN"; attemptsLeft: number; proposal: Proposal }
  | { status: "LOCKED" };

/**
 * Check a `YES <pin>` reply. Does NOT mutate storage — returns a verdict plus,
 * for a wrong-but-not-yet-locked attempt, the proposal with `attempts` bumped
 * for the DO to persist. `OK` and `LOCKED` mean the DO should discard the
 * proposal (consumed / too many tries); `EXPIRED` likewise.
 */
export function verifyPin(
  p: Proposal,
  input: string,
  opts: { now: number; maxAttempts: number },
): PinVerdict {
  if (isExpired(p, opts.now)) return { status: "EXPIRED" };
  if (input === p.pin) return { status: "OK" };

  const attempts = p.attempts + 1;
  if (attempts >= opts.maxAttempts) return { status: "LOCKED" };
  return {
    status: "BAD_PIN",
    attemptsLeft: opts.maxAttempts - attempts,
    proposal: { ...p, attempts },
  };
}

/** Parse an inbound confirmation message. Deterministic — never sees the model. */
export function parseConfirmation(
  body: string,
): { kind: "yes"; pin: string } | { kind: "no" } | { kind: "stop" } | { kind: "other" } {
  const t = body.trim().toUpperCase();
  if (t === "NO" || t === "CANCEL") return { kind: "no" };
  if (t === "STOP") return { kind: "stop" };
  const m = /^YES\s+(\d{4})$/.exec(t);
  if (m) return { kind: "yes", pin: m[1]! };
  return { kind: "other" };
}

/** Human-readable order restatement for the confirmation SMS. */
export function restate(p: Proposal): string {
  const base = p.symbol.replace(/USDT$/, "");
  const amount = `~$${p.notionalUsd.toFixed(2)} of ${base}`;
  const at =
    p.type === "LIMIT" && p.limitPrice !== undefined
      ? `@ $${p.limitPrice} (LIMIT)`
      : `@ ~$${p.quotePrice} (MARKET)`;
  return `${p.side} ${amount} ${at}`;
}
