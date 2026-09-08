# BinaText

**Trade your Binance account by text message. No app, no smartphone, no API keys on your device — and hard spend limits the agent physically cannot exceed.**

Built for the [Binance Agent OS Mini Hackathon](https://www.binance.com/en/blog/community/8802181509900814931) (Track A). Runs on Cloudflare Workers + Durable Objects on free tiers.

> **Try it:** text `START` to **`+234 703 330 1963`** and connect in ~20 seconds. Pick **Read-only** — no account or deposit needed.

## The problem

Every trading bot wants the same thing: full API-key access to your account, usually including withdrawal, running on a server you have to trust. And you need a smartphone with the app to do anything.

BinaText is the opposite. You text it in plain language. It reaches Binance through the **official Binance Agent OS MCP server** (`agent.binance.com/mcp/agentic`) — market data and spot trading only, under permissions where **withdrawal is not an option that exists**. Every order is restated back to you and waits for a one-time PIN before it touches a cent.

### A note on Binance Agent OS access

Binance Agent OS OAuth currently only issues tokens to **allowlisted host clients** (Claude Code, ChatGPT, Codex, VS Code) — there is no third-party agent registration yet. BinaText implements the full flow anyway (OAuth 2.1 + PKCE + [Client ID Metadata Documents](src/mcp/oauth-provider.ts); it reaches Binance's real consent screen), but until registration opens it routes its Agent OS calls through a **~150-line bridge** (`bridge/run.mjs`) that runs on the operator's machine against an authenticated Claude Code session. The Worker still owns every decision — policy guard, PIN, state. When Binance opens registration, the Worker does the OAuth itself and the bridge is deleted behind its one interface (`src/mcp/bridge.ts`).

## What it does

1. **Market Q&A** — _"what's BTC doing?"_ → live price + 24h from Binance.
2. **Portfolio** — _"how am I positioned?"_ → your Agentic sub-account balances.
3. **Natural-language orders** — _"put $5 into BNB"_ → the agent restates the order and texts you `Reply YES 4821 to confirm`. Nothing executes without it.
4. **Standing price alerts** — _"tell me if SOL drops under 140"_ → an SMS when it does.
5. **`STOP`** — cancels all open orders immediately.

## Try it yourself

| Path | You need | Deposit? |
|---|---|---|
| **Read-only** _(recommended for judges)_ | Nothing — just SMS | **None** — full experience, the execute step is stubbed |
| **Full** | Operator's Binance (via the bridge) — see the Agent OS note above | Operator-funded; `MAX_ORDER_USD` caps every order |
| **Watch the demo** | — | — |

Text `START` → `CONNECT` → open the link → pick **Read-only**. You're talking to your own isolated agent (one Durable Object per number). BinaText never sees any keys and no scope it uses can move funds out.

## Why this isn't just an API wrapper

- **Official Binance Agent OS MCP** (`agent.binance.com/mcp/agentic`) — market data + spot only, no withdrawal scope. Full OAuth 2.1 + PKCE + CIMD flow implemented; routed via the bridge until Binance opens third-party registration.
- **Zero LLM in the money path.** `src/trade/policy.ts` is a deterministic BigInt-cents check — hard per-order and daily USD caps + a symbol allowlist — and it runs before *and* again right before every order. The model is never handed a place/cancel/transfer tool; the most it can do is *propose*.
- **Rotating single-use PIN**, 5-minute expiry, locked after 3 wrong tries.
- **Stateful confirmation machine** in a Durable Object per phone number — one pending order at a time, slippage re-checked on confirm.
- **Multi-tenant, self-service** — anyone onboards over SMS in seconds; each user's OAuth tokens and funds are isolated in their own DO.
- **Autonomous price alerts** via DO alarms, with a Cron liveness backstop.
- **Works on a feature phone.** SMS in, SMS out. Nothing else.

## Architecture

```
 sms-gate.app (Android+SIM)     Browser (once)         Cron */5        operator machine
 inbound SMS ─► webhook         /connect ─► pick        alert          claude (Binance-
        │                       access level          backstop        allowlisted MCP client)
        ▼                            │                    │                    │
 ┌──────────────────────────────────────────────────────────────────┐         │
 │  Worker (src/index.ts)  ── routes ──►  TraderAgent DO (per phone) │         │
 │                                        onboarding + confirm FSM   │         │
 │                                        model loop (Groq→WorkersAI)│         │
 │                                        enforceOrderPolicy ◄─ no LLM│        │
 │                                        bridge job queue ──────────┼── poll ─┤
 │                                        alarm(): expiry + alerts   │  result │
 └──────────────────────────────────────────────────────────────────┘         │
                                                                              ▼
                                                     claude -p ──► agent.binance.com/mcp/agentic
                                                     (one constrained MCP call per job)
```

## Live proof

- Deployed Worker: `https://binatext.ibnweb3lab.workers.dev`
- Full SMS loop verified on real hardware: inbound webhook → `TraderAgent` DO → onboarding → reply, delivered
- Live BTC price pulled through Binance Agent OS (`spot_tickerPrice`) and delivered over SMS — see the demo video
- Read-only order flow: `propose_trade` → restatement + rotating PIN → `YES <pin>` → guarded stub

## Repo layout

See [`CLAUDE.md`](./CLAUDE.md) for the annotated tree and dev commands. `bridge/` holds the local Agent OS bridge. Full design: `plans/radiant-toasting-rivest.md`.

## Status

**Done and verified**
- Full Worker — `index.ts` routing, `TraderAgent` + `AlertRegistry` Durable Objects, bridge queue, model loop, SMS adapters, cron backstop. `tsc` clean, `wrangler deploy` live.
- Money-safety guard (`src/trade/policy.ts`) — 32 exhaustive cases green
- PIN + proposal lifecycle (`src/trade/proposals.ts`) — 17 cases green
- Onboarding + confirmation state machine (`src/agent/decide.ts`) — 21 cases green
- **Model reliability** — `openai/gpt-oss-120b` on Groq, 49/50 across the 5 demo intents
- **SMS loop live** on a Samsung A05s + sms-gate.app cloud relay (Nigerian SIM)
- **Binance Agent OS reached** — real `spot_tickerPrice` through the official MCP, over SMS, via the bridge

**Not done yet**
- Direct Worker→Agent OS OAuth (blocked on Binance opening third-party agent registration — CIMD flow is built and reaches consent)
- Real on-chain order in the demo (shown as the read-only stub; `src/trade/execute.ts` has the live path)
- International SMS routing — one Nigerian gateway SIM for now; the `SmsProvider` interface takes a Twilio adapter
- sms-gate.app inbound signature scheme (verification currently off)

## Disclaimers

Not financial advice. You are responsible for every order the agent places on your behalf. See Binance's [Agent OS terms](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic).
