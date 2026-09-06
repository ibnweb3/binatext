/**
 * Cron entry (every 5 minutes) — liveness backstop for price alerts.
 *
 * DO alarms are the primary poll mechanism; this catches a TraderAgent whose
 * alarm silently lapsed (e.g. after an eviction edge case). `pollAlertsNow()`
 * is idempotent and re-arms the alarm.
 */

import { getAgentByName } from "agents";
import type { Env } from "./shared/env.ts";
import type { TraderAgent } from "./agent.ts";

export const scheduled: ExportedHandlerScheduledHandler<Env> = async (_event, env, ctx) => {
  const registry = env.AlertRegistry.get(env.AlertRegistry.idFromName("global")) as unknown as {
    listAlertOwners(): string[] | Promise<string[]>;
  };
  const hashes = await registry.listAlertOwners();

  for (const hash of hashes) {
    ctx.waitUntil(
      getAgentByName<Env, TraderAgent>(env.TraderAgent, hash)
        .then((a) => a.pollAlertsNow())
        .catch((err) => console.error(`[cron] pollAlertsNow(${hash.slice(0, 8)}) failed: ${(err as Error).message}`)),
    );
  }
};
