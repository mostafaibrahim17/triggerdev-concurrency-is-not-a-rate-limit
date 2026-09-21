import { queue } from "@trigger.dev/sdk";

/**
 * How many enrichment calls may be in flight at once.
 *
 * This is the preventive layer. It is NOT a rate limit — Trigger.dev has no
 * requests-per-second primitive, and `concurrencyLimit` caps *simultaneous
 * runs*, not the rate at which they start. You convert one into the other with
 * Little's Law:
 *
 *     concurrency ≈ arrival rate × time in system
 *
 * Both terms have to be in the same currency, and the queue counts RUNS, so
 * the vendor's request rate has to be divided by calls-per-run first. Two
 * traps, and this comment got both wrong before they were measured:
 *
 *   1. The time term is not the API's response time, it's how long the run
 *      holds the slot. Measured over 8 uncontended enrich-company runs in DEV:
 *
 *          three vendor calls ............. 1.80s
 *          slot held, created to finished . 3.41s
 *          everything else ................ 1.61s
 *
 *   2. The rate term is in runs, not requests. Against a 5 req/s vendor at
 *      three calls per run, runs may arrive at 5 / 3 = 1.67 per second.
 *
 * So the honest sum is 1.67 × 3.41 ≈ 6 concurrent runs. Measured throughput
 * stops improving at 7, so 6 is about right. See `npm run experiment`.
 * At the limit of 2 below we measured ~1.65 req/s, a third of what the API
 * allows. That's deliberate for a tutorial you run locally, not a recommended
 * production value.
 *
 * Measure your own before raising it. Run overhead varies by environment, and
 * DEV proxies everything through your own machine, so its numbers are not
 * production's.
 */
export const enrichmentQueue = queue({
  name: "enrichment",
  concurrencyLimit: 2,
});

/**
 * A second queue, used only by the per-tenant example.
 *
 * Read the warning in src/trigger/enrich.ts before reaching for `concurrencyKey`:
 * each distinct key value gets its own copy of the queue *at the full limit*,
 * so keys multiply your downstream load rather than dividing it.
 */
export const perTenantQueue = queue({
  name: "enrichment-per-tenant",
  concurrencyLimit: 1,
});
