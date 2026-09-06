/**
 * textbee.dev adapter — the primary SMS path.
 *
 * textbee runs an app on an Android phone with a SIM; its cloud relay POSTs
 * inbound SMS to our webhook and exposes an HTTP API to send. Free tier: 50/day,
 * 300/month, real SMS with no trial prefix.
 *
 * ⚠️ The exact request/response shapes below are best-effort from the docs and
 * MUST be confirmed by `npm run spike:textbee` before relying on them — search
 * for `SPIKE:` markers and adjust.
 */

import type { Env } from "../shared/env.ts";
import { BadSignatureError, hmacSha256HexEquals, type InboundSms, type SmsProvider } from "./provider.ts";
import { normalizeE164 } from "../shared/phone.ts";

const API_BASE = "https://api.textbee.dev/api/v1";

// SPIKE: confirm the inbound webhook JSON shape. Docs describe an `sms:received`
// event with a `payload` object holding `message`/`sender`/`messageId`.
interface TextbeeWebhook {
  event?: string;
  payload?: {
    messageId?: string;
    message?: string;
    sender?: string;
    receivedAt?: string;
  };
}

export const textbeeProvider: SmsProvider = {
  name: "textbee",

  async verifyAndParse(req, env): Promise<InboundSms | null> {
    const raw = await req.text();

    // SPIKE: confirm the signature header name + algorithm. textbee lets you set
    // a webhook secret; we assume it signs the raw body as HMAC-SHA256 hex.
    const sig = req.headers.get("x-signature") ?? req.headers.get("x-textbee-signature");
    if (env.TEXTBEE_WEBHOOK_SECRET) {
      if (!sig || !(await hmacSha256HexEquals(env.TEXTBEE_WEBHOOK_SECRET, raw, sig))) {
        throw new BadSignatureError("textbee webhook signature mismatch");
      }
    }

    let data: TextbeeWebhook;
    try {
      data = JSON.parse(raw) as TextbeeWebhook;
    } catch {
      return null;
    }
    if (data.event && data.event !== "sms:received") return null; // delivery reports etc.

    const sender = data.payload?.sender;
    const message = data.payload?.message;
    const messageId = data.payload?.messageId;
    if (!sender || message === undefined || !messageId) return null;

    try {
      return { from: normalizeE164(sender), body: message.trim(), msgId: messageId };
    } catch {
      return null;
    }
  },

  async send(to, body, env): Promise<void> {
    if (!env.TEXTBEE_API_KEY || !env.TEXTBEE_DEVICE_ID) {
      console.warn(`[textbee] send skipped (no creds): "${body.slice(0, 60)}"`);
      return;
    }
    try {
      // SPIKE: confirm path + body. Docs: POST /gateway/devices/{id}/send-sms
      const res = await fetch(`${API_BASE}/gateway/devices/${env.TEXTBEE_DEVICE_ID}/send-sms`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.TEXTBEE_API_KEY },
        body: JSON.stringify({ recipients: [to], message: body }),
      });
      if (!res.ok) {
        console.error(`[textbee] send ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[textbee] send threw: ${(err as Error).message}`);
    }
  },

  ackResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  },
};
