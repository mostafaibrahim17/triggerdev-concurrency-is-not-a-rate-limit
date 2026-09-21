---
title: "How to run 10,000 API lookups against a vendor that allows 5 per second"
slug: rate-limited-enrichment
description: "Look up a company list through a paid data vendor without going over their rate limit or paying twice. Uses a concurrency-limited queue, 429-aware retries, and idempotency keys with a freshness window."
---

## What you'll build

In this tutorial you'll build a Trigger.dev pipeline that looks up a list of companies through a paid data vendor, three billed calls each, using a [concurrency-limited queue](https://trigger.dev/docs/queue-concurrency) to stay under the vendor's rate limit, [`retry.fetch`](https://trigger.dev/docs/errors-retrying) to handle the 429s that get through, [idempotency keys](https://trigger.dev/docs/idempotency) so the weekly re-check never pays for data you already have, and a [scheduled task](https://trigger.dev/docs/tasks/scheduled) to keep it up to date.

## Before you begin…

Two things to know first.

**`concurrencyLimit` is not a rate limit.** It caps how many runs go at once, not how fast they start. Trigger.dev has no requests-per-second setting at all.

**And this is only worth it as production infrastructure.** For a one-off backfill on your laptop, a script with `p-limit` and a JSON checkpoint file is the right answer. What follows is for the version that runs every week on its own, where someone has to answer "which of these failed, and why?"

## Prerequisites

- Create a [Trigger.dev account](https://cloud.trigger.dev/) and set up a [new project](https://trigger.dev/docs/quick-start)
- Install Node.js 20 or later
- Clone the [companion repo](https://github.com/mostafaibrahim17/triggerdev-concurrency-is-not-a-rate-limit), which includes a mock vendor API that rate-limits and bills you

```bash
git clone https://github.com/mostafaibrahim17/triggerdev-concurrency-is-not-a-rate-limit.git
cd durable-enrichment-pipeline
npm install
npm run seed
```

`seed` pulls 500 real company domains from the [Majestic Million](https://majestic.com/reports/majestic-million). Free, public, no key.

### Warning

Every company costs three billed calls. At the mock's prices that's **$0.17 each**, so 10,000 companies is **$1,700** of vendor spend plus 10,000 runs of compute. Start with the default 500.

## Configure your environment variables

```bash
cp .env.example .env
```

```text .env
TRIGGER_PROJECT_REF="<your project ref>"
# From Dashboard -> your project -> API keys. The scripts need this to
# trigger runs; the CLI does not, which is an easy thing to get stuck on.
TRIGGER_SECRET_KEY="tr_dev_..."
MOCK_API_URL="http://localhost:7788"
```

Retries are off in `DEV` by default, which would hide every 429 this tutorial is about. Turn them on:

```ts trigger.config.ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: {
    // The CLI sets this to false. Leave it off and you'll never see a retry.
    enabledInDev: true,
    default: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000 },
  },
});
```

`maxDuration` is required by the config type as of SDK 4.5.10, even though the docs say it's optional.

## Size your queue

Queues have to be defined ahead of time in your trigger folder. You can't create one at trigger time any more.

To pick the number, use Little's Law: `concurrency ≈ arrival rate × time in system`.

Two things have to line up, and each one is a trap.

**The time term is not the vendor's response time.** The slot isn't held for the HTTP call, it's held for the whole run. Measured across 8 uncontended runs, read from each run's own `createdAt` and `finishedAt`:

| Where the time goes | Duration |
| --- | ---: |
| Work per run, three vendor calls at 600ms | 1.80s |
| Time the run held its slot | **3.41s** |
| Everything else | 1.61s |

**The rate term is in runs, not requests.** A queue's limit counts runs, so the vendor's allowance has to be converted before you multiply. Five calls a second at three calls per run is `5 ÷ 3 = 1.67` runs a second:

```text
1.67 runs/s × 3.41 s/run ≈ 6 concurrent runs
```

Skip that division and you get `5 × 3.41 ≈ 17`, which is a count of requests, not a concurrency. It's an easy mistake to miss, because 17 looks like a plausible queue setting.

So the answer is 6. To check it, I ran the same 20 companies at eight limits, three sweeps each, and measured what the vendor actually received:

| `concurrencyLimit` | vendor req/s | range across 3 sweeps |
| ---: | ---: | :--- |
| 1 | 0.85 | 0.83 to 0.85 |
| 2 | 1.65 | 1.56 to 1.66 |
| 3 | 2.29 | 2.12 to 2.29 |
| 5 | 3.27 | 3.24 to 3.29 |
| **7** | **3.67** | 3.67 to 3.67 |
| 10 | 3.67 | 3.67 to 3.69 |
| 15 | 3.70 | 3.67 to 3.70 |
| 20 | 3.70 | 3.65 to 3.70 |

Throughput climbs to 7 and then stops. Limits above it are the same number, with ranges that overlap too much to separate. The formula said 6 and saturation arrived at 7, which is close enough to be useful, though not as close as it looks: nothing in this sweep ever got above 3.71 req/s, or 74% of what the vendor allows, so the ceiling being measured isn't the vendor's.

The bottom two rows also need a caveat. Counting what actually executed, a limit of 20 never got past 13 running at once, so those rows are two more measurements of roughly 13 rather than of 15 and 20. Ask for a limit and count what runs before trusting either.

What keeps changing is the slot time. Across that same range it climbs from 3.5s to over 8s, for work that never changes, because past saturation the extra slots only hold runs waiting their turn at the vendor.

**So measure the time term at concurrency 1, where nothing is contending, compute the limit from that, and stop there.** Climbing higher costs you compute and buys you nothing.

```ts src/trigger/queues.ts
import { queue } from "@trigger.dev/sdk";

export const enrichmentQueue = queue({
  name: "enrichment",
  // (5 req/s / 3 calls) x 3.41s is about 6, and measured throughput stops
  // improving at 7. Kept at 2 here so a local run is easy to watch.
  concurrencyLimit: 2,
});
```

## Write your task code

Create `src/trigger/enrich.ts`.

The best way to understand this task is by following the comments, but here's a quick overview:

1. `schemaTask` checks each company with Zod before the run starts.
2. The `queue` property attaches the shared concurrency cap.
3. Three billed calls run one after another: profile, email check, lead score.
4. `retry.fetch` handles a 429 by reading the reset time off the response instead of guessing.
5. `metadata.parent` sends the running count and spend back to the parent.

```ts src/trigger/enrich.ts
import { schemaTask, metadata, retry, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { enrichmentQueue } from "./queues.js";

const RETRY_POLICY = {
  byStatus: {
    "429": {
      strategy: "headers" as const,
      limitHeader: "x-ratelimit-limit",
      remainingHeader: "x-ratelimit-remaining",
      // Only this one is actually read. The other two are required by the
      // schema and then never used.
      resetHeader: "x-ratelimit-reset",
      // Our vendor sends a timestamp in milliseconds. If you point this at a
      // countdown header like `Retry-After: 5` under `unix_timestamp`, it
      // works out to 1970, a date in the past, so the retry fires straight
      // away and hammers the vendor.
      resetFormat: "unix_timestamp_in_ms" as const,
    },
    "500-599": { strategy: "backoff" as const, maxAttempts: 5 },
  },
};

/** One billed call. Returns the body and what it cost. */
async function call<T>(path: string, domain: string): Promise<[T, number]> {
  const res = await retry.fetch(`${process.env.MOCK_API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain }),
    retry: RETRY_POLICY,
  });

  // When retry.fetch runs out of attempts it hands back the failed Response.
  // It does not throw. Skip this check and a run that never worked gets
  // recorded as a success with junk in it.
  if (!res.ok) throw new Error(`vendor ${path} returned ${res.status} after retries`);

  return [(await res.json()) as T, Number(res.headers.get("x-charged-usd") ?? 0)];
}

