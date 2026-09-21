/**
 * A stand-in for a paid, rate-limited data-enrichment vendor.
 *
 * Three endpoints, because real enrichment is rarely one call:
 *
 *   POST /company    look up a company by domain      ($0.10 / call)
 *   POST /verify     verify a contact email           ($0.02 / call)
 *   POST /score      score the lead                   ($0.05 / call)
 *
 * It enforces one shared rate limit across all three, the way a vendor's
 * per-account limit works, and it bills you — so re-running work you've
 * already paid for shows up as a number.
 *
 *   npm run mock-api
 *
 * Env: PORT=7788  RATE=5  BURST=5  LATENCY_MS=600
 * Query: ?chaos=1 to force a 429 regardless of the bucket
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 7788);
const RATE = Number(process.env.RATE ?? 5);
const BURST = Number(process.env.BURST ?? 5);
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 600);

const PRICE: Record<string, number> = {
  "/company": 0.1,
  "/verify": 0.02,
  "/score": 0.05,
};

let tokens = BURST;
let lastRefill = Date.now();

function takeToken(): boolean {
  const now = Date.now();
  tokens = Math.min(BURST, tokens + ((now - lastRefill) / 1000) * RATE);
  lastRefill = now;
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

function resetAt(): number {
  return Date.now() + Math.ceil((Math.max(0, 1 - tokens) / RATE) * 1000);
}

const INDUSTRIES = ["software", "media", "retail", "finance", "education", "infrastructure"];

let served = 0;
let rejected = 0;
let billedCents = 0;
const callsByEndpoint: Record<string, number> = {};

/** Deterministic pseudo-data so the same domain always enriches the same way. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        served,
        rejected,
        spendUSD: Number((billedCents / 100).toFixed(2)),
        callsByEndpoint,
        tokens: Number(tokens.toFixed(2)),
        rate: RATE,
      }),
    );
    return;
  }

  const price = PRICE[url.pathname];
  if (price === undefined || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  const allowed = takeToken() && url.searchParams.get("chaos") !== "1";
  // ?resetIn=20000 pushes the reset timestamp further out, so a caller that
  // honours the reset header backs off for a known, observable length of time.
  const forcedResetIn = Number(url.searchParams.get("resetIn") ?? 0);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-ratelimit-limit": String(BURST),
    "x-ratelimit-remaining": String(Math.max(0, Math.floor(tokens))),
    // Absolute unix ms — the format retry.fetch's headers strategy parses.
    "x-ratelimit-reset": String(forcedResetIn > 0 ? Date.now() + forcedResetIn : resetAt()),
  };

  if (!allowed) {
    rejected++;
    headers["retry-after"] = String(Math.max(1, Math.ceil((resetAt() - Date.now()) / 1000)));
    res.writeHead(429, headers);
    res.end(JSON.stringify({ error: "rate_limit_exceeded" }));
    return;
  }

  const body = await readJson(req);
  await sleep(LATENCY_MS);

  served++;
  billedCents += price * 100;
  callsByEndpoint[url.pathname] = (callsByEndpoint[url.pathname] ?? 0) + 1;

  const domain: string = body?.domain ?? "unknown.com";
  const h = hash(domain);

  headers["x-charged-usd"] = price.toFixed(2);
  res.writeHead(200, headers);

  if (url.pathname === "/company") {
    res.end(
      JSON.stringify({
        domain,
        employees: 20 + (h % 40_000),
        industry: INDUSTRIES[h % INDUSTRIES.length],
        founded: 1970 + (h % 55),
        country: ["US", "GB", "DE", "IN", "BR"][h % 5],
      }),
    );
  } else if (url.pathname === "/verify") {
    res.end(
      JSON.stringify({
        email: `contact@${domain}`,
        deliverable: h % 10 !== 0,
        role: h % 3 === 0 ? "engineering" : "commercial",
      }),
    );
  } else {
    res.end(
      JSON.stringify({
        score: h % 100,
        tier: (h % 100) > 70 ? "hot" : (h % 100) > 35 ? "warm" : "cold",
      }),
    );
  }
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

server.listen(PORT, () => {
  console.log(
    `mock enrichment vendor on http://localhost:${PORT} ` +
      `(${RATE} req/s shared, ${LATENCY_MS}ms latency)`,
  );
  console.log("  POST /company  $0.10   POST /verify  $0.02   POST /score  $0.05");
  console.log("  GET  /stats    calls, rejections and spend so far");
});
