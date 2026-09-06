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
