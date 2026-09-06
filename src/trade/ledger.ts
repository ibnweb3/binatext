/**
 * Daily traded-USD rollup. The DO persists one row per UTC day
 * (`ledger_day(day TEXT PRIMARY KEY, used_usd REAL)`); these helpers keep the
 * date-keying and rollover logic pure and testable.
 */

/** UTC calendar day for an epoch-ms timestamp, e.g. "2026-09-08". */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Whether adding `orderUsd` keeps the day at or under `capUsd`, in integer cents. */
export function withinDailyCap(usedUsd: number, orderUsd: number, capUsd: number): boolean {
  const c = (n: number) => BigInt(Math.round(n * 100));
  return c(Math.max(0, usedUsd)) + c(orderUsd) <= c(capUsd);
}

/** USD still available to trade today (never negative). */
export function remainingToday(usedUsd: number, capUsd: number): number {
  return Math.max(0, Math.round((capUsd - Math.max(0, usedUsd)) * 100) / 100);
}
