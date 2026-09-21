/**
 * Triggers the pipeline from outside Trigger.dev — the way your own backend
 * would.
 *
 * Usage:
 *   npm run trigger                        # all seeded records, streamed
 *   npm run trigger -- --limit 50          # just the first 50
 *   npm run trigger -- --chaos             # force the API to return 429s
 *   npm run trigger -- --mode chunked      # use chunked batchTrigger instead
 *   npm run trigger -- --watch             # follow progress until it finishes
 *
 * Needs TRIGGER_SECRET_KEY in the environment (the dev server prints one, or
 * copy it from the dashboard).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tasks, runs } from "@trigger.dev/sdk";
import type { enrichCompanies } from "../src/trigger/fanout.js";
import type { Company } from "../src/lib/types.js";

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}
function value(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  if (!process.env.TRIGGER_SECRET_KEY) {
    throw new Error("TRIGGER_SECRET_KEY is not set");
  }

  const path = resolve("data/companies.json");
  const all = JSON.parse(await readFile(path, "utf8")) as Company[];
  const limit = Number(value("limit", String(all.length)));
  // Idempotency keys are global and live for 24h, so re-running the same
  // records is a no-op. Use --offset to reach for records you haven't
  // enriched yet.
  const offset = Number(value("offset", "0"));
  const records = all.slice(offset, offset + limit);

  const mode = (value("mode", "streamed") ?? "streamed") as "streamed" | "chunked";
  const chaos = flag("chaos");

  console.log(`Triggering ${records.length} records (mode=${mode}, chaos=${chaos})`);

  // A type-only import of the task keeps the task code out of this bundle —
  // the pattern you want when triggering from an app that shouldn't ship your
  // whole trigger directory.
  const handle = await tasks.trigger<typeof enrichCompanies>(
    "enrich-companies",
    { companies: records, chaos },
  );

  console.log(`Run: ${handle.id}`);

  if (!flag("watch")) return;

  const started = Date.now();
  for await (const run of runs.subscribeToRun<typeof enrichCompanies>(handle.id)) {
    const md = (run.metadata ?? {}) as { enriched?: number; total?: number };
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(
      `  ${run.status}  ${md.enriched ?? 0}/${md.total ?? records.length}  ${elapsed}s   \r`,
    );
    if (run.finishedAt) {
      process.stdout.write("\n");
      console.log(`Finished in ${elapsed}s:`, JSON.stringify(run.output));
      break;
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
