# `concurrencyLimit` is not a rate limit

**A durable pipeline that fans 10,000 company lookups out to a vendor allowing five
requests a second, and the measurements used to size its queue.**

The write-up is [**ARTICLE-FINAL.md**](./ARTICLE-FINAL.md). Every number in it
traces to raw console output kept in [`data/`](./data).

```
DEV   ████████████░░░░░░░░  74% of the vendor's allowance, plateaus at a limit of 7
PROD  ███████████████████░  98% of the vendor's allowance, still climbing at 20
```

Same code, same vendor, same sweep. That gap is what the article is about.

---

## What this is

Each company becomes its own durable run. A concurrency-limited queue caps how many
call the vendor at once, `retry.fetch` absorbs the 429s that get through, and
idempotency keys make the whole thing safe to re-run.

The vendor is a mock bundled here: it rate-limits with a token bucket, charges per
call, returns real rate-limit headers, and can be told to refuse everything. So the
pipeline runs on the free plan at no real cost, and the money still adds up.

## The thing most people get wrong

Trigger.dev has **no requests-per-second primitive**. `concurrencyLimit` caps
*simultaneous runs*, not the rate at which they start. Converting one into the other
is Little's Law:

```
concurrency ≈ arrival rate × time in system
```

Both terms have to be in the same currency, and that is where this came unstuck twice.

**The time term isn't the API's response time.** It's how long the run holds the slot:

| Measured over 8 uncontended runs | |
| --- | ---: |
| Three vendor calls at 600ms | 1.80s |
| Run, created to finished | **3.41s** DEV, 3.60s PROD |
| Everything else | 1.61s DEV, 1.80s PROD |

**The rate term is in runs, not requests.** The queue counts runs, so divide by
calls-per-run before multiplying:

```
(5 req/s ÷ 3 calls per run) × 3.41s ≈ 6 concurrent runs
```

Multiplying 5 by 3.41 gives 17, a count of requests, not a concurrency. That mistake
is why this README used to say 15.

## Then measurement disagreed with itself

Eight concurrency limits, three sweeps of 20 companies each, run in both environments.

| `concurrencyLimit` | DEV req/s | PROD req/s |
| ---: | ---: | ---: |
| 1 | 0.85 | 0.83 |
| 3 | 2.29 | 2.29 |
| 5 | 3.27 | 3.70 |
| 7 | 3.67 | 4.21 |
| 10 | 3.67 | 4.35 |
| 20 | 3.70 | **4.89** |

In `DEV` throughput stops improving past 7 and never exceeds 74% of the vendor's
allowance. In `PROD` the same sweep reaches 98%. The plateau was the dev worker, not
the vendor.

And the limit you request is not always the concurrency you get. Counted from each
run's own `startedAt` and `finishedAt`:

| Requested | DEV reached | PROD reached |
| ---: | ---: | ---: |
| 10 | 9 | 10 |
| 20 | **13** | **20** |

Six is a floor worth starting from, not an answer. Measure in the environment you
will actually run in.

**The raw evidence**

| File | What it holds |
| --- | --- |
| [`data/sweep-2026-09-14.txt`](./data/sweep-2026-09-14.txt) | DEV sweep, 24 runs, medians and ranges |
| [`data/sweep-prod-2026-09-19.txt`](./data/sweep-prod-2026-09-19.txt) | PROD sweep, same shape |
| [`data/peak-prod-2026-09-19.txt`](./data/peak-prod-2026-09-19.txt) | Concurrency actually reached |

## Setup

```bash
git clone https://github.com/mostafaibrahim17/triggerdev-concurrency-is-not-a-rate-limit.git
cd triggerdev-concurrency-is-not-a-rate-limit
npm install
cp .env.example .env
```

Create a free Trigger.dev project, log in, and set its ref:

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
npm run mock-api    # the rate-limited vendor
npm run dev         # the Trigger.dev dev server
npm run trigger -- --watch
```

## Try the interesting parts

```bash
# Force 429s on every call and watch retry.fetch absorb them
npm run trigger -- --offset 200 --limit 3 --chaos

