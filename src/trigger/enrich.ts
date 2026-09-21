import { schemaTask, metadata, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { enrichmentQueue } from "./queues.js";
import { Company } from "../lib/types.js";
import { enrich } from "../lib/provider.js";

const EnrichPayload = z.object({
  company: Company,
  /** Force the vendor to return 429 so the retry path can be demonstrated. */
  chaos: z.boolean().default(false),
});

/**
 * Enrich exactly one company.
 *
 * One company, one run: it checkpoints, retries on its own schedule, survives a
 * deploy mid-flight, and gets its own row in the dashboard with a full attempt
 * history. Nothing here knows the other 9,999 exist.
 */
export const enrichCompany = schemaTask({
  id: "enrich-company",
  schema: EnrichPayload,
  queue: enrichmentQueue,
  // Attempts of the task. Separate from the retries inside retry.fetch, which
  // absorb a 429 without ever failing the attempt.
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
  maxDuration: 300,
  run: async (payload, { ctx }) => {
    const enrichment = await enrich(payload.company, payload.chaos);

    // Metadata doesn't propagate to children automatically, so this is how a
    // fanned-out child writes back to its parent — but see the README for why
    // the parent may not be around to receive it.
    metadata.parent.increment("enriched", 1);
    metadata.parent.increment("spentCents", Math.round(enrichment.costUSD * 100));

    logger.info("company enriched", {
      domain: payload.company.domain,
      tier: enrichment.tier,
      attempt: ctx.attempt.number,
    });

    return enrichment;
  },
});
