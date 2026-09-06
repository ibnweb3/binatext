/**
 * Phase 0 spike — SMS Gateway for Android (sms-gate.app) inbound + outbound.
 *
 *   npx tsx scripts/spike-smsgate.ts serve             # log inbound webhooks (expose via a tunnel)
 *   npx tsx scripts/spike-smsgate.ts send +234... "hi"  # send one SMS via the cloud API
 *
 * Env: SMSGATE_USERNAME, SMSGATE_PASSWORD, SMSGATE_WEBHOOK_SECRET (optional).
 *
 * Goal: capture the real inbound JSON shape + signature headers, and confirm
 * the send path, then port the exact details into src/sms/smsgate.ts (SPIKE:).
 */

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const API_BASE = "https://api.sms-gate.app/3rdparty/v1";
const [, , cmd, ...rest] = process.argv;

async function send(to: string, message: string) {
  const user = process.env.SMSGATE_USERNAME;
  const pass = process.env.SMSGATE_PASSWORD;
  if (!user || !pass) throw new Error("Set SMSGATE_USERNAME and SMSGATE_PASSWORD (created in the app).");

  const url = `${API_BASE}/messages`;
  console.log(`POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message, phoneNumbers: [to] }),
  });
  console.log(`${res.status} ${res.statusText}`);
  console.log(await res.text());
}

function serve() {
  const secret = process.env.SMSGATE_WEBHOOK_SECRET;
  const port = Number(process.env.PORT ?? 8787);

  createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      console.log(`\n── ${req.method} ${req.url} ──`);
      console.log("headers:", JSON.stringify(req.headers, null, 2));
      console.log("body:", raw);

      if (secret) {
        const sig = req.headers["x-signature"] as string | undefined;
        const ts = (req.headers["x-timestamp"] as string | undefined) ?? "";
        // Try a few candidate signed-values; whichever matches is the real one.
        for (const [label, data] of [
          ["ts+body", ts + raw],
          ["body", raw],
          ["body+ts", raw + ts],
        ] as const) {
          const want = createHmac("sha256", secret).update(data).digest("hex");
          const ok =
            !!sig && sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
          console.log(`sig(${label}): ${ok ? "MATCH ✓" : "no"}  want=${want}`);
        }
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  }).listen(port, () => {
    console.log(`listening on :${port} — expose with:  cloudflared tunnel --url http://localhost:${port}`);
    console.log("then register that URL as a webhook for event sms:received:");
    console.log(`  curl -u "$SMSGATE_USERNAME:$SMSGATE_PASSWORD" -X POST ${API_BASE}/webhooks \\`);
    console.log(`    -H 'content-type: application/json' -d '{"url":"https://<tunnel>/","event":"sms:received"}'`);
  });
}

if (cmd === "send") {
  const [to, ...msg] = rest;
  if (!to || msg.length === 0) {
    console.error('usage: spike-smsgate.ts send +234XXXXXXXXXX "message"');
    process.exit(1);
  }
  send(to, msg.join(" ")).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === "serve") {
  serve();
} else {
  console.error("usage: spike-smsgate.ts <serve|send>");
  process.exit(1);
}
