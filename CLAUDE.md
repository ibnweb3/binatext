# BinaText

An AI trading agent you operate entirely over **SMS**, built on the official
Binance Agent OS MCP server. Text it "how's my BNB?" or "put $5 into SOL"; it
restates any order and waits for `YES <PIN>` before touching money.
Cloudflare Workers + Durable Objects, ~$0 stack. Hackathon: Binance Agent OS
Mini Hackathon, **Track A**, deadline **2026-09-08 23:59 UTC**.

**The full plan is `C:\Users\IBN\.claude\plans\radiant-toasting-rivest.md`.**
Read it before making design decisions — this file deliberately does not
duplicate it.

## Ground rules

- **Track A path is sacred:** every market/balance/trade/transfer call in the
  deployed Worker goes through `https://agent.binance.com/mcp/agentic`.
  Third-party MCP / raw keys may appear **only** in `scripts/spike-*` for
  offline iteration.
- **Budget ~$0:** Workers free plan, Groq free tier (model), Workers AI free
  tier (fallback), textbee.dev free tier (SMS). Anthropic Haiku (~$1 total) is
  the last-resort model fallback.
- **No LLM in the money path.** `src/trade/policy.ts` `enforceOrderPolicy()` is
  a deterministic BigInt-cents check; it runs before every MCP write. The model
  never gets a place/cancel/transfer tool — only read tools + `propose_trade`.
- **Every trade needs `YES <PIN>`** (rotating, single-use, 5-min expiry). `STOP`
  (cancel open orders) runs immediately, no PIN — it's a safety control.
- **Multi-tenant.** Anyone texts the number → own Durable Object → connects
  their own Binance via OAuth (their own sub-account, their own funds). Judge
  default = read-only access level (full UX, execute stubbed, no deposit).
- **Build order:** Phase 0 spikes → Q&A → portfolio → NL order + confirm →
  onboarding + read-only → alerts → STOP.

## Layout

- `src/index.ts` — Worker fetch: `/sms/*`, `/connect` (user onboarding), `/setup` (operator), `/agents/*` via `routeAgentRequest`
- `src/scheduled.ts` — Cron: alert-poll liveness backstop
- `src/agent.ts` — `TraderAgent` Durable Object: onboarding + confirmation state machine, model loop, MCP wiring, `alarm()`. Center of the project.
- `src/registry.ts` — `AlertRegistry` DO: index of phones with active alerts; new-DO rate limiting
- `src/sms/*` — `SmsProvider` interface + `textbee` (primary) / `twilio` (fallback) adapters
- `src/trade/*` — `policy` (the guard), `proposals` (PIN lifecycle), `execute` (MCP write), `ledger` (daily USD)
- `src/mcp/binance.ts` — Agent OS MCP connect + OAuth bootstrap + tool-name discovery
- `src/model/*` — `provider` (Groq→Workers AI→Anthropic chain), `loop` (generateText + local tools)
- `src/shared/*` — `env`, `phone`, `audit`, `ratelimit`, `idem`
- `scripts/spike-*` — Phase 0 proofs (run before building on them)
- `test/*` — `smoke-guard` (money safety), `smoke-proposals`, `smoke-statemachine`

## Dev

- `npm test` — all smoke tests (money-safety guard + PIN lifecycle + state machine). No network.
- `npm run spike:model` — `GROQ_API_KEY=... npm run spike:model` — model tool-calling reliability (gate: ≥9/10 per intent)
- `npm run spike:textbee -- serve|send` — capture textbee's real inbound shape / test outbound
- `npm run dev` — `wrangler dev` (needs the Phase 0 secrets in `.dev.vars`; see `.dev.vars.example`)
- `npm run deploy` — `wrangler deploy`

**Prereqs:** Node 20+, `wrangler` logged in, `GROQ_API_KEY`, a Binance account
with a funded Agentic sub-account, a textbee Android device, and — for
`wrangler dev` / `npm run test` with the Workers pool — an environment where npm
postinstall scripts are allowed (esbuild + workerd need them; run
`npm rebuild esbuild workerd` if they were blocked).

Secrets are set with `wrangler secret put <NAME>` (list in `.dev.vars.example`),
never committed.