export const enrichCompany = schemaTask({
  id: "enrich-company",
  // Flattened here to keep the example readable. The repo nests this as
  // { company, chaos } so the 429 path can be triggered on demand.
  schema: z.object({ id: z.string(), domain: z.string(), tenantId: z.string() }),
  queue: enrichmentQueue,
  // Attempts of the task. Separate from the retries inside retry.fetch, which
  // handle a 429 without ever failing the attempt.
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000 },
  maxDuration: 300,
  run: async (company) => {
    // Three calls in a row, each one billed. If the run dies after the first
    // two, a retry pays for them again. See the idempotency section.
    const [profile, c1] = await call<{ employees: number }>("/company", company.domain);
    const [contact, c2] = await call<{ email: string }>("/verify", company.domain);
    const [lead, c3] = await call<{ tier: string }>("/score", company.domain);

    const costUSD = Number((c1 + c2 + c3).toFixed(2));

    metadata.parent.increment("enriched", 1);
    metadata.parent.increment("spentCents", Math.round(costUSD * 100));

    logger.info("enriched", { domain: company.domain, tier: lead.tier, costUSD });

    return { ...profile, ...contact, ...lead, costUSD };
  },
});
```

One thing to watch. `retry.fetch` waits by calling `wait.until()`, and runs don't checkpoint until 60 seconds into a wait. So a short 429 backoff keeps its concurrency slot the whole time. Trigger.dev says so in its own logs:

```text
Waits of 5s or less count towards compute usage.
```

Your retries spend the same budget your queue limit was protecting, and they're billable. So size the queue properly instead of leaning on them.

## Fan out, and don't pay twice

Create `src/trigger/fanout.ts`. A single `batchTrigger` caps at 1,000 items, so 10,000 companies means chunking.

The task instance method also accepts an async generator, and it is tempting to read that as a way around the cap. It isn't. The SDK buffers the whole iterable before it sends anything, and says so in its own source: *"For streaming, we need to buffer items to get the count first."* You get nicer code, not a higher ceiling or flatter memory. Chunk anyway.

```ts src/trigger/fanout.ts
import { schemaTask, schedules, idempotencyKeys, metadata } from "@trigger.dev/sdk";
import { z } from "zod";
import { enrichCompany } from "./enrich.js";

