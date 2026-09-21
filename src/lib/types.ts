import { z } from "zod";

/** One row of the company list produced by scripts/seed.ts. */
export const Company = z.object({
  id: z.string(),
  domain: z.string(),
  name: z.string(),
  tld: z.string(),
  rank: z.number(),
  /** Stands in for the customer/workspace that owns this record. */
  tenantId: z.string(),
});
export type Company = z.infer<typeof Company>;

/**
 * What one enriched company looks like once all three vendor calls are in.
 *
 * `costUSD` is carried through deliberately — it's what makes double-paying
 * visible instead of theoretical.
 */
export const Enrichment = z.object({
  domain: z.string(),
  employees: z.number(),
  industry: z.string(),
  founded: z.number(),
  country: z.string(),
  email: z.string(),
  deliverable: z.boolean(),
  score: z.number(),
  tier: z.enum(["hot", "warm", "cold"]),
  costUSD: z.number(),
  provider: z.enum(["mock", "anthropic"]),
});
export type Enrichment = z.infer<typeof Enrichment>;
