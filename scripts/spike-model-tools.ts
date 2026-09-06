/**
 * Phase 0 spike — model tool-calling reliability.
 *
 * Runs the 5 demo intents through the model N times each and reports how often
 * it picks the right tool with sane args. Gate: >= 9/10 on every intent, else
 * try the next model (or fall back to regex intent parsing — see the plan).
 *
 *   GROQ_API_KEY=... npx tsx scripts/spike-model-tools.ts [modelId] [runs]
 *
 * Default model: openai/gpt-oss-120b (LOCKED 2026-09-06 — Groq dropped Llama 3.3
 * 70B from the free lineup; gpt-oss-120b scored 49/50). Try also: qwen/qwen3.8-27b.
 * (STOP is handled deterministically in the DO, so it isn't a model test.)
 *
 * NOTE for the real tool schemas in agent.ts: gpt-oss emits `null` for omitted
 * optional params (`baseQty: null`), which fails a plain `z.number().optional()`.
 * Use `.nullish()` (or `.nullable().optional()`) and coalesce null -> undefined.
 */

import { createGroq } from "@ai-sdk/groq";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

const MODEL_ID = process.argv[2] ?? "openai/gpt-oss-120b";
const RUNS = Number(process.argv[3] ?? 10);

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("Set GROQ_API_KEY (https://console.groq.com/keys).");
  process.exit(1);
}
const groq = createGroq({ apiKey });

const calls: string[] = [];
const record = (name: string) => (args: unknown) => {
  calls.push(name);
  return `ok:${name}:${JSON.stringify(args)}`;
};

const tools = {
  get_ticker: tool({
    description: "Current price and 24h change for a symbol.",
    inputSchema: z.object({ symbol: z.string() }),
    execute: record("get_ticker"),
  }),
  get_balances: tool({
    description: "The user's Agentic sub-account balances.",
    inputSchema: z.object({}),
    execute: record("get_balances"),
  }),
  propose_trade: tool({
    description: "Propose a spot buy or sell for the user to confirm with a PIN.",
    inputSchema: z.object({
      symbol: z.string(),
      side: z.enum(["BUY", "SELL"]),
      quoteAmountUsd: z.number().optional(),
      baseQty: z.number().optional(),
    }),
    execute: record("propose_trade"),
  }),
  set_price_alert: tool({
    description: "Notify the user by SMS when a symbol crosses a price.",
    inputSchema: z.object({
      symbol: z.string(),
      direction: z.enum(["below", "above"]),
      threshold: z.number(),
    }),
    execute: record("set_price_alert"),
  }),
  list_alerts: tool({
    description: "List the user's active price alerts.",
    inputSchema: z.object({}),
    execute: record("list_alerts"),
  }),
} as const;

const SYSTEM =
  "You are BinaText, an SMS trading assistant. Use a tool for anything involving live data, " +
  "balances, trades, or alerts. Quote amounts are USD unless a coin quantity is clearly meant.";

const CASES: Array<{ intent: string; prompt: string; want: string }> = [
  { intent: "market Q&A", prompt: "what's BTC doing?", want: "get_ticker" },
  { intent: "portfolio", prompt: "how am I positioned?", want: "get_balances" },
  { intent: "NL order", prompt: "put $5 into BNB", want: "propose_trade" },
  { intent: "set alert", prompt: "alert me if SOL drops under 140", want: "set_price_alert" },
  { intent: "list alerts", prompt: "what alerts do I have?", want: "list_alerts" },
];

const run = async () => {
  console.log(`model=${MODEL_ID}  runs=${RUNS}\n`);
  let allPass = true;

  for (const c of CASES) {
    let hit = 0;
    const seen: Record<string, number> = {};
    for (let i = 0; i < RUNS; i++) {
      calls.length = 0;
      try {
        await generateText({
          model: groq(MODEL_ID),
          system: SYSTEM,
          prompt: c.prompt,
          tools,
          stopWhen: stepCountIs(3),
        });
      } catch (err) {
        console.log(`  ! ${(err as Error).message}`);
      }
      const first = calls[0] ?? "(none)";
      seen[first] = (seen[first] ?? 0) + 1;
      if (first === c.want) hit++;
    }
    const pass = hit >= Math.ceil(RUNS * 0.9);
    allPass &&= pass;
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${c.intent.padEnd(12)} ${hit}/${RUNS} -> ${c.want}` +
        `   picks: ${JSON.stringify(seen)}`,
    );
  }

  console.log(`\n${allPass ? "✅ model is good enough" : "❌ try another model or regex intent parsing"}`);
  process.exit(allPass ? 0 : 1);
};

run();
