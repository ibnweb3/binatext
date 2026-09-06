/**
 * Phase 0 spike — textbee.dev inbound + outbound.
 *
 *   npx tsx scripts/spike-textbee.ts serve            # log inbound webhooks (expose via a tunnel)
 *   npx tsx scripts/spike-textbee.ts send +234... "hi" # send one SMS via the device API
 *
 * Env: TEXTBEE_API_KEY, TEXTBEE_DEVICE_ID, TEXTBEE_WEBHOOK_SECRET (optional).
 *
 * Goal: capture the real inbound JSON shape + signature header, and confirm the
 * send path, then port the exact details into src/sms/textbee.ts (SPIKE markers).
 */

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const API_BASE = "https://api.textbee.dev/api/v1";
const [, , cmd, ...rest] = process.argv;

async function send(to: string, message: string) {
  const key = process.env.TEXTBEE_API_KEY;
  const device = process.env.TEXTBEE_DEVICE_ID;
  if (!key || !device) throw new Error("Set TEXTBEE_API_KEY and TEXTBEE_DEVICE_ID.");

  const url = `${API_BASE}/gateway/devices/${device}/send-sms`;
  console.log(`POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ recipients: [to], message }),
  });
  console.log(`${res.status} ${res.statusText}`);
  console.log(await res.text());
}

function serve() {
  const secret = process.env.TEXTBEE_WEBHOOK_SECRET;
  const port = Number(process.env.PORT ?? 8787);

  createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      console.log(`\n── ${req.method} ${req.url} ──`);
      console.log("headers:", JSON.stringify(req.headers, null, 2));
      console.log("body:", raw);

      if (secret) {
        const sig = (req.headers["x-signature"] ?? req.headers["x-textbee-signature"]) as string | undefined;
        const want = createHmac("sha256", secret).update(raw).digest("hex");
        const ok =
          !!sig &&
          sig.length === want.length &&
          timingSafeEqual(Buffer.from(sig), Buffer.from(want));
        console.log(`signature: got=${sig ?? "(none)"} want=${want} -> ${ok ? "VALID" : "INVALID"}`);
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  }).listen(port, () => {
    console.log(`listening on :${port} — expose with:  cloudflared tunnel --url http://localhost:${port}`);
    console.log("then set that URL as the textbee webhook for event sms:received");
  });
}

if (cmd === "send") {
  const [to, ...msg] = rest;
  if (!to || msg.length === 0) {
    console.error('usage: spike-textbee.ts send +234XXXXXXXXXX "message"');
    process.exit(1);
  }
  send(to, msg.join(" ")).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === "serve") {
  serve();
} else {
  console.error("usage: spike-textbee.ts <serve|send>");
  process.exit(1);
}
