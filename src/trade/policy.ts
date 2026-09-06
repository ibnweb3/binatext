/**
 * The money-safety gate. **No LLM, no model output, no human — just integer math.**
 *
 * Every order the agent is about to place passes through `enforceOrderPolicy`
 * first, both when the proposal is created and again (with a fresh price) right
 * before it executes. It answers one question with a hard number comparison:
 * "is this order within the caps the operator configured?" If not, the order
 * never reaches the Binance MCP write tool.
 *
 * Ported from `WokRx/src/buyerFlow.js` `enforceSpendingPolicy()` — same idea
 * (deterministic pre-signature check in atomic units), adapted from x402
 * payments to spot orders.
 *
 * Amounts are carried as integer **cents** (BigInt) so that summing a day's
 * orders never drifts the way repeated float addition would.
 */

export type OrderSide = "BUY" | "SELL";

export interface OrderPolicyConfig {
  /** Largest single order, in USD. From MAX_ORDER_USD. */
  maxOrderUsd: number;
  /** Most the account may trade in one UTC day, in USD. From DAILY_USD_CAP. */
  dailyCapUsd: number;
  /** Symbols the agent is allowed to touch, e.g. ["BTCUSDT","BNBUSDT"]. From ALLOWED_SYMBOLS. */
  allowedSymbols: string[];
}

export interface OrderPolicyInput {
  /** Full trading pair, already normalized (e.g. "BNBUSDT"). */
  symbol: string;
  side: OrderSide;
  /** This order's notional value in USD (quote amount, or baseQty * live price). */
  notionalUsd: number;
  /** USD already traded today (sum of prior fills this UTC day). */
  dailyUsedUsd: number;
}

export type OrderPolicyResult =
  | { ok: true; notionalUsd: number }
  | { ok: false; reason: string };

/** USD (possibly fractional) -> integer cents, half-up. Throws on non-finite. */
function toCents(usd: number, label: string): bigint {
  if (!Number.isFinite(usd)) {
    throw new PolicyInputError(`${label} is not a finite number (${usd})`);
  }
  return BigInt(Math.round(usd * 100));
}

export class PolicyInputError extends Error {}

/**
 * Returns `{ ok: true }` only when every check passes. On failure, `reason` is a
 * short user-facing sentence — the model relays it verbatim over SMS, and the
 * smoke test asserts on it, so keep the wording stable.
 */
export function enforceOrderPolicy(
  input: OrderPolicyInput,
  cfg: OrderPolicyConfig,
): OrderPolicyResult {
  const symbol = input.symbol.trim().toUpperCase();

  if (!cfg.allowedSymbols.includes(symbol)) {
    return {
      ok: false,
      reason: `I can only trade ${cfg.allowedSymbols.join(", ")} — not ${symbol}.`,
    };
  }

  if (input.side !== "BUY" && input.side !== "SELL") {
    return { ok: false, reason: `Unrecognised side "${input.side}" — expected BUY or SELL.` };
  }

  let notionalCents: bigint;
  let usedCents: bigint;
  try {
    notionalCents = toCents(input.notionalUsd, "order amount");
    usedCents = toCents(Math.max(0, input.dailyUsedUsd), "daily total");
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  if (notionalCents <= 0n) {
    return { ok: false, reason: "Order amount must be greater than zero." };
  }

  const maxOrderCents = toCents(cfg.maxOrderUsd, "MAX_ORDER_USD");
  if (notionalCents > maxOrderCents) {
    return {
      ok: false,
      reason:
        `That order is ~$${(Number(notionalCents) / 100).toFixed(2)}, over the ` +
        `$${cfg.maxOrderUsd.toFixed(2)} per-order limit.`,
    };
  }

  const dailyCapCents = toCents(cfg.dailyCapUsd, "DAILY_USD_CAP");
  if (usedCents + notionalCents > dailyCapCents) {
    const remaining = Number(dailyCapCents - usedCents) / 100;
    return {
      ok: false,
      reason:
        `That would put today's trading over the $${cfg.dailyCapUsd.toFixed(2)} daily cap ` +
        `(only $${Math.max(0, remaining).toFixed(2)} left today).`,
    };
  }

  return { ok: true, notionalUsd: Number(notionalCents) / 100 };
}

/** Build a policy config from the Worker env. Kept out of `enforceOrderPolicy` so that stays pure. */
export function policyConfigFromEnv(env: {
  MAX_ORDER_USD: string;
  DAILY_USD_CAP: string;
  ALLOWED_SYMBOLS: string;
}): OrderPolicyConfig {
  const num = (raw: string, name: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new PolicyInputError(`${name} must be a positive number, got "${raw}"`);
    }
    return n;
  };
  return {
    maxOrderUsd: num(env.MAX_ORDER_USD, "MAX_ORDER_USD"),
    dailyCapUsd: num(env.DAILY_USD_CAP, "DAILY_USD_CAP"),
    allowedSymbols: env.ALLOWED_SYMBOLS.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  };
}
