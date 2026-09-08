/**
 * AlertRegistry — one global Durable Object.
 *
 * Two jobs:
 *  1. Index of phone hashes with at least one active price alert, so the Cron
 *     backstop knows which TraderAgents to poke (DOs aren't enumerable).
 *  2. New-number rate limiting — caps how many fresh TraderAgent DOs can be
 *     created per hour, so open onboarding can't be used to spin up unbounded
 *     Durable Objects.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./shared/env.ts";
import { int } from "./shared/env.ts";

export class AlertRegistry extends DurableObject<Env> {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS alert_owner (hash TEXT PRIMARY KEY)`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS known_number (hash TEXT PRIMARY KEY, first_seen INTEGER)`);
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS bridge_job (
         id TEXT PRIMARY KEY, op TEXT, args TEXT, status TEXT,
         payload TEXT, created INTEGER, claimed INTEGER)`,
    );
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS bridge_meta (k TEXT PRIMARY KEY, v TEXT)`);
  }

  // ── Binance bridge job queue ───────────────────────────────────────────────
  // The local bridge (bridge/run.mjs) long-polls bridgeClaim(), runs each job as
  // a constrained `claude -p` call against the Binance Agent OS MCP, and reports
  // back via bridgeComplete(). TraderAgents enqueue + poll bridgeGet().

  bridgeEnqueue(op: string, argsJson: string): string {
    const id = crypto.randomUUID();
    this.#sql.exec(
      `INSERT INTO bridge_job (id, op, args, status, payload, created, claimed)
       VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
      id,
      op,
      argsJson,
      Date.now(),
    );
    // keep the table small
    this.#sql.exec(`DELETE FROM bridge_job WHERE created < ?`, Date.now() - 600_000);
    return id;
  }

  bridgeClaim(): { id: string; op: string; args: string } | null {
    this.#sql.exec(
      `INSERT INTO bridge_meta (k, v) VALUES ('last_poll', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      String(Date.now()),
    );
    const row = this.#sql
      .exec<{ id: string; op: string; args: string }>(
        `SELECT id, op, args FROM bridge_job WHERE status = 'pending' ORDER BY created ASC LIMIT 1`,
      )
      .toArray()[0];
    if (!row) return null;
    this.#sql.exec(`UPDATE bridge_job SET status = 'claimed', claimed = ? WHERE id = ?`, Date.now(), row.id);
    return row;
  }

  bridgeComplete(id: string, status: "done" | "error", payloadJson: string): void {
    this.#sql.exec(`UPDATE bridge_job SET status = ?, payload = ? WHERE id = ?`, status, payloadJson, id);
  }

  bridgeGet(id: string): { status: string; payload: string | null } | null {
    return (
      this.#sql
        .exec<{ status: string; payload: string | null }>(
          `SELECT status, payload FROM bridge_job WHERE id = ?`,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  /** Epoch ms of the last bridge poll, or 0 if the bridge has never checked in. */
  bridgeLastPoll(): number {
    const v = this.#sql
      .exec<{ v: string }>(`SELECT v FROM bridge_meta WHERE k = 'last_poll'`)
      .toArray()[0]?.v;
    return v ? Number(v) : 0;
  }

  addAlertOwner(hash: string): void {
    this.#sql.exec(`INSERT OR IGNORE INTO alert_owner (hash) VALUES (?)`, hash);
  }

  removeAlertOwner(hash: string): void {
    this.#sql.exec(`DELETE FROM alert_owner WHERE hash = ?`, hash);
  }

  listAlertOwners(): string[] {
    return this.#sql.exec<{ hash: string }>(`SELECT hash FROM alert_owner`).toArray().map((r) => r.hash);
  }

  /**
   * Record an inbound from `hash`. Returns false when this is a NEW number and
   * the hourly creation budget is spent (caller drops the message).
   */
  admitNumber(hash: string): boolean {
    const known = this.#sql.exec(`SELECT 1 FROM known_number WHERE hash = ?`, hash).toArray().length > 0;
    if (known) return true;

    const cutoff = Date.now() - 3_600_000;
    const recent = this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) n FROM known_number WHERE first_seen > ?`, cutoff)
      .one().n;
    if (recent >= int(this.env.NEW_NUMBERS_PER_HOUR, 30)) return false;

    this.#sql.exec(`INSERT INTO known_number (hash, first_seen) VALUES (?, ?)`, hash, Date.now());
    return true;
  }
}
