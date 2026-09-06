/**
 * Phone-number handling. The raw E.164 number is the user's identity, but we
 * never use it as a Durable Object name or put it in logs — we key everything
 * off a SHA-256 hash so a leaked audit log or DO id list doesn't expose who
 * uses BinaText.
 */

export class BadPhoneNumberError extends Error {}

/**
 * Normalize to strict E.164 (`+` followed by 8–15 digits, no leading zero).
 * Both sms-gate.app and Twilio deliver numbers in or very near this form; we just
 * tidy separators and reject anything that isn't plausibly a real number.
 */
export function normalizeE164(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  const e164 = `+${digits}`;
  if (!hasPlus || !/^\+[1-9]\d{7,14}$/.test(e164)) {
    throw new BadPhoneNumberError(`"${raw}" is not a valid E.164 phone number`);
  }
  return e164;
}

/** Stable, opaque DO instance name for a phone number. */
export async function phoneHash(e164: string): Promise<string> {
  const data = new TextEncoder().encode(`binatext:${e164}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** For log lines: last 4 digits only, e.g. "+234••••1234". */
export function maskPhone(e164: string): string {
  return e164.length <= 4 ? "••••" : `${e164.slice(0, 4)}••••${e164.slice(-4)}`;
}
