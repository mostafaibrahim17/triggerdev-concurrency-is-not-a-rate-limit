# Rate-limited company lookups on Trigger.dev

Fan a company list out to a paid enrichment vendor that only allows a few requests per
second, without going over their limit and without losing your progress when
something restarts.

Every company becomes its own durable run. A concurrency-limited queue caps how
many of those runs call the API at once. `retry.fetch` absorbs the 429s that get
through. Idempotency keys make the whole thing safe to re-run.

The vendor is a mock bundled in this repo: it rate-limits, charges you per call,
and can be told to refuse everything on demand. So the whole pipeline runs on
the free plan at no real cost, and the money side still adds up.

## The thing most people get wrong

Trigger.dev has **no requests-per-second primitive**. `concurrencyLimit` caps
*simultaneous runs*, not the rate at which they start. Those are different
quantities, and conflating them is how you end up rate-limited anyway.

You convert one into the other with Little's Law:

```
concurrency ≈ arrival rate × time in system
```

**The latency is the trap.** It isn't the API's response time. It's how long the
*run* holds the slot, which includes Trigger.dev's own overhead. We measured:

| | |
| --- | ---: |
| Work per run, three vendor calls | 1.80s |
| Run wall time, what holds the slot | **3.41s** |
| Everything else | 1.61s |

Both terms have to be in the same currency. The queue counts **runs**, so the
vendor's 5 requests/second has to be divided by calls-per-run first:

```
(5 req/s ÷ 3 calls per run) × 3.41s ≈ 6 concurrent runs
```

Multiplying 5 by 3.41 gives 17, which is a count of requests, not a concurrency.
That mistake is why this README used to say 15.

Then measurement disagreed with itself across environments. In `DEV`, throughput
stopped improving past a limit of 7 and never exceeded 74% of the vendor's
allowance. In `PROD` the same sweep reached 98%, and a limit of 20 genuinely ran
20 concurrent where `DEV` only ever reached 13. Six is a floor worth starting
from, not an answer: measure in the environment you will actually run in.

Every number in the write-up traces to raw console output kept in this repo:
[`data/sweep-2026-09-14.txt`](./data/sweep-2026-09-14.txt) (DEV),
[`data/sweep-prod-2026-09-19.txt`](./data/sweep-prod-2026-09-19.txt) (PROD), and
[`data/peak-prod-2026-09-19.txt`](./data/peak-prod-2026-09-19.txt) (concurrency
actually reached). The write-up is [`ARTICLE-FINAL.md`](./ARTICLE-FINAL.md).

Sizing gets you close, never exact. Latency drifts and other clients share your
quota. So the concurrency cap stops most of it, and 429-aware retries catch the
rest. Both are in this repo.

## Setup

```bash
git clone https://github.com/mostafaibrahim17/triggerdev-concurrency-is-not-a-rate-limit.git
cd triggerdev-concurrency-is-not-a-rate-limit
npm install
cp .env.example .env
```

Create a free Trigger.dev project, then either put its ref in
`trigger.config.ts` or export it:

```bash
npx trigger.dev login
export TRIGGER_PROJECT_REF=proj_xxxxxxxx
```

Pull the company list. Real domains from the Majestic Million, free, no key:

```bash
npm run seed                    # 500 companies (default)
npm run seed -- --limit 10000   # the full fan-out
```

Then, in three terminals:

```bash
npm run mock-api    # the rate-limited API being protected
npm run dev         # the Trigger.dev dev server
npm run trigger -- --watch
```

## Try the interesting parts

```bash
# Force 429s on every call and watch retry.fetch absorb them
npm run trigger -- --offset 200 --limit 3 --chaos

# Run the same companies again. The spend doesn't move
curl localhost:7788/stats
npm run trigger -- --limit 12
curl localhost:7788/stats
```

`--offset` matters. Idempotency keys last 30 days, so re-running companies
you've already looked up does nothing at all. Use fresh ones while developing.

## Layout

