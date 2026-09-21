/**
 * How long does one enrich-company run actually hold its concurrency slot?
 *
 * The sizing argument needs this number and nothing in the repo measured it.
 * Little's Law wants time-in-system, so this reads each run's real startedAt
 * and finishedAt back from the API rather than timing the batch from outside.
 *
 * Run at concurrency 1 so the number is uncontended: under load W rises, and
 * that is a different measurement.
 *
 *   npm run runwall
 */
import { tasks, runs, queues } from "@trigger.dev/sdk";
import { readFileSync } from "node:fs";
import type { enrichCompany } from "../src/trigger/enrich.js";
import type { Company } from "../src/lib/types.js";

const N = Number(process.env.N ?? 6);
const OFFSET = Number(process.env.OFFSET ?? 980);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!process.env.TRIGGER_SECRET_KEY) throw new Error("TRIGGER_SECRET_KEY is not set");

  const all = JSON.parse(readFileSync("data/companies.json", "utf8")) as Company[];
  const companies = all.slice(OFFSET, OFFSET + N);
  if (companies.length < N) throw new Error(`only ${companies.length} companies at offset ${OFFSET}`);

  await queues.overrideConcurrencyLimit({ type: "custom", name: "enrichment" }, 1);
  await sleep(3_000);

  const rows: Array<{ wall: number; body: number }> = [];
  for (const company of companies) {
    const h = await tasks.trigger<typeof enrichCompany>("enrich-company", { company });
    for (;;) {
      const r = await runs.retrieve(h.id);
      if (r.finishedAt && r.startedAt) {
        // createdAt -> finishedAt is what the queue slot is occupied for.
        const wall = (new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime()) / 1000;
        const body = (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000;
        rows.push({ wall, body });
        console.log(`  ${company.domain.padEnd(24)} slot ${wall.toFixed(2)}s   executing ${body.toFixed(2)}s`);
        break;
      }
      await sleep(250);
    }
  }

  await queues.resetConcurrencyLimit({ type: "custom", name: "enrichment" });

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const wall = mean(rows.map((r) => r.wall));
  const body = mean(rows.map((r) => r.body));
  const vendor = 3 * Number(process.env.LATENCY_MS ?? 600) / 1000;

  console.log(
    `\nover ${rows.length} uncontended runs:` +
      `\n  vendor work (3 calls, configured)  ${vendor.toFixed(2)}s` +
      `\n  executing                          ${body.toFixed(2)}s` +
      `\n  slot held, created to finished     ${wall.toFixed(2)}s` +
      `\n  platform overhead                  ${(wall - vendor).toFixed(2)}s` +
      `\n\nLittle's Law: (5 req/s / 3 calls) x ${wall.toFixed(2)}s = ${((5 / 3) * wall).toFixed(1)} concurrent runs`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
