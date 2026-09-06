/**
 * One conversational turn: run `generateText` with the read-only MCP tools plus
 * BinaText's local tools, walking the model fallback chain on rate-limit / 5xx.
 *
 * The model is never handed an order-placement tool. The most it can do about a
 * trade is call `propose_trade`, which runs the deterministic guard and, if that
 * passes, sends the user a restatement + PIN. Execution happens in the DO only
 * after `YES <PIN>`.
 */

import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { Env } from "../shared/env.ts";
import { isRetryableModelError, makeModel, resolveModelChain, type ModelSpec } from "./provider.ts";

export const SYSTEM_PROMPT = `You are BinaText, a trading assistant the user talks to entirely over SMS.

Rules:
- Keep replies under ~300 characters. No markdown, no bullet lists — plain sentences a phone shows well.
- For prices, balances, order books: call the Binance tools. Never guess a number.
- When the user wants to buy or sell, call propose_trade. Do NOT try to place, cancel, or confirm orders yourself — you have no tool for that. propose_trade sends the user a confirmation with a PIN; the system handles the rest.
- Quote amounts are in USD unless the user clearly means a coin quantity.
- If a tool returns an error or a policy rejection, relay it to the user plainly.
- Never give financial advice or predictions. Report data; let the user decide.`;

export interface AgentTurnResult {
  text: string;
  /** True if any tool was called this turn (so the DO knows a proposal/alert may already have been sent). */
  usedTool: boolean;
  modelUsed: ModelSpec;
}

export async function runAgentTurn(opts: {
  env: Env;
  messages: ModelMessage[];
  tools: ToolSet;
  maxSteps?: number;
}): Promise<AgentTurnResult> {
  const chain = resolveModelChain(opts.env);
  if (chain.length === 0) {
    return {
      text: "I can't reach my language model right now (no API key configured). Try again shortly.",
      usedTool: false,
      modelUsed: { provider: "groq", modelId: "none" },
    };
  }

  let lastErr: unknown;
  for (const spec of chain) {
    try {
      const res = await generateText({
        model: makeModel(spec, opts.env),
        system: SYSTEM_PROMPT,
        messages: opts.messages,
        tools: opts.tools,
        stopWhen: stepCountIs(opts.maxSteps ?? 6),
      });
      const usedTool = res.steps.some((s) => s.toolCalls.length > 0);
      return { text: res.text.trim(), usedTool, modelUsed: spec };
    } catch (err) {
      lastErr = err;
      if (!isRetryableModelError(err)) throw err;
      console.warn(`[model] ${spec.provider}:${spec.modelId} failed (${(err as Error).message}); trying next.`);
    }
  }

  console.error(`[model] whole chain exhausted: ${(lastErr as Error)?.message}`);
  return {
    text: "My language model is rate-limited right now. Give it a minute and resend.",
    usedTool: false,
    modelUsed: chain[chain.length - 1]!,
  };
}
