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
import {
  CLIENT_METADATA_PATH,
  OAUTH_CALLBACK_PATH,
  clientMetadataDocument,
  phoneHashFromOAuthState,
} from "./mcp/oauth-provider.ts";
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
      if (path === "/bridge/poll" || path === "/bridge/result") return await handleBridge(request, env, path);
      if (path === CLIENT_METADATA_PATH) return clientMetadataResponse(url);
      if (path === OAUTH_CALLBACK_PATH) return await handleOAuthCallback(request, env);
      if (path === "/connect") return await handleConnect(request, env);
      if (path === "/setup") return await handleSetup(request, env);
      if (path === "/debug/mcp") return await handleDebugMcp(request, env);
      if (path === "/debug/oauth-meta") return await handleOAuthMeta(request, env);
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
      <h2>BinaText setup</h2>
      <p>BinaText reaches Binance Agent OS (<code>agent.binance.com/mcp/agentic</code>)
      through a Binance-supported client. It cannot withdraw funds; every order needs
      an SMS PIN and stays under hard USD caps.</p>
      <p><a href="${base}&level=read-only"><b>Read-only</b></a> — the whole experience with no
      account: live prices, the order + PIN flow, execution simulated.</p>
      <p><a href="${base}&level=full"><b>Full</b></a> — real spot orders through Agent OS
      (operator numbers only for now — third-party accounts need Binance to open agent
      registration).</p>`);
  }

  const agent = await getAgentByName<Env, TraderAgent>(env.TraderAgent, p);
  const res = await agent.beginOAuth(code, level as AccessLevel);
  if (res.authUrl) return Response.redirect(res.authUrl, 302);
  return html(res.error ?? "Connected — go back to your messages and text a question.");
}

// ── /bridge/* (local Binance bridge — see src/mcp/bridge.ts) ────────────────

interface RegistryBridge {
  bridgeClaim(): Promise<{ id: string; op: string; args: string } | null>;
  bridgeComplete(id: string, status: "done" | "error", payloadJson: string): Promise<void>;
}

async function handleBridge(request: Request, env: Env, path: string): Promise<Response> {
  const want = (env.BRIDGE_SECRET ?? "").trim();
  const got = (request.headers.get("x-bridge-secret") ?? "").trim();
  if (!want || got !== want) return new Response("forbidden", { status: 403 });
  const reg = env.AlertRegistry.get(env.AlertRegistry.idFromName("global")) as unknown as RegistryBridge;

  if (path === "/bridge/poll") {
    const job = await reg.bridgeClaim();
    return job ? Response.json(job) : new Response(null, { status: 204 });
  }

  // /bridge/result
  const body = (await request.json().catch(() => null)) as
    | { id?: string; status?: string; data?: unknown; error?: string }
    | null;
  if (!body?.id || (body.status !== "done" && body.status !== "error")) {
    return new Response("bad result", { status: 400 });
  }
  await reg.bridgeComplete(
    body.id,
    body.status,
    JSON.stringify(body.status === "done" ? { data: body.data } : { error: body.error ?? "bridge error" }),
  );
  return new Response(null, { status: 204 });
}

// ── CIMD / OAuth (Binance Agent OS uses Client ID Metadata Documents) ────────

/** SEP-991 client-metadata document. Binance fetches this and uses the URL as client_id. */
function clientMetadataResponse(url: URL): Response {
  return new Response(JSON.stringify(clientMetadataDocument(url.origin), null, 2), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * Single fixed OAuth redirect URI for every user. The per-phone Durable Object is
 * recovered from the hash embedded in the `state` nonce, then the request is
 * handed to that DO whose MCP client manager matches it as its own callback.
 */
async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hash = phoneHashFromOAuthState(url.searchParams.get("state"));
  if (!hash) {
    return html("That authorization link is invalid or has expired. Text START to your BinaText number for a fresh one.", 400);
  }
  const stub = env.TraderAgent.get(env.TraderAgent.idFromName(hash));
  return stub.fetch(request);
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

// ── /debug/oauth-meta (TEMP — probe Binance Agent OS OAuth server metadata) ──
// Only fetches PUBLIC .well-known discovery documents. Remove after diagnosing DCR.
async function handleOAuthMeta(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== "binatext-dcr-probe") return new Response("forbidden", { status: 403 });

  const mcpUrl = env.BINANCE_MCP_URL;
  const origin = new URL(mcpUrl).origin;
  const out: Record<string, unknown> = {};

  // 1. The MCP endpoint itself — grab its WWW-Authenticate (points to the RS metadata).
  try {
    const r = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    out.mcpProbe = { status: r.status, wwwAuthenticate: r.headers.get("www-authenticate") };
  } catch (e) {
    out.mcpProbe = `ERROR: ${(e as Error).message}`;
  }

  const wellKnown = [
    `${origin}/.well-known/oauth-protected-resource`,
    `${origin}/.well-known/oauth-protected-resource/mcp/agentic`,
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/oauth-authorization-server/mcp/agentic`,
    `${origin}/.well-known/openid-configuration`,
    `${mcpUrl}/.well-known/oauth-authorization-server`,
  ];
  for (const w of wellKnown) {
    try {
      const r = await fetch(w, { headers: { accept: "application/json" } });
      const text = await r.text();
      let body: unknown = text.slice(0, 4000);
      try { body = JSON.parse(text); } catch { /* keep text */ }
      out[w] = { status: r.status, body };
    } catch (e) {
      out[w] = `ERROR: ${(e as Error).message}`;
    }
  }
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
