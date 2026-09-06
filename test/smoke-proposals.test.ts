import { describe, expect, it } from "vitest";
import {
  createProposal,
  mintPin,
  parseConfirmation,
  restate,
  verifyPin,
  type Proposal,
} from "../src/trade/proposals.ts";

const T0 = 1_700_000_000_000;

function make(overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal(
      { symbol: "BNBUSDT", side: "BUY", type: "MARKET", notionalUsd: 5, quotePrice: 750 },
      { now: T0, ttlSeconds: 300, id: "p1" },
    ),
    ...overrides,
  };
}

describe("mintPin", () => {
  it("is always 4 digits", () => {
    for (let i = 0; i < 200; i++) expect(mintPin()).toMatch(/^\d{4}$/);
  });
  it("never repeats the previous pin", () => {
    for (let i = 0; i < 200; i++) {
      const prev = mintPin();
      expect(mintPin(prev)).not.toBe(prev);
    }
  });
});

describe("parseConfirmation", () => {
  it.each([
    ["YES 1234", { kind: "yes", pin: "1234" }],
    ["yes 1234", { kind: "yes", pin: "1234" }],
    ["  YES   0007 ", { kind: "yes", pin: "0007" }],
    ["NO", { kind: "no" }],
    ["cancel", { kind: "no" }],
    ["STOP", { kind: "stop" }],
    ["YES", { kind: "other" }],
    ["YES 12", { kind: "other" }],
    ["buy more BNB", { kind: "other" }],
  ] as const)("%s", (input, expected) => {
    expect(parseConfirmation(input)).toEqual(expected);
  });
});

describe("verifyPin", () => {
  it("OK on the right pin", () => {
    const p = make({ pin: "4821" });
    expect(verifyPin(p, "4821", { now: T0 + 1000, maxAttempts: 3 })).toEqual({ status: "OK" });
  });

  it("EXPIRED once past expiresAt (even with the right pin)", () => {
    const p = make({ pin: "4821" });
    expect(verifyPin(p, "4821", { now: T0 + 300_001, maxAttempts: 3 }).status).toBe("EXPIRED");
  });

  it("BAD_PIN bumps attempts and reports remaining", () => {
    const p = make({ pin: "4821", attempts: 0 });
    const v = verifyPin(p, "0000", { now: T0, maxAttempts: 3 });
    expect(v.status).toBe("BAD_PIN");
    if (v.status === "BAD_PIN") {
      expect(v.attemptsLeft).toBe(2);
      expect(v.proposal.attempts).toBe(1);
    }
  });

  it("LOCKED on the final wrong attempt", () => {
    const p = make({ pin: "4821", attempts: 2 });
    expect(verifyPin(p, "0000", { now: T0, maxAttempts: 3 }).status).toBe("LOCKED");
  });
});

describe("createProposal", () => {
  it("sets expiry from ttl and avoids the previous pin", () => {
    const p = createProposal(
      { symbol: "SOLUSDT", side: "SELL", type: "MARKET", notionalUsd: 3, quotePrice: 140 },
      { now: T0, ttlSeconds: 120, prevPin: "1111" },
    );
    expect(p.expiresAt).toBe(T0 + 120_000);
    expect(p.pin).not.toBe("1111");
    expect(p.attempts).toBe(0);
  });
});

describe("restate", () => {
  it("reads like an order confirmation", () => {
    const p = make({ notionalUsd: 5, quotePrice: 754.2, symbol: "BNBUSDT", side: "BUY" });
    expect(restate(p)).toBe("BUY ~$5.00 of BNB @ ~$754.2 (MARKET)");
  });
});
