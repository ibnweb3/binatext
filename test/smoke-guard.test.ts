import { describe, expect, it } from "vitest";
import {
  enforceOrderPolicy,
  policyConfigFromEnv,
  type OrderPolicyConfig,
} from "../src/trade/policy.ts";

/**
 * The money-safety test. `enforceOrderPolicy` is the only thing standing between
 * a model's order proposal and real funds, so this exercises it exhaustively:
 * every combination of {notional, daily-used, symbol, side} the plan calls out,
 * asserting both the pass/block verdict and the exact reason wording.
 */

const CFG: OrderPolicyConfig = {
  maxOrderUsd: 5,
  dailyCapUsd: 20,
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],
};

describe("enforceOrderPolicy — per-order cap ($5)", () => {
  const cases: Array<[number, boolean]> = [
    [0.5, true],
    [4.99, true],
    [5, true],
    [5.01, false],
    [20, false],
    [100, false],
  ];
  for (const [notionalUsd, ok] of cases) {
    it(`$${notionalUsd} -> ${ok ? "allowed" : "blocked"}`, () => {
      const r = enforceOrderPolicy(
        { symbol: "BNBUSDT", side: "BUY", notionalUsd, dailyUsedUsd: 0 },
        CFG,
      );
      expect(r.ok).toBe(ok);
      if (!r.ok) expect(r.reason).toContain("per-order limit");
    });
  }
});

describe("enforceOrderPolicy — daily cap ($20)", () => {
  const cases: Array<[number, number, boolean]> = [
    // [dailyUsedUsd, notionalUsd, ok]
    [0, 5, true],
    [15, 5, true],
    [19.99, 0.5, false], // 20.49 > 20
    [19.5, 0.5, true], // exactly 20.00
    [20, 1, false],
    [15, 5.01, false], // blocked by per-order cap first
  ];
  for (const [dailyUsedUsd, notionalUsd, ok] of cases) {
    it(`used $${dailyUsedUsd} + order $${notionalUsd} -> ${ok ? "allowed" : "blocked"}`, () => {
      const r = enforceOrderPolicy(
        { symbol: "SOLUSDT", side: "BUY", notionalUsd, dailyUsedUsd },
        CFG,
      );
      expect(r.ok).toBe(ok);
    });
  }

  it("names the remaining daily headroom when it blocks", () => {
    const r = enforceOrderPolicy(
      { symbol: "SOLUSDT", side: "BUY", notionalUsd: 5, dailyUsedUsd: 18 },
      CFG,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("daily cap");
      expect(r.reason).toContain("$2.00 left today");
    }
  });
});

describe("enforceOrderPolicy — symbol allowlist", () => {
  for (const symbol of ["BTCUSDT", "ethusdt", " BNBUSDT "]) {
    it(`allows ${JSON.stringify(symbol)} (normalised)`, () => {
      const r = enforceOrderPolicy(
        { symbol, side: "BUY", notionalUsd: 1, dailyUsedUsd: 0 },
        CFG,
      );
      expect(r.ok).toBe(true);
    });
  }
  for (const symbol of ["DOGEUSDT", "BTCUSDC", "BNB", ""]) {
    it(`blocks ${JSON.stringify(symbol)}`, () => {
      const r = enforceOrderPolicy(
        { symbol, side: "BUY", notionalUsd: 1, dailyUsedUsd: 0 },
        CFG,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("I can only trade");
    });
  }
});

describe("enforceOrderPolicy — side", () => {
  for (const side of ["BUY", "SELL"] as const) {
    it(`accepts ${side}`, () => {
      const r = enforceOrderPolicy(
        { symbol: "BTCUSDT", side, notionalUsd: 1, dailyUsedUsd: 0 },
        CFG,
      );
      expect(r.ok).toBe(true);
    });
  }
  it("rejects a bogus side", () => {
    const r = enforceOrderPolicy(
      // @ts-expect-error — deliberately invalid
      { symbol: "BTCUSDT", side: "HODL", notionalUsd: 1, dailyUsedUsd: 0 },
      CFG,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("expected BUY or SELL");
  });
});

describe("enforceOrderPolicy — bad numbers", () => {
  for (const notionalUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`blocks notional ${notionalUsd}`, () => {
      const r = enforceOrderPolicy(
        { symbol: "BTCUSDT", side: "BUY", notionalUsd, dailyUsedUsd: 0 },
        CFG,
      );
      expect(r.ok).toBe(false);
    });
  }
});

describe("policyConfigFromEnv", () => {
  it("parses a well-formed env", () => {
    const cfg = policyConfigFromEnv({
      MAX_ORDER_USD: "5",
      DAILY_USD_CAP: "20",
      ALLOWED_SYMBOLS: "BTCUSDT, ethusdt ,BNBUSDT",
    });
    expect(cfg).toEqual({
      maxOrderUsd: 5,
      dailyCapUsd: 20,
      allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
    });
  });
  for (const bad of ["0", "-5", "abc", ""]) {
    it(`rejects MAX_ORDER_USD="${bad}"`, () => {
      expect(() =>
        policyConfigFromEnv({
          MAX_ORDER_USD: bad,
          DAILY_USD_CAP: "20",
          ALLOWED_SYMBOLS: "BTCUSDT",
        }),
      ).toThrow();
    });
  }
});
