/**
 * The sweep set concurrencyLimit to 15 and 20 and trusted it. But a single
 * queue can never exceed the environment's base concurrency limit, which is
 * 10 runs on the free plan. If that cap was in force, the top rows of the
 * sweep measured 10, not 15 and 20.
 *
 * This reads each run's real startedAt/finishedAt back from the API and counts
 * the most that were ever executing at the same instant.
 *
 *   npm run peak
 */
import { tasks, runs, queues } from "@trigger.dev/sdk";
import { readFileSync } from "node:fs";
import type { enrichCompany } from "../src/trigger/enrich.js";
import type { Company } from "../src/lib/types.js";

const LIMIT = Number(process.env.LIMIT ?? 20);
const N = Number(process.env.N ?? 40);
const OFFSET = Number(process.env.OFFSET ?? 350);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function peakOverlap(iv: ReadonlyArray<readonly [number, number]>) {
  const ev = iv.flatMap(([s, e]) => [[s, 1], [e, -1]] as const);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0, peak = 0;
  for (const [, d] of ev) { now += d; if (now > peak) peak = now; }
  return peak;
}

async function main() {
  if (!process.env.TRIGGER_SECRET_KEY) throw new Error("TRIGGER_SECRET_KEY is not set");
  const all = JSON.parse(readFileSync("data/companies.json", "utf8")) as Company[];
  const companies = all.slice(OFFSET, OFFSET + N);
  if (companies.length < N) throw new Error(`only ${companies.length} companies at offset ${OFFSET}`);

  await queues.overrideConcurrencyLimit({ type: "custom", name: "enrichment" }, LIMIT);
  await sleep(3_000);

  const q = await queues.retrieve({ type: "custom", name: "enrichment" });
  console.log(`queue reports concurrencyLimit ${q.concurrencyLimit}, asked for ${LIMIT}\n`);

  const handles = [];
  for (let i = 0; i < N; i += 20) {
    const chunk = await Promise.all(
      companies.slice(i, i + 20).map((company) =>
        tasks.trigger<typeof enrichCompany>("enrich-company", { company }),
      ),
    );
    handles.push(...chunk);
  }

  const iv: Array<readonly [number, number]> = [];
  for (const h of handles) {
    for (;;) {
      const r = await runs.retrieve(h.id);
      if (r.finishedAt && r.startedAt) {
        iv.push([new Date(r.startedAt).getTime(), new Date(r.finishedAt).getTime()] as const);
        break;
      }
      await sleep(300);
    }
  }

  await queues.resetConcurrencyLimit({ type: "custom", name: "enrichment" });

  const peak = peakOverlap(iv);
  const body = iv.reduce((a, [s, e]) => a + (e - s), 0) / iv.length / 1000;
  console.log(
    `asked for a limit of ${LIMIT}, ${N} runs\n` +
      `  peak actually executing at once: ${peak}\n` +
      `  mean executing time per run:     ${body.toFixed(2)}s\n\n` +
      (peak < LIMIT
        ? `The queue never reached ${LIMIT}. Something above it capped at ${peak}.`
        : `The limit of ${LIMIT} was genuinely reached.`),
  );
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
