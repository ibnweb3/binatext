#!/usr/bin/env node
/**
 * BinaText local bridge.
 *
 * Binance Agent OS OAuth only accepts allowlisted host clients (Claude Code,
 * ChatGPT, VS Code, …). A standalone Worker can't complete consent — so the
 * Worker enqueues Binance operations and THIS script, running on the operator's
 * machine where `claude` is signed in to Binance Agent OS, executes each one as a
 * tightly-constrained `claude -p` call and posts the result back.
 *
 * The Worker still owns every safety decision (policy guard, daily cap, PIN).
 * This bridge only ever runs the single operation it is handed.
 *
 * Setup (once):
 *   claude mcp add binance-agentos --transport http https://agent.binance.com/mcp/agentic
 *   claude   ->   /mcp   ->   authenticate binance-agentos
 *
 * Run:
 *   BRIDGE_SECRET=xxxxx node bridge/run.mjs
 *
 * Env:
 *   BRIDGE_SECRET   (required)  shared secret, also set as a Worker secret
 *   BINATEXT_URL    default https://binatext.ibnweb3lab.workers.dev
 *   CLAUDE_BIN      default "claude"
 *   MCP_SERVER      default "binance-agentos"
 */

import { spawn } from "node:child_process";

const BASE = (process.env.BINATEXT_URL || "https://binatext.ibnweb3lab.workers.dev").replace(/\/$/, "");
const SECRET = process.env.BRIDGE_SECRET;
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const SERVER = process.env.MCP_SERVER || "binance-agentos";
const POLL_MS = 1500;

if (!SECRET) {
  console.error("BRIDGE_SECRET is required. Set it to the same value as the Worker secret.");
  process.exit(1);
}

const T = (name) => `mcp__${SERVER}__${name}`;

/** op -> { tools: [allowed tool names], prompt(args) } */
const OPS = {
  ticker: {
    tools: [T("spot_tickerPrice")],
    prompt: (a) =>
      `Call ${T("spot_tickerPrice")} with symbol "${a.symbol}". ` +
      `Reply with ONLY the price as a bare decimal number, nothing else.`,
  },
  balances: {
    tools: [T("spot_getAccount")],
    prompt: () =>
      `Call ${T("spot_getAccount")}. From the "balances" array, keep only entries where ` +
      `free (as a number) > 0. Reply with ONLY a compact JSON array of {"asset","free"} objects, no prose, no code fences.`,
  },
  open_orders: {
    tools: [T("spot_getOpenOrders")],
    prompt: (a) =>
      `Call ${T("spot_getOpenOrders")}${a.symbol ? ` with symbol "${a.symbol}"` : ""}. ` +
      `Reply with ONLY the raw JSON array the tool returns, no prose, no code fences.`,
  },
  cancel_all: {
    tools: [T("spot_deleteOpenOrders")],
    prompt: (a) =>
      `Call ${T("spot_deleteOpenOrders")} with symbol "${a.symbol}". ` +
      `Reply with ONLY the raw JSON the tool returns, no prose, no code fences.`,
  },
  place_order: {
    tools: [T("spot_newOrder")],
    prompt: (a) => {
      const params = Object.entries(a)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      return (
        `Call ${T("spot_newOrder")} with EXACTLY these parameters and no others: ${params}. ` +
        `Do not call any other tool. Do not modify any value. ` +
        `Reply with ONLY the raw JSON the tool returns, no prose, no code fences.`
      );
    },
  },
};

function runClaude(prompt, tools) {
  // Prompt goes on stdin (spaces/quotes safe); every CLI arg below is space-free
  // so `shell: true` — needed on Windows to resolve `claude` -> `claude.cmd` — is safe.
  const args = [
    "-p",
    "--output-format",
    "json",
    "--allowedTools",
    tools.join(","),
    "--model",
    process.env.BRIDGE_MODEL || "haiku",
    "--max-turns",
    "6",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, {
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const killer = setTimeout(() => child.kill(), 100_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(new Error(`spawn ${CLAUDE}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0 && !out.trim()) {
        return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`));
      }
      let env;
      try {
        env = JSON.parse(out);
      } catch {
        return reject(new Error(`claude did not return JSON: ${out.slice(0, 300)}`));
      }
      if (env.is_error || env.subtype === "error_max_turns") {
        return reject(new Error(`claude error: ${env.result || env.subtype}`));
      }
      resolve(String(env.result ?? "").trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseResult(op, text) {
  if (op === "ticker") {
    const m = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (!m) throw new Error(`no number in ticker reply: ${text.slice(0, 120)}`);
    return { price: Number(m[0]) };
  }
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    // last resort: pull the first {...} or [...] block
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return { raw: text.slice(0, 800) };
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": SECRET },
    body: JSON.stringify(body),
  });
  return res;
}

async function pollOnce() {
  const res = await fetch(`${BASE}/bridge/poll`, {
    method: "POST",
    headers: { "x-bridge-secret": SECRET },
  });
  if (res.status === 204) return false;
  if (!res.ok) {
    console.error(`poll -> ${res.status} ${await res.text().catch(() => "")}`);
    return false;
  }
  const job = await res.json();
  const args = job.args ? JSON.parse(job.args) : {};
  console.log(`→ ${job.op} ${JSON.stringify(args)}`);

  const spec = OPS[job.op];
  if (!spec) {
    await post("/bridge/result", { id: job.id, status: "error", error: `unknown op ${job.op}` });
    return true;
  }

  try {
    const text = await runClaude(spec.prompt(args), spec.tools);
    const data = parseResult(job.op, text);
    await post("/bridge/result", { id: job.id, status: "done", data });
    console.log(`  ✓ ${JSON.stringify(data).slice(0, 160)}`);
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 400);
    await post("/bridge/result", { id: job.id, status: "error", error: msg });
    console.error(`  ✗ ${msg}`);
  }
  return true;
}

console.log(`BinaText bridge -> ${BASE}  (server: ${SERVER})`);
console.log("Polling for jobs. Keep this running during the demo. Ctrl+C to stop.\n");

// eslint-disable-next-line no-constant-condition
while (true) {
  let hadWork = false;
  try {
    hadWork = await pollOnce();
  } catch (err) {
    console.error(`loop error: ${err?.message ?? err}`);
  }
  if (!hadWork) await new Promise((r) => setTimeout(r, POLL_MS));
}