// How long a result stays fresh, and the idempotency key's TTL. Inside this
// window, triggering a company again is free and does nothing.
const FRESH_FOR = "30d";

export const enrichCompanies = schemaTask({
  id: "enrich-companies",
  schema: z.object({ companies: z.array(z.any()) }),
  maxDuration: 3_600,
  run: async ({ companies }) => {
    metadata.set("total", companies.length);

    async function* items() {
      for (const company of companies) {
        yield {
          payload: company,
          options: {
            // scope: "global" matters here. Since SDK 4.3.1 a plain string key
            // defaults to "run" scope, which mixes in the parent run id. Every
            // weekly refresh would make new keys and pay for the whole list
            // again.
            idempotencyKey: await idempotencyKeys.create([company.id, "enrich"], {
              scope: "global",
            }),
            idempotencyKeyTTL: FRESH_FOR,
            tags: [`tenant_${company.tenantId}`],
          },
        };
      }
    }

    // Streaming only works on the task instance method. The standalone
    // tasks.batchTrigger(id, items) takes arrays only.
    const handle = await enrichCompany.batchTrigger(items());
    return { triggered: companies.length, batchId: handle.batchId };
  },
});

// This is what makes it infrastructure rather than a backfill. Every Monday it
// triggers the whole list again. Any company looked up in the last 30 days is
// skipped with no vendor call, so you only pay for the stale ones. That works
// out to about a quarter of the list each week.
export const weeklyRefresh = schedules.task({
  id: "weekly-company-refresh",
  cron: { pattern: "0 3 * * 1", timezone: "Europe/London" },
  run: async () => {
    const companies = await loadCompanies();
    await enrichCompanies.trigger({ companies });
  },
});
```

Idempotency keys stop duplicate **triggers**, not duplicate **attempts**. Each of our runs makes three billed calls. If the first two work and the run throws before the third, the retry pays for both again. A failed run also gives up its key. Neither is a bug, but neither makes a key a spending guarantee.

### Warning

You might reach for `concurrencyKey` to be fair across tenants. Read what it does first.

"For each unique value of `concurrencyKey`, a new queue will be created using the `concurrencyLimit` from the queue."

Every key gets its own copy of the queue **at the full limit**. Forty tenants at `concurrencyLimit: 2` is eighty calls at once, not two. That's right when each tenant has their own vendor quota. It's wrong when they share one.

## Do a test run locally

Start the mock vendor in one terminal:

```bash
npm run mock-api
```

And the worker in another:

```bash
npx trigger.dev@latest dev
```

Now go to the Trigger.dev dashboard, click `Test` in the left hand side menu **(1)**, choose `DEV` from the environment options **(2)**, select `enrich-companies` **(3)**, paste a few companies from `data/companies.json` as the payload **(4)**, and click `Run test` **(5)**.

You'll see two runs executing and the rest queued behind them, however many you sent. You can read the same thing without the dashboard, which is what you'd wire an alert to:

```ts
const q = await queues.retrieve({ type: "custom", name: "enrichment" });
// { running: 2, queued: 48, concurrencyLimit: 2, paused: false }
```

Now try this. Check what you've spent:

```bash
curl localhost:7788/stats
```

Run the same companies again, then check a second time. **The number won't move.** Twelve companies looked up twice cost $2.04 and made 36 vendor calls, not 72. The second run triggered nothing at all.

That's idempotency in one command. It's also why nothing seems to happen when you re-test, so use fresh companies while you're building.

To see the retry path, make every call fail:

```bash
npm run trigger -- --offset 200 --limit 3 --chaos
```

Each run reads the reset time, waits, and tries again. Chaos mode never lets up, so they give up in the end. Three companies make **90 rejected requests** on the way, because `retry.fetch` allows 10 attempts and the task makes 3 attempts. A vendor that's down rather than busy gets 30 times the traffic you'd expect.

## Deploy your task to the Trigger.dev cloud

### Add your environment variables to the Trigger.dev project

Copy them from `.env` into the `Environment variables` page in the dashboard, and point `MOCK_API_URL` at a host you can reach, or at your real vendor.

### Deploy your task

```bash
npx trigger.dev@latest deploy
```

## Run your task in Production

Do the same dashboard steps but pick `PROD` from the environment options. The weekly schedule starts on its own from the next Monday.

One thing to check before you raise the limit in production. The free plan allows 10 concurrent runs, Hobby 25. An environment can burst to double its tier across several queues, but **a single queue is capped at the base number**, so a free-plan queue stops at 10 no matter what you set.

That matters here because the sizing above landed on 6, which fits. Had it landed on 12, the queue would have quietly run at 10 and the arithmetic would have been describing something that never happened.
