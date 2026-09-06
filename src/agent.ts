/**
 * TraderAgent — one Durable Object per phone number. The centre of BinaText.
 *
 * Owns: the onboarding + confirmation state machine, the per-user Binance OAuth
 * tokens (in this DO's SQLite, via the `agents` MCP client), the pending
 * proposal + PIN, the daily USD ledger, price alerts, conversation history and
 * an audit log. Deterministic paths call `src/agent/decide.ts`; the IDLE path
 * runs the model loop with read-only MCP tools + local tools.
 */

import { Agent } from "agents";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";

import { checkReadiness, float, int, operatorNumbers, type Env } from "./shared/env.ts";
import { getSmsProvider } from "./sms/provider.ts";
import { maskPhone } from "./shared/phone.ts";
import { runAgentTurn } from "./model/loop.ts";
import {
  MSG,
  decideConfirmation,
  decideOnboarding,
  type AccessLevel,
  type FsmState,
} from "./agent/decide.ts";
import {
  createProposal,
  restate,
  type OrderType,
  type Proposal,
} from "./trade/proposals.ts";
import {
  enforceOrderPolicy,
  policyConfigFromEnv,
  type OrderSide,
} from "./trade/policy.ts";
import { remainingToday, utcDay, withinDailyCap } from "./trade/ledger.ts";
import { cancelOpenOrders, runProposal } from "./trade/execute.ts";
import {
  binanceStatus,
  connectBinance,
  discoverToolMap,
  getTickerPrice,
  readOnlyBinanceTools,
  type ToolMap,
} from "./mcp/binance.ts";

const HISTORY_TURNS = 10;
const DEDUP_TTL_MS = 60 * 60 * 1000;

export class TraderAgent extends Agent<Env> {
  // ── lifecycle ──────────────────────────────────────────────────────────────

