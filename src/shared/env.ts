/**
 * Typed view of the Worker environment, plus a startup readiness check.
 *
 * House rule (from the sibling projects): a feature auto-disables and prints a
 * WARNING when its secret group is missing, so the Worker always boots and you
 * can develop one slice at a time.
 */

import type { Ai } from "@cloudflare/workers-types";
import type { TraderAgent } from "../agent.ts";
import type { AlertRegistry } from "../registry.ts";

export interface Env {
  // Bindings
  TraderAgent: DurableObjectNamespace<TraderAgent>;
  AlertRegistry: DurableObjectNamespace<AlertRegistry>;
  AI: Ai;

  // vars (wrangler.jsonc)
  BINANCE_MCP_URL: string;
  MODEL_PROVIDER: string;
  MODEL_ID: string;
  MODEL_FALLBACKS: string;
  SMS_PROVIDER: "smsgate" | "twilio";
  MAX_ORDER_USD: string;
  DAILY_USD_CAP: string;
  ALLOWED_SYMBOLS: string;
  PROPOSAL_TTL_SECONDS: string;
  MAX_PIN_ATTEMPTS: string;
  SLIPPAGE_ABORT_PCT: string;
  ONBOARD_CODE_TTL_SECONDS: string;
  NEW_NUMBERS_PER_HOUR: string;
  PUBLIC_HOST: string;

  // secrets (may be undefined)
  GROQ_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  SMSGATE_USERNAME?: string;
  SMSGATE_PASSWORD?: string;
  SMSGATE_WEBHOOK_SECRET?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  OPERATOR_NUMBERS?: string;
  SETUP_SECRET?: string;

  /** E.164 SIM number(s) of the SMS gateway phone, comma-separated — inbound from these is dropped (echo guard). Secret. */
  GATEWAY_NUMBERS?: string;

  /** "1" -> log raw inbound SMS webhook headers/body (spike only; unset in prod). */
  SMS_DEBUG?: string;

  /**
   * Shared secret for the local Binance bridge (bridge/run.mjs). The bridge polls
   * /bridge/poll and posts to /bridge/result with this in the x-bridge-secret
   * header. When set, BinaText reaches Binance Agent OS through the operator's
   * authenticated Claude Code session instead of its own (allowlist-blocked) OAuth.
   */
  BRIDGE_SECRET?: string;
}

export interface Readiness {
  model: boolean;
  sms: boolean;
  operator: boolean;
  warnings: string[];
}

/** Call once at the top of `fetch` / `scheduled`. Logs what's disabled; never throws. */
export function checkReadiness(env: Env): Readiness {
  const warnings: string[] = [];

  const model =
    env.MODEL_PROVIDER === "workers-ai" ||
    (env.MODEL_PROVIDER === "groq" && !!env.GROQ_API_KEY) ||
    (env.MODEL_PROVIDER === "anthropic" && !!env.ANTHROPIC_API_KEY);
  if (!model) warnings.push(`model: MODEL_PROVIDER=${env.MODEL_PROVIDER} but its API key is unset — the agent cannot reason.`);

  const sms =
    env.SMS_PROVIDER === "smsgate"
      ? !!(env.SMSGATE_USERNAME && env.SMSGATE_PASSWORD)
      : !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
  if (!sms) warnings.push(`sms: SMS_PROVIDER=${env.SMS_PROVIDER} but its credentials are incomplete — inbound parses, outbound is a no-op.`);

  const operator = !!(env.OPERATOR_NUMBERS && env.SETUP_SECRET);
  if (!operator) warnings.push("operator: OPERATOR_NUMBERS / SETUP_SECRET unset — GET /setup is disabled (users still onboard via the texted code).");

  for (const w of warnings) console.warn(`[binatext] ${w}`);
  return { model, sms, operator, warnings };
}

export function operatorNumbers(env: Env): Set<string> {
  return new Set(
    (env.OPERATOR_NUMBERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function int(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function float(raw: string, fallback: number): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
