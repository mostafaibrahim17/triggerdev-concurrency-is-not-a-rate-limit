import {
  schemaTask,
  schedules,
  idempotencyKeys,
  metadata,
  logger,
  BatchTriggerError,
} from "@trigger.dev/sdk";
import { z } from "zod";
import { enrichCompany } from "./enrich.js";
import { Company } from "../lib/types.js";

/**
 * How long an enrichment is considered fresh.
 *
 * This is the single most consequential number in the pipeline, because it's
 * also the idempotency key's TTL. Inside the window, re-triggering a company is
 * free and does nothing. Outside it, the next run pays the vendor again.
 *
 * Thirty days is a judgement about how fast company data goes stale, not a
 * technical constraint — headcount and funding move, domains rarely do.
 */
const FRESH_FOR = "30d";

/**
 * Idempotency key for one company's enrichment.
 *
 * `scope: "global"` is load-bearing. Since SDK 4.3.1 a raw string key defaults
 * to `run` scope, which hashes it together with the parent run id — so every
 * weekly refresh would generate new keys and re-pay for the entire list.
 *
 * What this does NOT do: protect a vendor call that already succeeded inside a
 * run that later threw. Keys deduplicate *triggers*, not attempts. A run that
 * dies after /company and /verify will pay for both again on retry.
 */
async function toBatchItem(company: Company, chaos: boolean) {
  return {
    payload: { company, chaos },
    options: {
      idempotencyKey: await idempotencyKeys.create([company.id, "enrich"], {
        scope: "global" as const,
      }),
      idempotencyKeyTTL: FRESH_FOR,
      tags: [`tenant_${company.tenantId}`],
    },
  };
}

const FanOutPayload = z.object({
  companies: z.array(Company),
  chaos: z.boolean().default(false),
});

/**
 * Fan a list of companies out into one durable run each.
 *
 * The fan-out itself is ingest, not work — it returns in about a second while
 * the children run for as long as the queue's concurrency limit dictates.
 */
export const enrichCompanies = schemaTask({
  id: "enrich-companies",
  schema: FanOutPayload,
  maxDuration: 3_600,
  run: async ({ companies, chaos }) => {
    metadata.set("total", companies.length);
    metadata.set("enriched", 0);
    metadata.set("spentCents", 0);

    logger.info("fanning out", { count: companies.length, chaos });

    // An async generator rather than an array. Items stream to the API as
    // they're produced, so the 1,000-item batch ceiling stops being something
    // you chunk around and memory stays flat at any list size.
    async function* items() {
      for (const company of companies) {
        yield await toBatchItem(company, chaos);
      }
    }

    try {
      const handle = await enrichCompany.batchTrigger(items());
      return { triggered: companies.length, batchId: handle.batchId };
    } catch (error) {
      // Trigger.dev meters its own ingest with a token bucket: on the free
      // plan, 1,200 runs of burst refilling at 100 every 10 seconds.
      if (error instanceof BatchTriggerError && error.isRateLimited) {
        logger.warn("ingest rate limited", { retryAfterMs: error.retryAfterMs });
        await new Promise((r) => setTimeout(r, error.retryAfterMs ?? 10_000));
        const handle = await enrichCompany.batchTrigger(items());
        return { triggered: companies.length, batchId: handle.batchId };
      }
      throw error;
    }
  },
});

/**
 * Re-enrich the whole list every week.
 *
 * This is what turns the project from a one-off backfill into something that
 * has to keep running unattended — and it's where the idempotency TTL earns
 * its place. Every Monday this re-triggers all 10,000 companies, and every
 * company enriched within the last 30 days is skipped without a vendor call.
 * Only the genuinely stale ones cost money.
 *
 * Run it weekly against a 30-day TTL and you refresh roughly a quarter of the
 * list each time, spread evenly, instead of paying for everything at once.
 */
export const weeklyRefresh = schedules.task({
  id: "weekly-company-refresh",
  cron: { pattern: "0 3 * * 1", timezone: "Europe/London" },
  maxDuration: 3_600,
  run: async () => {
    const { readFile } = await import("node:fs/promises");
    const companies = Company.array().parse(
      JSON.parse(await readFile("data/companies.json", "utf8")),
    );

    logger.info("weekly refresh", { count: companies.length });

    const handle = await enrichCompanies.trigger({ companies, chaos: false });
    return { runId: handle.id, considered: companies.length };
  },
});
