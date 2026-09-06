/**
 * LLM provider abstraction. Groq free tier is the default; if it's rate-limited
 * (per-key RPD/TPM — a burst of judges can exhaust a day) the loop falls through
 * to the next entry: another Groq model, then Workers AI (also $0), then
 * Anthropic Haiku (~$1 total, last resort).
 *
 * Shaped after `Bot Chain/agent/src/llm.js` (swappable adapters, identical
 * return) and `OKX Build/src/shared/groq.ts` (per-model fallback because free
 * quotas are enforced per model).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { Env } from "../shared/env.ts";

export type ProviderName = "groq" | "workers-ai" | "anthropic";

export interface ModelSpec {
  provider: ProviderName;
  modelId: string;
}

/** Primary (MODEL_PROVIDER/MODEL_ID) followed by the MODEL_FALLBACKS chain. */
export function resolveModelChain(env: Env): ModelSpec[] {
  const chain: ModelSpec[] = [
    { provider: env.MODEL_PROVIDER as ProviderName, modelId: env.MODEL_ID },
  ];
  for (const entry of env.MODEL_FALLBACKS.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(":");
    if (idx < 0) continue;
    const provider = entry.slice(0, idx) as ProviderName;
    const modelId = entry.slice(idx + 1);
    if (provider && modelId) chain.push({ provider, modelId });
  }
  // Drop entries we can't authenticate.
  return chain.filter((s) => {
    if (s.provider === "groq") return !!env.GROQ_API_KEY;
    if (s.provider === "anthropic") return !!env.ANTHROPIC_API_KEY;
    return true; // workers-ai uses the AI binding
  });
}

export function makeModel(spec: ModelSpec, env: Env): LanguageModel {
  switch (spec.provider) {
    case "groq":
      return createGroq({ apiKey: env.GROQ_API_KEY! })(spec.modelId);
    case "anthropic":
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY! })(spec.modelId);
    case "workers-ai":
      return createWorkersAI({ binding: env.AI })(spec.modelId);
  }
}

/** True when retrying the same request against another model could plausibly help. */
export function isRetryableModelError(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  return /rate.?limit|quota|overloaded|timeout|capacity/.test(msg);
}