| File | What's in it |
| --- | --- |
| `src/trigger/queues.ts` | The concurrency cap, and the Little's Law arithmetic behind the number |
| `src/trigger/enrich.ts` | The per-company durable task, three billed vendor calls |
| `src/trigger/fanout.ts` | Streamed `batchTrigger`, idempotency keys, and the weekly refresh |
| `src/lib/provider.ts` | `retry.fetch` with the 429 headers strategy, and the three billed calls |
| `scripts/mock-api.ts` | Token-bucket vendor: three priced endpoints, real rate-limit headers |
| `scripts/seed.ts` | Builds the company list from the Majestic Million |
| `scripts/run.ts` | Triggers the pipeline from outside, the way your backend would |

## Things worth knowing before you copy this

These are all verified against SDK 4.5.10, and several aren't in the docs.

- **`concurrencyKey` multiplies your load, it doesn't divide it.** Each distinct
  key value gets its own copy of the queue *at the full limit*. The seeded list
  has 43 tenants, so `concurrencyLimit: 2` becomes 86 concurrent calls. Only use
  it when the vendor quota is genuinely per-tenant.
- **A 429 wait under 60 seconds holds its concurrency slot.** `retry.fetch` waits
  via `wait.until()`, and runs don't checkpoint until 60s into a wait. So the
  retries spend the budget the cap was protecting. Under steady 429s your real
  throughput drops, which is why you size the cap properly.
- **`retry.fetch` returns the failed `Response` instead of throwing.** Check
  `response.ok` yourself or failures pass as successes.
- **Only `resetHeader` is read** by the `headers` retry strategy. `limitHeader`
  and `remainingHeader` are required by the schema and then ignored.
- **`resetFormat: "unix_timestamp"` means seconds since epoch.** Point it at a
  countdown header like `Retry-After: 5` and it works out to 1970, a date in the
  past, so the retry fires straight away and hammers the API.
- **`retry.fetch` hard-caps at 10 attempts** regardless of what you configure.
- **Idempotency keys dedupe triggers, not attempts.** If a paid call succeeds and
  the run throws afterwards, the retry calls again. Use the downstream API's own
  idempotency key for that. Failed runs also release their key automatically.
- **Raw-string idempotency keys default to `run` scope** since 4.3.1, not
  `global`. Pass `{ scope: "global" }` explicitly or re-runs won't dedupe.
- **Streamed `batchTrigger` only works on the task instance method.**
  `myTask.batchTrigger(asyncIterable)` works. `tasks.batchTrigger(id, items)`
  takes arrays only.
- **The free plan processes one batch at a time** (Hobby and Pro get 10). Chunking
  10,000 records into ten calls means ten batches one after another on free,
  which is another reason to stream. Intake is also capped: 1,200 runs of burst,
  refilling 100 every 10 seconds.
- **`maxDuration` is required** in `TriggerConfig` as of 4.5.10, though the docs
  list it as optional.
- **Retries are disabled in dev** by the CLI's `init`. This repo turns them back
  on, or you'd never see any of the retry behaviour locally.
- **Metadata caps at 256KB.** Counters are fine. A row per company is not.

## What one company costs

Three billed calls each: `/company` $0.10, `/verify` $0.02, `/score` $0.05. That's
**$0.17 per company**, so 10,000 is $1,700 of vendor spend. `curl localhost:7788/stats`
reports calls, rejections and running total.

Look up the same companies twice and the total doesn't move. That's the
30-day freshness window doing its job.

## Free plan limits, and what we actually measured

The docs say the free plan allows **10 concurrent runs**, with a 2.0x environment
burst factor, and that *a single queue is capped at the base limit*: "any single
queue can have at most 10".

Measured, a single queue on a free-plan production environment ran **20 at once**,
counted from each run's own `startedAt` and `finishedAt` (`npm run peak`). Twenty
is exactly base x burst, so the queue appears able to spend the environment's full
burst allowance. Treat the documented cap as the number you can rely on, and the
measurement as a reason to count rather than assume.

In `DEV` it goes the other way: asking for 20 gave 13, while `queues.retrieve`
reported `concurrencyLimit: 20` throughout.

The $5/month credit and 1-day log retention are what most people hit first.
10,000 companies is 10,000 durable runs, which is real compute against that credit.
`--limit 500` is the sane default for following along.

## License

MIT