# Run the same companies twice. The spend doesn't move.
curl localhost:7788/stats
npm run trigger -- --limit 12
curl localhost:7788/stats
```

Reproduce the measurements:

```bash
npm run experiment   # the sweep: 8 limits x 3 repeats, both tables above
npm run peak         # how many runs actually executed at once
npm run runwall      # uncontended run timings
```

`--offset` matters. Idempotency keys last 30 days, so re-running companies you have
already looked up does nothing at all, and a sweep over reused ids measures nothing.
Use fresh ones.

## Layout

| File | What's in it |
| --- | --- |
| `src/trigger/queues.ts` | The concurrency cap, and the Little's Law arithmetic behind the number |
| `src/trigger/enrich.ts` | The per-company durable task, three billed vendor calls |
| `src/trigger/fanout.ts` | Streamed `batchTrigger`, idempotency keys, and the weekly refresh |
| `src/lib/provider.ts` | `retry.fetch` with the 429 headers strategy |
| `scripts/mock-api.ts` | Token-bucket vendor: three priced endpoints, real rate-limit headers |
| `scripts/experiment.ts` | The throughput sweep |
| `scripts/peak.ts` | Peak concurrency from run timestamps |
| `scripts/runwall.ts` | Uncontended run timings |
| `scripts/seed.ts` | Builds the company list from the Majestic Million |
| `scripts/run.ts` | Triggers the pipeline from outside, the way your backend would |

## Things worth knowing before you copy this

All verified against SDK 4.5.10. Several are not in the docs, and two contradict them.

**Retries**

- **`retry.fetch` returns the failed `Response` instead of throwing.** Check
  `response.ok` yourself or failures pass as successes. The docs say it throws, and
  their own examples call `.json()` without checking.
- **Only `resetHeader` is read** by the `headers` strategy. `limitHeader` and
  `remainingHeader` are required by the schema and then ignored.
- **`resetFormat: "unix_timestamp"` means seconds since epoch.** Point it at a
  countdown like `Retry-After: 5` and it resolves to 1970, so the retry fires
  immediately and hammers the API.
- **It hard-caps at 10 attempts** regardless of what you configure.
- **A 429 wait under 60 seconds holds its concurrency slot.** Runs don't checkpoint
  until 60s into a wait, so retries spend the budget the cap was protecting.

**Concurrency**

- **`concurrencyKey` multiplies your load, it doesn't divide it.** Each distinct key
  gets its own copy of the queue *at the full limit*. Only use it when the vendor
  quota is genuinely per-tenant.
- **Count what executes.** `queues.retrieve` reported `concurrencyLimit: 20` in DEV
  while 13 was the most that ever ran.
- **`maxDuration` is required** in `TriggerConfig` as of 4.5.10, though the docs list
  it as optional.
- **Retries are disabled in dev** by the CLI's `init`. This repo turns them back on,
  or you would never see any retry behaviour locally.

**Idempotency**

- **Keys dedupe triggers, not attempts.** If a paid call succeeds and the run throws
  afterwards, the retry calls again. Use the vendor's own idempotency key for that.
- **Raw-string keys default to `run` scope** since 4.3.1, not `global`. Pass
  `{ scope: "global" }` explicitly or re-runs won't dedupe. That breaking change is
  in the docs and in neither changelog.
- Failed runs release their key automatically.

**Batching**

- **Streamed `batchTrigger` only works on the task instance method.**
  `myTask.batchTrigger(asyncIterable)` works; `tasks.batchTrigger(id, items)` takes
  arrays only. It buffers internally, so it is ergonomics, not a higher ceiling.
- **The free plan processes one batch at a time** (Hobby and Pro get 10). Intake is
  capped too: 1,200 runs of burst, refilling 100 every 10 seconds.
- **Metadata caps at 256KB.** Counters are fine. A row per company is not.

## What one company costs

Three billed calls each: `/company` $0.10, `/verify` $0.02, `/score` $0.05. That is
**$0.17 per company**, so 10,000 is $1,700 of vendor spend. `curl localhost:7788/stats`
reports calls, rejections and the running total.

Look up the same companies twice and the total doesn't move. That is the 30-day
freshness window doing its job.

## Free plan limits, and what was actually measured

The docs say the free plan allows **10 concurrent runs**, with a 2.0x environment
burst factor, and that a single queue is capped at the base limit: "any single queue
can have at most 10".

Measured, a single queue on a free-plan production environment ran **20 at once**,
counted from each run's own timestamps (`npm run peak`). Twenty is exactly base x
burst, so the queue appears able to spend the environment's full burst allowance.
Treat the documented cap as what you can rely on, and the measurement as a reason to
count rather than assume.

The $5/month credit and 1-day log retention are what most people hit first. 10,000
companies is 10,000 durable runs, which is real compute against that credit.
`--limit 500` is the sane default for following along.

## License

MIT
