/**
 * Builds the company list the pipeline enriches.
 *
 * Source: the Majestic Million — a free, public ranking of the most-referenced
 * domains on the web. No API key, no auth. It stands in for the list of
 * accounts, leads or customers you'd actually be enriching.
 *
 *   npm run seed                    # 500 companies
 *   npm run seed -- --limit 10000
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SOURCE = "https://downloads.majestic.com/majestic_million.csv";

function parseLimit(argv: string[]): number {
  const i = argv.indexOf("--limit");
  if (i === -1) return 500;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--limit expects a positive number, got: ${argv[i + 1]}`);
  }
  return Math.floor(n);
}

async function main() {
  const limit = parseLimit(process.argv.slice(2));
  console.log(`Fetching the top ${limit} domains…`);

  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Majestic Million ${res.status} ${res.statusText}`);
  const csv = await res.text();

  const rows = csv.split("\n").slice(1); // drop the header
  const seen = new Set<string>();
  const companies: Array<{
    id: string;
    domain: string;
    name: string;
    tld: string;
    rank: number;
    /** Stands in for the customer/workspace that owns this record. */
    tenantId: string;
  }> = [];

  for (const row of rows) {
    if (companies.length >= limit) break;
    const cols = row.split(",");
    const rank = Number(cols[0]);
    const domain = cols[2]?.trim();
    const tld = cols[3]?.trim();
    if (!domain || !tld || !Number.isFinite(rank) || seen.has(domain)) continue;
    seen.add(domain);

    companies.push({
      id: domain,
      domain,
      // "google.com" -> "Google". Crude, but it's a display name, not a fact
      // we're asserting — the enrichment call is what returns the real one.
      name: (domain.split(".")[0] ?? domain).replace(/^\w/, (c) => c.toUpperCase()),
      tld,
      rank,
      // Real pipelines are multi-tenant. Bucketing by TLD gives us a handful
      // of tenants with uneven volume, which is what the concurrency-key
      // section needs to demonstrate anything.
      tenantId: `tld_${tld}`,
    });
  }

  const out = resolve("data/companies.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(companies, null, 2));

  const tenants = new Set(companies.map((c) => c.tenantId));
  console.log(`Wrote ${companies.length} companies to ${out}`);
  console.log(`  ${tenants.size} tenants, ranks ${companies[0]?.rank}–${companies.at(-1)?.rank}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
