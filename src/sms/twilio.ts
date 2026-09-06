/**
 * Twilio adapter — fallback SMS path (`SMS_PROVIDER=twilio`).
 *
 * Trial accounts send only to *verified* numbers and prepend "Sent from your
 * Twilio trial account"; fine for a demo, a blocker for open judging (would need
 * a small paid balance). Inbound webhooks are form-encoded and signed with
 * X-Twilio-Signature.
 */

import type { Env } from "../shared/env.ts";
import { BadSignatureError, timingSafeEqual, type InboundSms, type SmsProvider } from "./provider.ts";
import { normalizeE164 } from "../shared/phone.ts";

const TRIAL_PREFIX = /^Sent from your Twilio trial account - /;

/** X-Twilio-Signature = base64( HMAC-SHA1( url + concat(sorted k+v), authToken ) ). */
async function validSignature(url: string, params: URLSearchParams, authToken: string, sig: string): Promise<boolean> {
  const keys = [...params.keys()].sort();
  let data = url;
  for (const k of keys) data += k + params.get(k);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const want = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(want, sig);
}

export const twilioProvider: SmsProvider = {
  name: "twilio",

  async verifyAndParse(req, env): Promise<InboundSms | null> {
    if (!env.TWILIO_AUTH_TOKEN) return null;
    const raw = await req.text();
    const params = new URLSearchParams(raw);

    const sig = req.headers.get("x-twilio-signature");
    // Twilio signs the exact public URL it POSTed to. PUBLIC_HOST must match.
    const url = `https://${env.PUBLIC_HOST}/sms/twilio`;
    if (!sig || !(await validSignature(url, params, env.TWILIO_AUTH_TOKEN, sig))) {
      throw new BadSignatureError("X-Twilio-Signature mismatch");
    }

    const from = params.get("From");
    const body = params.get("Body");
    const msgId = params.get("MessageSid");
    if (!from || body === null || !msgId) return null;

    try {
      return { from: normalizeE164(from), body: body.replace(TRIAL_PREFIX, "").trim(), msgId };
    } catch {
      return null;
    }
  },

  async send(to, body, env): Promise<void> {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = env;
    if (!sid || !token || !from) {
      console.warn(`[twilio] send skipped (no creds): "${body.slice(0, 60)}"`);
      return;
    }
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${sid}:${token}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      });
      if (!res.ok) {
        console.error(`[twilio] send ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[twilio] send threw: ${(err as Error).message}`);
    }
  },

  ackResponse(): Response {
    return new Response("<Response></Response>", { headers: { "content-type": "text/xml" } });
  },
};
