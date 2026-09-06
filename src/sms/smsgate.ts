/**
 * SMS Gateway for Android (sms-gate.app / capcom6/android-sms-gateway) — the
 * primary SMS path.
 *
 * An open-source app runs on any Android phone with any SIM (a Nigerian MTN /
 * Airtel / Glo / 9mobile line is fine) and relays SMS through it. The free cloud
 * server (`api.sms-gate.app`) pushes inbound messages to our webhook and takes
 * an HTTP call to send. No BD/region tie-in, no per-message fee beyond the SIM's
 * normal SMS allowance.
 *
 * ⚠️ Wire details below are best-effort — `npm run spike:smsgate` captures the
 * real inbound payload + signature scheme; patch the `SPIKE:` markers after.
 */

import type { Env } from "../shared/env.ts";
import { BadSignatureError, timingSafeEqual, type InboundSms, type SmsProvider } from "./provider.ts";
import { normalizeE164 } from "../shared/phone.ts";

const API_BASE = "https://api.sms-gate.app/3rdparty/v1";

// SPIKE: confirm shape. Docs describe `sms:received` with a nested `payload`.
interface SmsGateWebhook {
  event?: string;
  deviceId?: string;
  payload?: {
    messageId?: string;
    message?: string;
    phoneNumber?: string; // sender
    receivedAt?: string;
  };
}

export const smsgateProvider: SmsProvider = {
  name: "smsgate",

  async verifyAndParse(req, env): Promise<InboundSms | null> {
    const raw = await req.text();

    // SPIKE: sms-gate.app signs webhooks as HMAC-SHA256 with headers X-Signature
    // (hex) and X-Timestamp. Confirm whether the signed value is `${timestamp}`
    // + raw body, or the raw body alone.
    if (env.SMSGATE_WEBHOOK_SECRET) {
      const sig = req.headers.get("x-signature");
      const ts = req.headers.get("x-timestamp") ?? "";
      if (!sig || !(await validSig(env.SMSGATE_WEBHOOK_SECRET, ts + raw, sig))) {
        throw new BadSignatureError("sms-gate webhook signature mismatch");
      }
    }

    let data: SmsGateWebhook;
    try {
      data = JSON.parse(raw) as SmsGateWebhook;
    } catch {
      return null;
    }
    if (data.event && data.event !== "sms:received") return null;

    const sender = data.payload?.phoneNumber;
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
    const { SMSGATE_USERNAME: user, SMSGATE_PASSWORD: pass } = env;
    if (!user || !pass) {
      console.warn(`[smsgate] send skipped (no creds): "${body.slice(0, 60)}"`);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/messages`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${user}:${pass}`)}`,
          "content-type": "application/json",
        },
        // SPIKE: confirm field names — docs show `message` + `phoneNumbers`.
        body: JSON.stringify({ message: body, phoneNumbers: [to] }),
      });
      if (!res.ok) {
        console.error(`[smsgate] send ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[smsgate] send threw: ${(err as Error).message}`);
    }
  },

  ackResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  },
};

/** HMAC-SHA256 hex of `data` with `secret`, constant-time compared to `sig`. */
async function validSig(secret: string, data: string, sig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const want = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(want, sig.trim().toLowerCase());
}
