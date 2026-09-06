# BinaText

**Trade your Binance account by text message. No app, no smartphone, no API keys on your device — and hard spend limits the agent physically cannot exceed.**

Built for the [Binance Agent OS Mini Hackathon](https://www.binance.com/en/blog/community/8802181509900814931) (Track A). Runs on Cloudflare Workers + Durable Objects on free tiers.

> **Try it:** text `START` to **`+___________`** _(number goes live with the demo)_ and connect your own Binance in ~20 seconds.

## The problem

Every trading bot wants the same thing: full API-key access to your account, usually including withdrawal, running on a server you have to trust. And you need a smartphone with the app to do anything.

BinaText is the opposite. You text it in plain language. It connects to Binance through the **official Binance Agent OS MCP server** using OAuth — scoped to a dedicated Agentic sub-account, under permissions where **withdrawal is not an option that exists**. Every order is restated back to you and waits for a one-time PIN before it touches a cent.

## What it does

1. **Market Q&A** — _"what's BTC doing?"_ → live price + 24h from Binance.
2. **Portfolio** — _"how am I positioned?"_ → your Agentic sub-account balances.
3. **Natural-language orders** — _"put $5 into BNB"_ → the agent restates the order and texts you `Reply YES 4821 to confirm`. Nothing executes without it.
4. **Standing price alerts** — _"tell me if SOL drops under 140"_ → an SMS when it does.
5. **`STOP`** — cancels all open orders immediately.

## Try it yourself

| Path | You need | Deposit? |
|---|---|---|
| **Read-only** _(recommended for judges)_ | Your own Binance account | **None** — full experience, the execute step is stubbed |
| **Full** | Your own Binance account + a funded Agentic sub-account | Your own, any amount (`MAX_ORDER_USD` caps it) |
| **Watch the demo** | — | — |

Text `START`, open the link, pick an access level, approve on Binance. You're talking to your own isolated agent — BinaText never sees your keys and can't move funds out.

## Why this isn't just an API wrapper

- **Official Binance Agent OS MCP**, OAuth 2.1 + PKCE, per-user Agentic sub-account. No API keys stored anywhere. No withdrawal scope exists.
- **Zero LLM in the money path.** `src/trade/policy.ts` is a deterministic BigInt-cents check — hard per-order and daily USD caps + a symbol allowlist — and it runs before *and* again right before every order. The model is never handed a place/cancel/transfer tool; the most it can do is *propose*.
- **Rotating single-use PIN**, 5-minute expiry, locked after 3 wrong tries.
- **Stateful confirmation machine** in a Durable Object per phone number — one pending order at a time, slippage re-checked on confirm.
- **Multi-tenant, self-service** — anyone onboards over SMS in seconds; each user's OAuth tokens and funds are isolated in their own DO.
- **Autonomous price alerts** via DO alarms, with a Cron liveness backstop.
- **Works on a feature phone.** SMS in, SMS out. Nothing else.

## Architecture

```
 textbee.dev (Android+SIM)      Browser (once)            Cron */5
 inbound SMS ─► webhook         /connect ─► Binance       alert backstop
        │                        OAuth consent                │
        ▼                            │                        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  Worker (src/index.ts)  ── routes ──►  TraderAgent DO (per phone) │
 │                                        onboarding + confirm FSM   │
 │                                        model loop (Groq→WorkersAI)│
 │                                        enforceOrderPolicy ◄─ no LLM│
 │                                        this.mcp ──────────────────┼──► agent.binance.com/mcp/agentic
 │                                        alarm(): expiry + alerts   │       (Agentic sub-account,
 └──────────────────────────────────────────────────────────────────┘        no withdrawal scope)
```

## Live proof

<!-- filled in from the Day 2 demo dry-run -->
- Deployed Worker: `https://binatext.___.workers.dev`
- Real order id + response: _(pending)_
- SMS thread: _(pending)_

## Repo layout

See [`CLAUDE.md`](./CLAUDE.md) for the annotated tree and dev commands. Full design: `plans/radiant-toasting-rivest.md`.

## Status

**Done and verified**
- Money-safety guard (`src/trade/policy.ts`) — 32 exhaustive cases green
- PIN + proposal lifecycle (`src/trade/proposals.ts`) — 17 cases green
- SMS provider interface + textbee / Twilio adapters
- Model fallback chain (Groq → Workers AI → Anthropic)
- **Phase 0 · model reliability** — `openai/gpt-oss-120b` on Groq, 49/50 across the 5 demo intents

**Not done yet**
- Phase 0 spikes (Binance MCP OAuth from a Worker; one real trade; textbee wire shapes)
- `TraderAgent` DO, `/connect` onboarding, MCP wiring, alerts, `STOP`
- Deploy + demo

## Disclaimers

Not financial advice. You are responsible for every order the agent places on your behalf. See Binance's [Agent OS terms](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic).