  override async onStart(): Promise<void> {
    this.#ensureTables();

    // Page the browser sees after Binance consent; the real work happens in waitUntil.
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          this.ctx.waitUntil(this.#onConnected());
        } else {
          this.#kv("mcp_auth_dead", "1");
        }
        return new Response(
          `<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:2rem">
           <h3>${result.authSuccess ? "Connected" : "Could not connect"}</h3>
           <p>${result.authSuccess ? "Close this tab and go back to your messages." : "Text START again to retry."}</p>`,
          { headers: { "content-type": "text/html" }, status: result.authSuccess ? 200 : 400 },
        );
      },
    });

    // Reconcile: if consent completed while we were asleep, catch up.
    if (this.#getState() === "AWAITING_BINANCE_AUTH" && binanceStatus(this as never).ready) {
      await this.#onConnected();
    }
    // Keep the alert poll armed if there are live alerts.
    if (this.#liveAlertCount() > 0) await this.scheduleEvery(120, "pollAlerts");
  }

  override onRequest(): Response {
    return new Response("BinaText agent. Talk to it over SMS.", { status: 200 });
  }

  // ── RPC (called from src/index.ts) ─────────────────────────────────────────

  /** Inbound SMS. `ctx.waitUntil`-ed by the Worker; replies are sent async. */
  async handleInboundSms(from: string, body: string, msgId: string): Promise<void> {
    if (this.#seen(msgId)) return;

    // Loop breaker: some Android/carrier setups echo the gateway's own SENT
    // messages back as "received". If this inbound is verbatim something we sent
    // in the last 15 min, it's an echo — drop it, never reply.
    if (this.#wasRecentlySent(body)) {
      this.#audit("echo_dropped", { body: body.slice(0, 80) });
      return;
    }

    // Circuit breaker: if this DO has fired a burst of replies, something is
    // looping — stop paying for SMS until it's investigated.
    if (this.#outboundBurst()) {
      this.#audit("circuit_open", {});
      console.error(`[agent] circuit breaker OPEN for ${maskPhone(from)} — too many recent sends`);
      return;
    }

    this.#kv("phone", from);
    this.#audit("inbound", { from: maskPhone(from), body });
    this.#appendHistory("user", body);

    const text = body.trim().toUpperCase();
    const state = this.#getState();

    // RESET works from anywhere.
    if (["RESET", "DISCONNECT", "LOGOUT"].includes(text)) {
      await this.#reset();
      return this.#say(MSG.reset);
    }

    if (state === "UNREGISTERED" || state === "AWAITING_BINANCE_AUTH") {
      return this.#handleOnboarding(state, body);
    }

    if (this.#kv("mcp_auth_dead") === "1") {
      return this.#say(MSG.authExpired(await this.#connectUrl()));
    }

    if (state === "EXECUTING") return this.#say(MSG.busy);

    if (state === "AWAITING_CONFIRMATION") {
      return this.#handleConfirmation(body);
    }

    // state === "IDLE"
    return this.#handleIdle(from, body);
  }

  /**
   * Start the OAuth flow for this phone. Returns an authUrl to redirect the
   * browser to. Normal users pass the 6-digit code texted to them; the operator
   * `/setup` route passes `operatorSecret` instead (checked against SETUP_SECRET).
   */
  async beginOAuth(
    code: string,
    level: AccessLevel,
    operatorSecret?: string,
    phone?: string,
  ): Promise<{ authUrl?: string; error?: string }> {
    const isOperator = !!operatorSecret && operatorSecret === this.env.SETUP_SECRET;
    if (isOperator) {
      this.#kv("is_operator", "1");
      if (phone) this.#kv("phone", phone);
    } else {
      const stored = this.#kv("onboard_code");
      const exp = Number(this.#kv("onboard_code_exp") ?? "0");
      if (!stored || stored !== code || Date.now() > exp) {
        return { error: "That link expired. Text START to get a new one." };
      }
    }
    this.#kv("pending_level", level);
    try {
      const conn = await connectBinance(this as never, {
        url: this.env.BINANCE_MCP_URL,
        publicHost: this.env.PUBLIC_HOST,
      });
      if (conn.authUrl) return { authUrl: conn.authUrl };
      if (conn.state === "ready") {
        await this.#onConnected();
        return {};
      }
      return { error: `Connection is ${conn.state}. Try again in a moment.` };
    } catch (err) {
      return { error: `Couldn't reach Binance: ${(err as Error).message}` };
    }
  }

  /** Cron backstop pokes this (idempotent). */
  async pollAlertsNow(): Promise<void> {
    await this.pollAlerts();
  }

  /** Operator/debug snapshot. */
  async snapshot(): Promise<Record<string, unknown>> {
    return {
      state: this.#getState(),
      accessLevel: this.#kv("access_level"),
      binance: binanceStatus(this as never),
      alerts: this.#liveAlertCount(),
      usedTodayUsd: this.#usedToday(),
      hasProposal: !!this.#getProposal(),
    };
  }

  /**
   * Phase 0 MCP spike, exposed via GET /debug/mcp. After the Binance consent:
   * did the connection go ready, what are the real tool names, does a market-data
   * call work, and is there a usable token lifetime?
   */
  async debugMcp(): Promise<Record<string, unknown>> {
    const servers = this.getMcpServers();
    const server = servers.servers["binance"];
    const toolNames = servers.tools.filter((t) => t.serverId === "binance").map((t) => t.name);
    const toolMap = discoverToolMap(this as never);

    let sampleTicker: unknown;
    try {
      sampleTicker = await getTickerPrice(this as never, toolMap, "BTCUSDT");
    } catch (err) {
      sampleTicker = `ERROR: ${(err as Error).message}`;
    }

    let sampleBalance: unknown;
    if (toolMap.balances) {
      try {
        const raw = await this.mcp.callTool({ serverId: "binance", name: toolMap.balances, arguments: {} });
        sampleBalance = JSON.stringify(raw).slice(0, 600);
      } catch (err) {
        sampleBalance = `ERROR: ${(err as Error).message}`;
      }
    }

    return {
      connectionState: server?.state ?? "absent",
      connectionError: server?.error ?? null,
      grantedScopes: this.#kv("granted_scopes") ?? null,
      accessLevel: this.#kv("access_level") ?? null,
      toolCount: toolNames.length,
      toolNames,
      resolvedToolMap: toolMap,
      sampleTicker,
      sampleBalance,
    };
  }

  // ── scheduled callbacks ────────────────────────────────────────────────────

  async expireProposal(): Promise<void> {
    const p = this.#getProposal();
    if (!p) return;
    if (Date.now() >= p.expiresAt) {
      this.#clearProposal();
      this.#setState("IDLE");
      await this.#say(MSG.expired);
    }
  }

  async pollAlerts(): Promise<void> {
    const rows = this.sql<{ id: string; symbol: string; direction: string; threshold: number }>`
      SELECT id, symbol, direction, threshold FROM alerts WHERE fired_at IS NULL`;
    if (rows.length === 0) {
      await this.cancelSchedule("pollAlerts").catch(() => {});
      this.#registry().removeAlertOwner(this.name);
      return;
    }
    if (!binanceStatus(this as never).ready) return;

    const toolMap = this.#toolMap();
    const prices = new Map<string, number>();
    for (const symbol of new Set(rows.map((r) => r.symbol))) {
      try {
        prices.set(symbol, await getTickerPrice(this as never, toolMap, symbol));
      } catch {
        /* skip this symbol this tick */
      }
    }
    for (const a of rows) {
      const price = prices.get(a.symbol);
      if (price === undefined) continue;
      const hit = a.direction === "below" ? price <= a.threshold : price >= a.threshold;
      if (!hit) continue;
      this.sql`UPDATE alerts SET fired_at = ${Date.now()} WHERE id = ${a.id}`;
      this.#audit("alert_fired", { symbol: a.symbol, direction: a.direction, threshold: a.threshold, price });
      await this.#say(
        `${a.symbol.replace(/USDT$/, "")} is $${price} - ${a.direction} your $${a.threshold} alert.`,
      );
    }
  }

  // ── onboarding ─────────────────────────────────────────────────────────────

  async #handleOnboarding(state: FsmState, body: string): Promise<void> {
    const d = decideOnboarding(state, body);
    switch (d.action) {
      case "welcome":
        return this.#say(MSG.welcome);
      case "issue_code":
      case "resend_code": {
        const url = await this.#connectUrl(true);
        this.#setState("AWAITING_BINANCE_AUTH");
        return this.#say(MSG.connectLink(url));
      }
      case "must_finish":
        return this.#say(MSG.mustFinish(await this.#connectUrl()));
      case "reset":
        await this.#reset();
        return this.#say(MSG.reset);
      case "ignore":
        return;
    }
  }

  async #onConnected(): Promise<void> {
    const level = (this.#kv("pending_level") as AccessLevel) ?? "read-only";
    this.#kv("access_level", level);
    this.#kv(
      "granted_scopes",
      level === "full" ? "market-data,account,trade,transfer" : "market-data,account",
    );
    this.#kv("mcp_auth_dead", "");
    // Cache the discovered tool names so later calls don't re-list.
    this.#kv("tool_map", JSON.stringify(discoverToolMap(this as never)));
    this.#setState("IDLE");
    this.#audit("connected", { level });
    await this.#say(MSG.connected(level));
  }

  // ── confirmation ───────────────────────────────────────────────────────────

  async #handleConfirmation(body: string): Promise<void> {
    const p = this.#getProposal();
    if (!p) {
      this.#setState("IDLE");
      return this.#handleIdle(this.#kv("phone") ?? "", body);
    }
    const d = decideConfirmation(p, body, {
      now: Date.now(),
      maxAttempts: int(this.env.MAX_PIN_ATTEMPTS, 3),
    });

    switch (d.action) {
      case "cancelled":
        this.#clearProposal();
        this.#setState("IDLE");
        return this.#say(MSG.cancelled);
      case "stop":
        this.#clearProposal();
        this.#setState("IDLE");
        await this.#say(MSG.stopped);
        return void (await this.#cancelOpen());
      case "expired":
        this.#clearProposal();
        this.#setState("IDLE");
        return this.#say(MSG.expired);
      case "locked":
        this.#clearProposal();
        this.#setState("IDLE");
        return this.#say(MSG.locked);
      case "bad_pin":
        this.#putProposal(d.proposal);
        return this.#say(MSG.badPin(d.attemptsLeft));
      case "reprompt":
        return this.#say(MSG.reprompt(p.pin));
      case "execute":
        return this.#execute(p);
    }
  }

  async #execute(p: Proposal): Promise<void> {
    this.#setState("EXECUTING");
    const res = await runProposal(this as never, p, {
      toolMap: this.#toolMap(),
      accessLevel: (this.#kv("access_level") as AccessLevel) ?? "read-only",
      policy: policyConfigFromEnv(this.env),
      dailyUsedUsd: this.#usedToday(),
      slippageAbortPct: float(this.env.SLIPPAGE_ABORT_PCT, 1.5),
      now: Date.now(),
    });
    this.#clearProposal();
    this.#setState("IDLE");

    if (res.kind === "filled") {
      this.#addToLedger(res.spentUsd);
      this.#audit("order_filled", { orderId: res.orderId, raw: res.raw.slice(0, 400) });
    } else if (res.kind === "stub") {
      this.#audit("order_stub", { proposal: p.id });
    } else if (res.kind === "auth_error") {
      this.#kv("mcp_auth_dead", "1");
    } else {
      this.#audit("order_" + res.kind, { message: res.message });
    }
    await this.#say(res.message);
  }

  async #cancelOpen(): Promise<void> {
    if (!binanceStatus(this as never).ready) return;
    if ((this.#kv("access_level") as AccessLevel) === "read-only") return;
    const { message } = await cancelOpenOrders(this as never, this.#toolMap());
    this.#audit("cancel_open", { message });
  }

  // ── IDLE model loop ────────────────────────────────────────────────────────

  async #handleIdle(from: string, _body: string): Promise<void> {
    if (!checkReadiness(this.env).model) {
      return this.#say("My language model isn't configured yet. Try again shortly.");
    }

    let proposalSent = false;
    const localTools = this.#buildLocalTools(() => {
      proposalSent = true;
    });
    const mcpTools = binanceStatus(this as never).ready ? readOnlyBinanceTools(this as never) : {};
    const tools: ToolSet = { ...mcpTools, ...localTools };

    const result = await runAgentTurn({
      env: this.env,
      messages: this.#historyForModel(),
      tools,
      maxSteps: 6,
    });

    this.#appendHistory("assistant", result.text || "(tool call)");
    // If a proposal went out this turn, its authoritative SMS was already sent.
    if (!proposalSent && result.text) await this.#say(result.text);
  }

  #buildLocalTools(onProposal: () => void): ToolSet {
    const nz = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

    return {
      propose_trade: tool({
        description:
          "Propose a spot BUY or SELL for the user to confirm with a PIN. Use USD amounts unless a coin quantity is clearly meant.",
        inputSchema: z.object({
          symbol: z.string().describe('e.g. "BNB" or "BNBUSDT"'),
          side: z.enum(["BUY", "SELL"]),
          quoteAmountUsd: z.number().nullish(),
          baseQty: z.number().nullish(),
          type: z.enum(["MARKET", "LIMIT"]).nullish(),
          limitPrice: z.number().nullish(),
        }),
        execute: async (a) => {
          const r = await this.#proposeTrade({
            symbol: a.symbol,
            side: a.side as OrderSide,
            quoteAmountUsd: nz(a.quoteAmountUsd),
            baseQty: nz(a.baseQty),
            type: (nz(a.type) as OrderType) ?? "MARKET",
            limitPrice: nz(a.limitPrice),
          });
          if (r.ok) onProposal();
          return r.message;
        },
      }),
      set_price_alert: tool({
        description: "Text the user when a symbol crosses a price.",
        inputSchema: z.object({
          symbol: z.string(),
          direction: z.enum(["below", "above"]),
          threshold: z.number(),
        }),
        execute: async (a) => this.#setAlert(a.symbol, a.direction, a.threshold),
      }),
      list_alerts: tool({
        description: "List the user's active price alerts.",
        inputSchema: z.object({}),
        execute: async () => {
          const rows = this.sql<{ symbol: string; direction: string; threshold: number }>`
            SELECT symbol, direction, threshold FROM alerts WHERE fired_at IS NULL`;
          return rows.length
            ? rows.map((r) => `${r.symbol} ${r.direction} ${r.threshold}`).join("; ")
            : "No active alerts.";
        },
      }),
      cancel_alert: tool({
        description: "Cancel active price alerts for a symbol (or all).",
        inputSchema: z.object({ symbol: z.string().nullish() }),
        execute: async (a) => {
          const sym = nz(a.symbol)?.toUpperCase();
          if (sym) this.sql`DELETE FROM alerts WHERE fired_at IS NULL AND symbol LIKE ${`%${sym}%`}`;
          else this.sql`DELETE FROM alerts WHERE fired_at IS NULL`;
          return "Done.";
        },
      }),
    };
  }

  async #proposeTrade(input: {
    symbol: string;
    side: OrderSide;
    quoteAmountUsd?: number;
    baseQty?: number;
    type: OrderType;
    limitPrice?: number;
  }): Promise<{ ok: boolean; message: string }> {
    const symbol = normalizeSymbol(input.symbol);
    const policy = policyConfigFromEnv(this.env);
    if (!policy.allowedSymbols.includes(symbol)) {
      return { ok: false, message: `I can only trade ${policy.allowedSymbols.join(", ")}.` };
    }
    if (!binanceStatus(this as never).ready) {
      return { ok: false, message: "Not connected to Binance - text RESET then START to reconnect." };
    }

    let price: number;
    try {
      price = await getTickerPrice(this as never, this.#toolMap(), symbol);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }

    const notionalUsd = input.quoteAmountUsd ?? (input.baseQty ?? 0) * price;
    const guard = enforceOrderPolicy(
      { symbol, side: input.side, notionalUsd, dailyUsedUsd: this.#usedToday() },
      policy,
    );
    if (!guard.ok) {
      this.#audit("guard_block", { reason: guard.reason });
      return { ok: false, message: guard.reason };
    }

    const proposal = createProposal(
      {
        symbol,
        side: input.side,
        type: input.type,
        notionalUsd: guard.notionalUsd,
        quotePrice: price,
        ...(input.limitPrice !== undefined ? { limitPrice: input.limitPrice } : {}),
      },
      {
        now: Date.now(),
        ttlSeconds: int(this.env.PROPOSAL_TTL_SECONDS, 300),
        prevPin: this.#kv("prev_pin") ?? undefined,
      },
    );
    this.#putProposal(proposal);
    this.#kv("prev_pin", proposal.pin);
    this.#setState("AWAITING_CONFIRMATION");
    await this.schedule(int(this.env.PROPOSAL_TTL_SECONDS, 300), "expireProposal");

    await this.#say(
      `Order: ${restate(proposal)}.\nReply  YES ${proposal.pin}  to confirm. Expires in ` +
        `${Math.round(int(this.env.PROPOSAL_TTL_SECONDS, 300) / 60)} min. Reply NO to cancel.`,
    );
    return { ok: true, message: "Proposal sent to the user for confirmation." };
  }

  async #setAlert(symbol: string, direction: "below" | "above", threshold: number): Promise<string> {
    const sym = normalizeSymbol(symbol);
    const policy = policyConfigFromEnv(this.env);
    if (!policy.allowedSymbols.includes(sym)) return `I can only track ${policy.allowedSymbols.join(", ")}.`;
    this.sql`INSERT INTO alerts (id, symbol, direction, threshold, fired_at)
             VALUES (${crypto.randomUUID()}, ${sym}, ${direction}, ${threshold}, NULL)`;
    this.#registry().addAlertOwner(this.name);
    await this.scheduleEvery(120, "pollAlerts");
    this.#audit("alert_set", { symbol: sym, direction, threshold });
    return `Alert set: ${sym.replace(/USDT$/, "")} ${direction} $${threshold}. I'll text you.`;
  }

  // ── storage helpers ────────────────────────────────────────────────────────

  #ensureTables(): void {
    this.sql`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, val TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS proposal (id TEXT PRIMARY KEY, json TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT, threshold REAL, fired_at INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS ledger_day (day TEXT PRIMARY KEY, used_usd REAL)`;
    this.sql`CREATE TABLE IF NOT EXISTS seen_msg (msg_id TEXT PRIMARY KEY, ts INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS history (ts INTEGER, role TEXT, content TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS audit (ts INTEGER, kind TEXT, json TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS sent_log (ts INTEGER, hash TEXT)`;
  }

  /** Whether `body` matches a message this DO sent in the last 15 minutes (echo detection). */
  #wasRecentlySent(body: string): boolean {
    const h = quickHash(body.trim());
    const cutoff = Date.now() - 15 * 60_000;
    this.sql`DELETE FROM sent_log WHERE ts < ${cutoff}`;
    return this.sql`SELECT 1 FROM sent_log WHERE hash = ${h}`.length > 0;
  }

  /** More than 6 sends in the last 10 minutes -> something is looping. */
  #outboundBurst(): boolean {
    const cutoff = Date.now() - 10 * 60_000;
    return this.sql<{ n: number }>`SELECT COUNT(*) n FROM sent_log WHERE ts > ${cutoff}`[0]!.n > 6;
  }

  #kv(key: string, val?: string): string | undefined {
    if (val !== undefined) {
      this.sql`INSERT INTO kv (key, val) VALUES (${key}, ${val})
               ON CONFLICT(key) DO UPDATE SET val = ${val}`;
      return val;
    }
    return this.sql<{ val: string }>`SELECT val FROM kv WHERE key = ${key}`[0]?.val;
  }

  #getState(): FsmState {
    return (this.#kv("fsm_state") as FsmState) ?? "UNREGISTERED";
  }
  #setState(s: FsmState): void {
    this.#kv("fsm_state", s);
  }

  #getProposal(): Proposal | null {
    const row = this.sql<{ json: string }>`SELECT json FROM proposal LIMIT 1`[0];
    return row ? (JSON.parse(row.json) as Proposal) : null;
  }
  #putProposal(p: Proposal): void {
    this.sql`DELETE FROM proposal`;
    this.sql`INSERT INTO proposal (id, json) VALUES (${p.id}, ${JSON.stringify(p)})`;
  }
  #clearProposal(): void {
    this.sql`DELETE FROM proposal`;
  }

  #toolMap(): ToolMap {
    try {
      return JSON.parse(this.#kv("tool_map") ?? "{}") as ToolMap;
    } catch {
      return {};
    }
  }

  #seen(msgId: string): boolean {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    this.sql`DELETE FROM seen_msg WHERE ts < ${cutoff}`;
    if (this.sql`SELECT 1 FROM seen_msg WHERE msg_id = ${msgId}`.length > 0) return true;
    this.sql`INSERT INTO seen_msg (msg_id, ts) VALUES (${msgId}, ${Date.now()})`;
    return false;
  }

  #usedToday(): number {
    const day = utcDay(Date.now());
    return this.sql<{ used_usd: number }>`SELECT used_usd FROM ledger_day WHERE day = ${day}`[0]?.used_usd ?? 0;
  }
  #addToLedger(usd: number): void {
    const day = utcDay(Date.now());
    this.sql`INSERT INTO ledger_day (day, used_usd) VALUES (${day}, ${usd})
             ON CONFLICT(day) DO UPDATE SET used_usd = used_usd + ${usd}`;
  }

  #liveAlertCount(): number {
    return this.sql`SELECT 1 FROM alerts WHERE fired_at IS NULL`.length;
  }

  #appendHistory(role: "user" | "assistant", content: string): void {
    this.sql`INSERT INTO history (ts, role, content) VALUES (${Date.now()}, ${role}, ${content})`;
    // keep the last N turns (2N rows)
    this.sql`DELETE FROM history WHERE ts NOT IN (
               SELECT ts FROM history ORDER BY ts DESC LIMIT ${HISTORY_TURNS * 2})`;
  }
  #historyForModel(): ModelMessage[] {
    return this.sql<{ role: string; content: string }>`
      SELECT role, content FROM history ORDER BY ts ASC`.map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content,
    }));
  }

  #audit(kind: string, data: Record<string, unknown>): void {
    this.sql`INSERT INTO audit (ts, kind, json) VALUES (${Date.now()}, ${kind}, ${JSON.stringify(data)})`;
  }

  #registry() {
    return this.env.AlertRegistry.get(this.env.AlertRegistry.idFromName("global")) as unknown as {
      addAlertOwner(hash: string): void;
      removeAlertOwner(hash: string): void;
    };
  }

  async #say(body: string): Promise<void> {
    const to = this.#kv("phone");
    if (!to) return;
    this.sql`INSERT INTO sent_log (ts, hash) VALUES (${Date.now()}, ${quickHash(body.trim())})`;
    this.#audit("outbound", { body });
    await getSmsProvider(this.env).send(to, body, this.env);
  }

  async #connectUrl(mintNew = false): Promise<string> {
    let code = this.#kv("onboard_code");
    if (mintNew || !code || Date.now() > Number(this.#kv("onboard_code_exp") ?? "0")) {
      code = String(Math.floor(100000 + Math.random() * 900000));
      this.#kv("onboard_code", code);
      this.#kv("onboard_code_exp", String(Date.now() + int(this.env.ONBOARD_CODE_TTL_SECONDS, 900) * 1000));
    }
    const phone = this.#kv("phone") ?? "";
    const host = this.env.PUBLIC_HOST.startsWith("http") ? this.env.PUBLIC_HOST : `https://${this.env.PUBLIC_HOST}`;
    return `${host}/connect?p=${encodeURIComponent(phone)}&c=${code}`;
  }

  async #reset(): Promise<void> {
    try {
      if (this.getMcpServers().servers["binance"]) await this.removeMcpServer("binance");
    } catch {
      /* ignore */
    }
    this.sql`DELETE FROM proposal`;
    this.sql`DELETE FROM alerts`;
    this.sql`DELETE FROM history`;
    this.sql`DELETE FROM audit`;
    this.sql`DELETE FROM sent_log`;
    this.sql`DELETE FROM kv`;
    await this.cancelSchedule("pollAlerts").catch(() => {});
    this.#setState("UNREGISTERED");
  }
}

// ── module helpers ───────────────────────────────────────────────────────────

/** Small non-crypto hash for echo/dedup checks (djb2). */
function quickHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** "bnb" / "BNB" / "bnbusdt" -> "BNBUSDT". Leaves other quote pairs alone. */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/USDT$|USDC$|BUSD$|BTC$|ETH$/.test(s)) return s;
  return `${s}USDT`;
}

export { operatorNumbers, remainingToday, withinDailyCap };
