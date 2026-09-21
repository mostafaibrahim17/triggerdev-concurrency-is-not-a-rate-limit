import { retry, AbortTaskRunError, logger } from "@trigger.dev/sdk";
import type { Company, Enrichment } from "./types.js";

/**
 * The 429 policy, shared by every call to the vendor.
 *
 * Three things about the `headers` strategy that the docs don't spell out, all
 * verified against SDK 4.5.10:
 *
 *   - Only `resetHeader` is read. `limitHeader` and `remainingHeader` are
 *     required by the schema and then never consulted.
 *   - The value is parsed per `resetFormat` and handed to `wait.until()`.
 *     `unix_timestamp` means seconds-since-epoch, so pointing it at a
 *     delta-seconds header like `Retry-After: 5` resolves to 1970 — a date in
 *     the past — and the retry fires immediately, hammering the vendor.
 *   - It caps at 10 attempts internally, whatever you configure.
 */
const RETRY_POLICY = {
  byStatus: {
    "429": {
      strategy: "headers" as const,
      limitHeader: "x-ratelimit-limit",
      remainingHeader: "x-ratelimit-remaining",
      resetHeader: "x-ratelimit-reset",
      resetFormat: "unix_timestamp_in_ms" as const,
    },
    "500-599": {
      strategy: "backoff" as const,
      maxAttempts: 5,
      factor: 2,
      minTimeoutInMs: 500,
      maxTimeoutInMs: 30_000,
      randomize: true,
    },
  },
};

/** One billed call to the vendor. */
async function call<T>(path: string, company: Company, chaos: boolean): Promise<[T, number]> {
  const base = process.env.MOCK_API_URL ?? "http://localhost:7788";
  const response = await retry.fetch(`${base}${path}${chaos ? "?chaos=1" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain: company.domain }),
    retry: RETRY_POLICY,
  });

  // retry.fetch hands back the failed Response once it's out of attempts — it
  // does not throw. Without this check a run that never succeeded would be
  // recorded as a success carrying garbage.
  if (!response.ok) {
    throw new Error(`vendor ${path} returned ${response.status} after retries`);
  }

  const charged = Number(response.headers.get("x-charged-usd") ?? 0);
  return [(await response.json()) as T, charged];
}

/**
 * Enrich one company. Three billed calls, one after another.
 *
 * This is the unit that has to be idempotent. If the run dies after `/company`
 * and `/verify` but before `/score`, a retry pays for the first two again —
 * which is why the article is careful about what idempotency keys do and don't
 * protect.
 */
export async function enrich(company: Company, chaos = false): Promise<Enrichment> {
  if ((process.env.ENRICH_PROVIDER ?? "mock") === "anthropic") {
    throw new AbortTaskRunError(
      "the anthropic provider was removed when this became a vendor-enrichment pipeline",
    );
  }

  const [profile, c1] = await call<{
    employees: number;
    industry: string;
    founded: number;
    country: string;
  }>("/company", company, chaos);

  const [contact, c2] = await call<{ email: string; deliverable: boolean }>(
    "/verify",
    company,
    chaos,
  );

  const [lead, c3] = await call<{ score: number; tier: "hot" | "warm" | "cold" }>(
    "/score",
    company,
    chaos,
  );

  const costUSD = Number((c1 + c2 + c3).toFixed(2));
  logger.info("enriched", { domain: company.domain, costUSD });

  return {
    domain: company.domain,
    ...profile,
    email: contact.email,
    deliverable: contact.deliverable,
    score: lead.score,
    tier: lead.tier,
    costUSD,
    provider: "mock",
  };
}
