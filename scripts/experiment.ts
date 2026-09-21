/**
 * Measures actual throughput at a range of concurrency limits, so the
 * Little's Law prediction can be checked against reality.
 *
 * For each limit it overrides the queue at runtime, triggers a fresh block of
 * companies, waits for the vendor's counters to settle, and records how long
 * the work actually took.
 *
 *   npm run experiment
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tasks, runs, queues } from "@trigger.dev/sdk";
import type { enrichCompanies } from "../src/trigger/fanout.js";
import type { Company } from "../src/lib/types.js";

const LIMITS = [1, 2, 3, 5, 7, 10, 15, 20];
/** One run per setting can't tell a real turndown from noise. Three can. */
const REPEATS = Number(process.env.REPEATS ?? 3);
const PER_RUN = 20;
/**
 * Every company carries a 30-day global idempotency key, so re-running a sweep
 * over companies a previous sweep already enriched silently dedupes the
 * triggers and measures nothing. Each sweep needs company ids no earlier run
 * has touched. Burned so far: 0-12, 200-203, 250-349.
 */
const START_OFFSET = Number(process.env.START_OFFSET ?? 500);
const MOCK = process.env.MOCK_API_URL ?? "http://localhost:7788";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stats() {
  const r = await fetch(`${MOCK}/stats`);
  return (await r.json()) as { served: number; rejected: number; spendUSD: number };
}

async function main() {
  if (!process.env.TRIGGER_SECRET_KEY) throw new Error("TRIGGER_SECRET_KEY is not set");

  const all = JSON.parse(
    await readFile(resolve("data/companies.json"), "utf8"),
  ) as Company[];

  const results: Array<{
    limit: number;
    seconds: number;
    actual: number;
    lo: number;
    hi: number;
    predicted: number;
    runWall: number;
  }> = [];

  let slot = 0; // walks the company list so no two sweeps share ids
  for (const limit of LIMITS) {
   const perLimit: number[] = [];
   for (let rep = 0; rep < REPEATS; rep++) {
    await queues.overrideConcurrencyLimit({ type: "custom", name: "enrichment" }, limit);
    // Give the queue a moment to pick up the new limit.
    await sleep(3_000);

    const offset = START_OFFSET + slot++ * PER_RUN;
    const companies = all.slice(offset, offset + PER_RUN);
    if (companies.length < PER_RUN) throw new Error(`ran out of companies at offset ${offset}, seed more`);

    const before = await stats();
    const t0 = Date.now();

    const handle = await tasks.trigger<typeof enrichCompanies>("enrich-companies", {
      companies,
      chaos: false,
    });

    // Each company is 3 vendor calls. Wait until they've all landed.
    const target = before.served + companies.length * 3;
    let last = before.served;
    let idleTicks = 0;
    while (true) {
      await sleep(2_000);
      const now = await stats();
      if (now.served >= target) break;
      if (now.served === last && ++idleTicks > 45) break; // 90s with no progress
      if (now.served !== last) idleTicks = 0;
      last = now.served;
    }

    const seconds = (Date.now() - t0) / 1000;
    const after = await stats();
    const calls = after.served - before.served;
    const actual = calls / 3 / seconds; // companies per second

    perLimit.push(actual);

    const done = calls / 3;
    if (done < companies.length) {
      console.log(
        `  !! limit ${limit} rep ${rep + 1}: only ${done.toFixed(0)}/${companies.length} companies completed. ` +
          `Dropping this sweep rather than reporting a partial as a throughput number.`,
      );
      continue;
    }

    console.log(
      `limit ${String(limit).padStart(2)} rep ${rep + 1}/${REPEATS}  ${seconds.toFixed(1).padStart(6)}s  ` +
        `${(calls / 3).toFixed(0)}/${companies.length} companies  ` +
        `${actual.toFixed(2)} companies/s  ${(actual * 3).toFixed(2)} req/s  ` +
        `run=${handle.id}`,
    );
   }

   if (!perLimit.length) {
     console.log(`  -> limit ${limit}: no complete sweeps, skipping\n`);
     continue;
   }
   // Median resists a single slow sweep in a way the mean does not.
   const sorted = [...perLimit].sort((a, b) => a - b);
   const median = sorted[Math.floor(sorted.length / 2)];
   // Keep full precision here. Rounding before the x3 made the summary
   // disagree with the per-rep lines printed above it.
   results.push({
     limit,
     seconds: 0,
     actual: median,
     lo: Math.min(...perLimit),
     hi: Math.max(...perLimit),
     predicted: 0,
     runWall: 0,
   });
   console.log(
     `  -> limit ${limit}: median ${(median * 3).toFixed(2)} req/s ` +
       `(range ${(Math.min(...perLimit) * 3).toFixed(2)} to ${(Math.max(...perLimit) * 3).toFixed(2)})\n`,
   );
  }

  await queues.resetConcurrencyLimit({ type: "custom", name: "enrichment" });

  console.log("\n=== summary ===");
  console.log(`limit | median req/s | range (${REPEATS} sweeps) | implied run wall time`);
  for (const r of results) {
    // Little's Law rearranged: run wall time = concurrency / throughput
    const implied = r.limit / r.actual;
    console.log(
      `${String(r.limit).padStart(5)} | ${(r.actual * 3).toFixed(2).padStart(12)} | ` +
        `${(r.lo * 3).toFixed(2)} to ${(r.hi * 3).toFixed(2)}`.padStart(20) +
        ` | ${implied.toFixed(2)}s`,
    );
  }
  const best = results.reduce((a, b) => (b.actual > a.actual ? b : a));
  const overlap = results.filter((r) => r.limit !== best.limit && r.hi >= best.lo);
  console.log(
    `\npeak at limit ${best.limit}. ` +
      (overlap.length
        ? `Ranges overlap with ${overlap.map((r) => r.limit).join(", ")}, so the peak is not clean.`
        : `No other limit's range reaches it, so the peak is real.`),
  );
  console.log(
    "\nIf run wall time is constant, Little's Law holds and throughput scales linearly.",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
