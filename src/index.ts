/**
 * Worker entry. Routes:
 *   POST /sms/smsgate | /sms/twilio    inbound SMS webhook
 *   GET  /connect?p=&c=[&level=]      user onboarding -> Binance OAuth
 *   GET  /setup?phone=&s=             operator OAuth bootstrap
 *   ANY  /agents/*                    agents SDK (MCP OAuth callback, etc.)
 *   GET  /                            landing
 */

import { getAgentByName, routeAgentRequest } from "agents";
import { checkReadiness, operatorNumbers, type Env } from "./shared/env.ts";
import { BadSignatureError, getSmsProvider } from "./sms/provider.ts";
import { BadPhoneNumberError, normalizeE164, phoneHash } from "./shared/phone.ts";
import type { AccessLevel } from "./agent/decide.ts";
import { TraderAgent } from "./agent.ts";
import { AlertRegistry } from "./registry.ts";
import { landingPage } from "./landing.ts";
import { scheduled } from "./scheduled.ts";

export { TraderAgent, AlertRegistry };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    checkReadiness(env);
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/sms/smsgate" || path === "/sms/twilio") return await handleSms(request, env, ctx);
      if (path === "/connect") return await handleConnect(request, env);
      if (path === "/setup") return await handleSetup(request, env);
      if (path === "/debug/mcp") return await handleDebugMcp(request, env);
      if (path.startsWith("/agents/")) {
        return (await routeAgentRequest(request, env)) ?? notFound();
      }
      if (path === "/") return landingPage();
      return notFound();
    } catch (err) {
      console.error(`[fetch] ${path}: ${(err as Error).stack ?? err}`);
      return new Response("error", { status: 500 });
    }
  },
  scheduled,
} satisfies ExportedHandler<Env>;

// ── /sms/* ───────────────────────────────────────────────────────────────────

async function handleSms(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const provider = getSmsProvider(env);

  let inbound;
  try {
    inbound = await provider.verifyAndParse(request, env);
  } catch (err) {
    if (err instanceof BadSignatureError) return new Response("bad signature", { status: 403 });
    throw err;
  }
  if (!inbound) return provider.ackResponse(); // not a message we act on

  // Echo guard: never process a message that came from the gateway's own SIM.
  const selfNums = new Set(
    (env.GATEWAY_NUMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  if (selfNums.has(inbound.from)) {
    console.warn(`[sms] dropping inbound from gateway's own number ${inbound.from}`);
    return provider.ackResponse();
  }

  const hash = await phoneHash(inbound.from);

  const registry = env.AlertRegistry.get(env.AlertRegistry.idFromName("global")) as unknown as {
    admitNumber(hash: string): boolean | Promise<boolean>;
  };
  if (!(await registry.admitNumber(hash))) {
    console.warn(`[sms] new-number rate limit hit — dropping ${inbound.msgId}`);
    return provider.ackResponse();
  }

  const agent = await getAgentByName<Env, TraderAgent>(env.TraderAgent, hash);
  ctx.waitUntil(
    agent
      .handleInboundSms(inbound.from, inbound.body, inbound.msgId)
      .catch((err) => console.error(`[sms] handleInboundSms failed: ${(err as Error).stack ?? err}`)),
  );
  return provider.ackResponse();
}

// ── /connect (user onboarding) ───────────────────────────────────────────────

async function handleConnect(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const p = url.searchParams.get("p") ?? "";
  const code = url.searchParams.get("c") ?? "";
  const level = url.searchParams.get("level");

  if (!/^[0-9a-f]{64}$/.test(p) || !/^\d{6}$/.test(code)) {
    return html("Bad link. Text START to your BinaText number for a fresh one.", 400);
  }

  // No access level chosen yet -> show the one-screen picker.
  if (level !== "read-only" && level !== "full") {
    const base = `${url.origin}/connect?p=${p}&c=${code}`;
    return html(`
      <h2>Connect Binance to BinaText</h2>
      <p>You'll authorise on Binance directly. BinaText never sees your keys, and
      no permission it can request allows withdrawing funds.</p>
      <p><a href="${base}&level=read-only"><b>Read-only</b></a> — try everything with no deposit.
      Prices, balances, and the full order + PIN flow; the final step is simulated.</p>
      <p><a href="${base}&level=full"><b>Full</b></a> — real trades. You fund your own
      Agentic sub-account; per-order and daily USD caps still apply.</p>`);
  }

  const agent = await getAgentByName<Env, TraderAgent>(env.TraderAgent, p);
  const res = await agent.beginOAuth(code, level as AccessLevel);
  if (res.authUrl) return Response.redirect(res.authUrl, 302);
  return html(res.error ?? "Connected. Go back to your messages.");
}

// ── /setup (operator) ────────────────────────────────────────────────────────

async function handleSetup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const s = url.searchParams.get("s") ?? "";
  const phoneRaw = url.searchParams.get("phone") ?? "";

  if (!env.SETUP_SECRET || s !== env.SETUP_SECRET) return new Response("forbidden", { status: 403 });

  let phone: string;
  try {
    phone = normalizeE164(phoneRaw);
  } catch (err) {
    if (err instanceof BadPhoneNumberError) return html("phone must be E.164, e.g. +2348012345678", 400);
    throw err;
  }
  if (!operatorNumbers(env).has(phone)) return new Response("not an operator number", { status: 403 });

  const agent = await getAgentByName<Env, TraderAgent>(env.TraderAgent, await phoneHash(phone));
  const res = await agent.beginOAuth("", "full", env.SETUP_SECRET, phone);
  if (res.authUrl) return Response.redirect(res.authUrl, 302);
  return html(res.error ?? "Operator connected.");
}

// ── /debug/mcp (Phase 0 spike; SETUP_SECRET-gated) ───────────────────────────

async function handleDebugMcp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.SETUP_SECRET || url.searchParams.get("s") !== env.SETUP_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let phone: string;
  try {
    phone = normalizeE164(url.searchParams.get("phone") ?? "");
  } catch {
    return new Response("phone must be E.164", { status: 400 });
  }
  const agent = await getAgentByName<Env, TraderAgent>(env.TraderAgent, await phoneHash(phone));
  const out = await agent.debugMcp();
  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
     <body style="font:16px/1.5 system-ui;max-width:34rem;margin:2rem auto;padding:0 1rem">${body}</body>`,
    { status, headers: { "content-type": "text/html" } },
  );
}
