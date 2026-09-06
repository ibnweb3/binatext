/**
 * SMS provider interface. The agent logic never imports a concrete provider —
 * it takes an `SmsProvider`, so textbee (primary) and Twilio (fallback) are a
 * one-line swap via `SMS_PROVIDER`.
 */

import type { Env } from "../shared/env.ts";
import { textbeeProvider } from "./textbee.ts";
import { twilioProvider } from "./twilio.ts";

export interface InboundSms {
  /** Sender, E.164. */
  from: string;
  /** Message text, trimmed by the provider adapter of provider-added prefixes. */
  body: string;
  /** Provider message id — used for inbound de-duplication (providers retry). */
  msgId: string;
}

/** Thrown when a signature header is present but doesn't verify — caller responds 403. */
export class BadSignatureError extends Error {}

export interface SmsProvider {
  readonly name: string;

  /**
   * Verify the webhook signature and parse it. Throws `BadSignatureError` on a
   * present-but-invalid signature (caller → 403). Returns `null` when the
   * payload isn't an inbound message we act on (caller → 2xx, ignore).
   */
  verifyAndParse(req: Request, env: Env): Promise<InboundSms | null>;

  /** Send a message. Best-effort: logs and swallows provider errors so one failed send can't wedge the DO. */
  send(to: string, body: string, env: Env): Promise<void>;

  /** The body to return to the provider's webhook POST. */
  ackResponse(): Response;
}

export function getSmsProvider(env: Env): SmsProvider {
  return env.SMS_PROVIDER === "twilio" ? twilioProvider : textbeeProvider;
}

/** HMAC-SHA256 hex of `body` with `secret`, constant-time compared to `sig`. */
export async function hmacSha256HexEquals(secret: string, body: string, sig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const want = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(want, sig.trim().toLowerCase());
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
