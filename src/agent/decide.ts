/**
 * Pure decision logic for the two deterministic paths of the TraderAgent state
 * machine: onboarding (UNREGISTERED / AWAITING_BINANCE_AUTH) and order
 * confirmation (AWAITING_CONFIRMATION). No `null` from a model ever reaches
 * these — they only see literal SMS text and stored state.
 *
 * The Durable Object owns storage, the MCP connection, SMS sending and the
 * IDLE-state model loop; it calls these to know *what* to do. `smoke-statemachine`
 * drives every branch here with a fake clock.
 */

import {
  isExpired,
  parseConfirmation,
  verifyPin,
  type Proposal,
} from "../trade/proposals.ts";

export type FsmState =
  | "UNREGISTERED"
  | "AWAITING_BINANCE_AUTH"
  | "IDLE"
  | "AWAITING_CONFIRMATION"
  | "EXECUTING";

export type AccessLevel = "read-only" | "full";

// ─────────────────────────────  onboarding  ──────────────────────────────────

export type OnboardingDecision =
  | { action: "welcome" }
  | { action: "issue_code" } // caller mints a code, stores it, sends the /connect link
  | { action: "resend_code" }
  | { action: "reset" }
  | { action: "must_finish" } // "finish connecting first: <link>"
  | { action: "ignore" };

const RESET_WORDS = new Set(["RESET", "DISCONNECT", "LOGOUT"]);
const CONNECT_WORDS = new Set(["CONNECT", "LINK", "GO"]);

/**
 * Two-step onboarding: the first message (START, "hi", anything) gets the
 * welcome, which asks the user to reply CONNECT. Only CONNECT issues the link.
 * A brand-new number never receives a URL it didn't ask for.
 */
export function decideOnboarding(state: FsmState, body: string): OnboardingDecision {
  const t = body.trim().toUpperCase();

  if (RESET_WORDS.has(t)) return { action: "reset" };

  if (state === "UNREGISTERED") {
    return CONNECT_WORDS.has(t) ? { action: "issue_code" } : { action: "welcome" };
  }

  if (state === "AWAITING_BINANCE_AUTH") {
    return CONNECT_WORDS.has(t) ? { action: "resend_code" } : { action: "must_finish" };
  }

  return { action: "ignore" };
}

// ───────────────────────────  confirmation  ──────────────────────────────────

export type ConfirmationDecision =
  | { action: "execute"; proposal: Proposal } // caller re-checks slippage + policy, then places
  | { action: "cancelled" } // NO / CANCEL
  | { action: "stop" } // STOP — discard proposal AND cancel open orders
  | { action: "expired" }
  | { action: "bad_pin"; proposal: Proposal; attemptsLeft: number }
  | { action: "locked" }
  | { action: "reprompt" }; // unrecognised text while a proposal is pending

export function decideConfirmation(
  proposal: Proposal,
  body: string,
  opts: { now: number; maxAttempts: number },
): ConfirmationDecision {
  const parsed = parseConfirmation(body);

  if (parsed.kind === "stop") return { action: "stop" };
  if (parsed.kind === "no") return { action: "cancelled" };
  if (parsed.kind === "other") {
    // An expired proposal blocking new input should clear itself.
    return isExpired(proposal, opts.now) ? { action: "expired" } : { action: "reprompt" };
  }

  // parsed.kind === "yes"
  const v = verifyPin(proposal, parsed.pin, opts);
  switch (v.status) {
    case "OK":
      return { action: "execute", proposal };
    case "EXPIRED":
      return { action: "expired" };
    case "LOCKED":
      return { action: "locked" };
    case "BAD_PIN":
      return { action: "bad_pin", proposal: v.proposal, attemptsLeft: v.attemptsLeft };
  }
}

// ─────────────────────────────  copy  ────────────────────────────────────────
// Centralised so the smoke test and the DO assert/send the same strings.

// All ASCII on purpose: non-GSM-7 characters force UCS-2 SMS encoding, which
// halves the per-segment length and can cost more.
export const MSG = {
  welcome:
    "Welcome to BinaText! Trade your Binance sub-account by SMS - any phone, no app. " +
    "Reply CONNECT to link your account. You authorise on Binance's own web page; " +
    "we never see your keys and cannot withdraw.",
  connectLink: (url: string) =>
    `Open this in a browser to connect Binance:\n${url}\nPick Read-only to try it with no deposit.`,
  mustFinish: (url: string) => `Finish connecting first:\n${url}`,
  reset: "Disconnected. Your tokens, alerts and any pending order are cleared. Reply START to reconnect.",
  connected: (level: AccessLevel) =>
    level === "read-only"
      ? "Connected (read-only). Try: what is BTC doing? / how am I positioned? / put $5 into BNB"
      : "Connected. Try: what is BTC doing? / how am I positioned? / put $5 into BNB",
  cancelled: "Cancelled. No order placed.",
  stopped: "Stopped - pending order discarded and open orders cancelled.",
  expired: "That confirmation expired. Send the request again.",
  badPin: (left: number) => `PIN incorrect. ${left} ${left === 1 ? "try" : "tries"} left - reply YES <PIN>.`,
  locked: "Too many wrong PINs. Proposal discarded - send the request again.",
  reprompt: (pin: string) => `You have a pending order (PIN ${pin}). Reply YES ${pin} to confirm, or NO to cancel.`,
  authExpired: (url: string) => `Your Binance session expired. Reconnect:\n${url}`,
  busy: "Working on your last order - one moment.",
  readOnlyStub: (restated: string) =>
    `Read-only mode - would place: ${restated}. Connect with Full access to trade for real.`,
} as const;
