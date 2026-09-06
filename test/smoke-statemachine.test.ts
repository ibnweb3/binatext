import { describe, expect, it } from "vitest";
import { decideConfirmation, decideOnboarding } from "../src/agent/decide.ts";
import { createProposal, type Proposal } from "../src/trade/proposals.ts";

const T0 = 1_700_000_000_000;
const OPTS = { now: T0 + 1000, maxAttempts: 3 };

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal(
      { symbol: "BNBUSDT", side: "BUY", type: "MARKET", notionalUsd: 5, quotePrice: 750 },
      { now: T0, ttlSeconds: 300, id: "p1" },
    ),
    pin: "4821",
    ...overrides,
  };
}

describe("decideOnboarding", () => {
  it("UNREGISTERED + junk -> welcome", () => {
    expect(decideOnboarding("UNREGISTERED", "hi there")).toEqual({ action: "welcome" });
  });
  it.each(["START", "start", " begin ", "Connect"])("UNREGISTERED + %s -> issue_code", (b) => {
    expect(decideOnboarding("UNREGISTERED", b)).toEqual({ action: "issue_code" });
  });
  it("AWAITING_BINANCE_AUTH + START -> resend_code", () => {
    expect(decideOnboarding("AWAITING_BINANCE_AUTH", "START")).toEqual({ action: "resend_code" });
  });
  it("AWAITING_BINANCE_AUTH + other -> must_finish", () => {
    expect(decideOnboarding("AWAITING_BINANCE_AUTH", "what's BTC doing?")).toEqual({ action: "must_finish" });
  });
  it.each(["RESET", "disconnect", "LogOut"])("%s from any state -> reset", (b) => {
    expect(decideOnboarding("IDLE", b)).toEqual({ action: "reset" });
    expect(decideOnboarding("AWAITING_CONFIRMATION", b)).toEqual({ action: "reset" });
  });
  it("IDLE + normal message -> ignore (falls through to the model loop)", () => {
    expect(decideOnboarding("IDLE", "put $5 into BNB")).toEqual({ action: "ignore" });
  });
});

describe("decideConfirmation", () => {
  it("YES + correct PIN -> execute", () => {
    const d = decideConfirmation(proposal(), "YES 4821", OPTS);
    expect(d.action).toBe("execute");
  });

  it("YES + correct PIN but expired -> expired", () => {
    const d = decideConfirmation(proposal(), "YES 4821", { now: T0 + 300_001, maxAttempts: 3 });
    expect(d).toEqual({ action: "expired" });
  });

  it("NO / CANCEL -> cancelled", () => {
    expect(decideConfirmation(proposal(), "NO", OPTS)).toEqual({ action: "cancelled" });
    expect(decideConfirmation(proposal(), "cancel", OPTS)).toEqual({ action: "cancelled" });
  });

  it("STOP -> stop", () => {
    expect(decideConfirmation(proposal(), "STOP", OPTS)).toEqual({ action: "stop" });
  });

  it("wrong PIN -> bad_pin with decreasing budget, then locked", () => {
    let p = proposal({ attempts: 0 });
    const d1 = decideConfirmation(p, "YES 0000", OPTS);
    expect(d1).toMatchObject({ action: "bad_pin", attemptsLeft: 2 });
    if (d1.action === "bad_pin") p = d1.proposal;

    const d2 = decideConfirmation(p, "YES 1111", OPTS);
    expect(d2).toMatchObject({ action: "bad_pin", attemptsLeft: 1 });
    if (d2.action === "bad_pin") p = d2.proposal;

    const d3 = decideConfirmation(p, "YES 2222", OPTS);
    expect(d3).toEqual({ action: "locked" });
  });

  it("unrecognised text while pending -> reprompt (or expired if stale)", () => {
    expect(decideConfirmation(proposal(), "buy more", OPTS)).toEqual({ action: "reprompt" });
    expect(
      decideConfirmation(proposal(), "buy more", { now: T0 + 300_001, maxAttempts: 3 }),
    ).toEqual({ action: "expired" });
  });

  it("does NOT create a second proposal on a new trade-like request", () => {
    // "put $5 into ETH" is unrecognised confirmation input -> reprompt, not a new proposal.
    expect(decideConfirmation(proposal(), "put $5 into ETH", OPTS)).toEqual({ action: "reprompt" });
  });
});
