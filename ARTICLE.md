---
title: "I measured my queue in DEV. Production disagreed."
slug: concurrency-is-not-a-rate-limit
image: ./assets/thumbnail.svg
description: "In DEV the pipeline saturated at 74% of the vendor limit and never reached the concurrency it asked for. In PROD both reversed. A concurrency limit is not a rate limit, and the numbers you convert it with do not survive a change of environment."
---

**A vendor sells company data at seventeen cents a lookup and allows five requests a second. You have 10,000 companies. Send them all at once and you're blocked after the fifth call. Loop with a sleep and it runs for hours, and a redeploy in the middle loses track of what you already paid for.**

The usual answer is a queue with a concurrency limit. That works, but `concurrencyLimit` doesn't limit your rate. It limits how many runs execute at once, and converting one into the other is most of the work. I got the conversion wrong twice, shipped a limit two and a half times too big, and when I finally measured it properly the surprise was elsewhere: **the corrected formula was right, and the numbers you feed it were the moving part.** Executing time stretched 3.4x under production load for work that never changed, and my `DEV` environment disagreed with production about nearly everything else.

![Ten thousand companies fan out into a queue that admits a few runs at a time to a vendor allowing five requests per second. Rejected calls return a 429 with a reset timestamp and wait, holding their concurrency slot.](./assets/architecture.svg)

## `concurrencyLimit` is not a rate limit

```ts trigger/queues.ts
export const enrichmentQueue = queue({
  name: "enrichment",
  concurrencyLimit: 2,
});
```

At most two of that task's runs execute at once. So what rate is that? You can't tell from the number: two calls at once against a 50ms API is 40 requests a second, and against a two-second API it's one. Same limit, forty times apart.

Trigger.dev has no requests-per-second setting: the request sits on their board [marked Planned with 147 votes](https://feedback.trigger.dev/p/rate-limiting-on-v3), and the docs answer today is [a community page](https://trigger.dev/docs/guides/community/rate-limiter) pointing at a third-party Redis package. Concurrency is what a queue can control. Rate is something you work out from it, with Little's Law:

```text
concurrency ≈ arrival rate × time in system
```

Both terms have to be in the same currency, and that is where this came unstuck.

## The math I got wrong

For a vendor allowing 5 req/s where each call takes 200ms, the sum looks easy: `5 × 0.2 = 1`, so pick 2 and let retries cover the overshoot. That was my first mistake. **The latency in that formula isn't the vendor's response time, it's how long the run holds its slot.** Back then that was 2.2 seconds, not 0.2, and with one call per run the request rate and the run rate were the same number, so the honest answer was `5 × 2.2 ≈ 11`. For the current run, which makes three billed calls:

| Where the time goes | Duration |
| --- | ---: |
| Work per run, three vendor calls at 600ms | 1.80s |
| Time the run held its slot | **3.41s** in DEV, 3.60s in PROD |
| Everything else | 1.61s in DEV, 1.80s in PROD |

Each slot figure is the mean of 8 uncontended runs in its environment, from each run's own `createdAt` and `finishedAt`. The sizing below uses DEV's 3.41s, and PROD's 3.60s rounds to the same answer.

![Of a 3.41 second run, 1.8 seconds is vendor work across three calls. The remaining 1.61 seconds is platform overhead, and the concurrency slot is held for all of it.](./assets/where-the-time-goes.svg)

With the time term fixed I wrote `5 × 3.4 ≈ 17`, called it 15, and shipped it. That was the second mistake, and the worse one. That is not a concurrency. A queue's limit counts **runs**, so both terms must be about runs; a request-level rate times a run-level time describes nothing. Convert the rate first: 5 calls a second at three calls per run permits `5 ÷ 3 = 1.67` runs a second:

```text
1.67 runs/s × 3.41 s/run ≈ 6 concurrent runs
```

Six, not seventeen. Nearly three times out, and invisible, because both numbers look like plausible queue settings.

**The time term is how long the run holds the slot, and the rate term is in runs, not requests.** Measure the run, not the call, and measure it where you'll run: self-hosted has no checkpointing at all, so there every wait holds its slot, not just short ones.

## Retries, and the slot they hold

Sizing gets you close, never exact. You also need something that reacts.

```ts
const response = await retry.fetch(url, {
  method: "POST",
  body: JSON.stringify({ domain }),
  retry: {
    byStatus: {
      "429": {
        strategy: "headers",
        limitHeader: "x-ratelimit-limit",
        remainingHeader: "x-ratelimit-remaining",
        resetHeader: "x-ratelimit-reset",
        resetFormat: "unix_timestamp_in_ms",
      },
    },
  },
});

if (!response.ok) throw new Error(`vendor ${response.status} after retries`);
```

Four things about that: one the docs get flat wrong, one they never mention.

- **Only `resetHeader` is read.** The other two are required by the schema and never consulted when computing the delay.
- **`resetFormat` is a trap.** `unix_timestamp` does `new Date(value * 1000)`, so a countdown header like `Retry-After: 5` becomes a date in 1970 and the retry fires straight back at a vendor that just asked you to stop.
- **It returns the failed `Response` instead of throwing** once it runs out of attempts, so skipping that `response.ok` check records a run that never worked as a success. The docs say the opposite, that an error will be thrown, while their own examples on the same page call `.json()` on the result with no `.ok` check, three times.
- **It caps at 10 attempts.** A hard `MAX_ATTEMPTS` you cannot raise, documented nowhere.

And the part that matters, which is documented: a run doesn't checkpoint until 60 seconds into a wait, and `retry.fetch` waits via `wait.until()`. Any backoff under a minute holds its concurrency slot for the whole wait, so the retry layer spends the budget the queue limit was protecting, and you're billed for the waiting.

## The number you feed the formula doesn't hold still

All of that is theory until you plot it.

### How this was measured

One setup for every number: a mock vendor holding 5 tokens and refilling at 5 a second, 600ms per call, three billed calls per company. Eight limits, three sweeps each, 20 companies per sweep, medians with the full range, throughput read from the vendor's own counters. Each sweep uses company ids no earlier sweep touched, or the idempotency keys silently dedupe the triggers. (They stop duplicate triggers only; a retry inside a run can still repeat a billed call.) SDK 4.5.10, run twice: in `DEV`, which routes work through my own machine, then in a free-plan `PROD` environment reaching the vendor through a Cloudflare tunnel, whose extra round trip is included in PROD's numbers.

![In DEV the throughput curve flattens between 3.67 and 3.70 requests per second from a limit of 7 onward, 74 percent of the vendor's allowance. In PROD it rises unevenly, dipping at 15, to 4.89 at a limit of 20, brushing the vendor's 5.](./assets/throughput-curve.svg)

| `concurrencyLimit` | DEV req/s | PROD req/s | PROD range |
| ---: | ---: | ---: | :--- |
| 1 | 0.85 | 0.83 | 0.83 to 0.88 |
| 2 | 1.65 | 1.75 | 1.75 to 1.86 |
| 3 | 2.29 | 2.29 | 2.12 to 2.29 |
| 5 | 3.27 | 3.70 | 2.97 to 3.70 |
| 7 | 3.67 | 4.21 | 4.20 to 4.22 |
| 10 | 3.67 | 4.35 | 4.34 to 4.43 |
| 15 | 3.70 | 3.82 | 3.70 to 4.29 |
| **20** | 3.70 | **4.89** | 4.27 to 5.08 |

The difference between the columns is the finding. In `DEV`, throughput climbs to 7 and stops dead: 7, 10, 15 and 20 are the same number, never exceeding 3.70 req/s, 74% of the allowance. A full draft shipped without knowing why, and said so.

`PROD` says why. At a limit of 20 it reaches 4.89 req/s, brushing the vendor's 5. The vendor's limiter, invisible in every DEV measurement, finally binds. **The DEV plateau was my laptop, not the vendor.** The dev worker tops out around 3.7 req/s, and no concurrency setting can buy throughput a worker can't deliver.

The PROD curve isn't tidy and I won't pretend it is: it dips at 15 before peaking at 20, my own script prints "the peak is not clean", and the raw log confesses that five sweeps counted 21/20 companies, a straggler crossing the counting window and inflating the limit-10 reps about 5%. So read the column with that in mind. The 98% at a limit of 20 is the noisiest row in the set: three reps reading 4.27, 5.08 and 4.89, and the 5.08 is both a miscounted sweep and above the vendor's nominal 5. The cleanest row is a limit of 7, where three reps land between 4.20 and 4.22, or 84% of the allowance. Either number makes the same point against DEV's flat 74%, and the tight one makes it more honestly.

The corrected formula earns its keep as a floor: at a limit of 7 you get 84% of the vendor's rate in PROD, and the last 14% costs roughly three times the held slots.

One history paragraph, because it's earned: draft one claimed throughput *fell* past 10, a conclusion built on a 1.99-second reading from a loop polling every two seconds, and three DEV sweeps killed it. Draft two claimed it saturated at 7 forever, and PROD killed that. The only sentence that survived every draft is the one about checking your units.

## The limit you set is not the concurrency you get

Before trusting the bottom of that table, check whether it actually happened, because `concurrencyLimit` is a number you request, not a number you get. I read every run's real `startedAt` and `finishedAt` back from the API and counted how many were ever executing at the same instant:

| asked for | DEV reached | PROD reached |
| ---: | ---: | ---: |
| 10 | 9 | 10 |
| 20 | **13** | **20** |

In `DEV`, asking for 20 got 13, while `queues.retrieve` cheerfully reported `concurrencyLimit: 20` throughout. **A limit the platform accepts is not a limit the platform reaches**, and DEV's rows for 15 and 20 above are really two more measurements of about 13.

In `PROD` the same request delivered exactly 20, which surprised me from the other direction: this is a free account, documented at 10 concurrent runs with single queues capped "at most 10". And twenty isn't random. It's exactly the base limit times the documented 2.0x burst factor, so a single queue apparently *can* spend the environment's whole burst allowance, and the sentence saying it can't isn't enforced. The ceiling misses in both directions: DEV under-delivered what I asked for, PROD over-delivered what the docs promise. Count what executes. It's the only number that was right in both environments.

For the DEV gap there is a published explanation, and the docs disagree with themselves about it: the queues page says only actively executing runs count, the troubleshooting page admits `DEQUEUED` runs count too, and their [incident report of 22 June 2026](https://trigger.dev/blog/incident-report-jun-22-2026) says it plainest: "queued runs held onto concurrency. When a run moves from the main queue into a per-worker queue but hasn't started yet, it still counts against your concurrency limit." If a run can hold a slot before it starts, my seven missing slots weren't missing capacity. They were spoken for.

## What load does to the time term

Uncontended, a run executes for about 3.4 seconds in either environment. Under PROD load, measured from the runs' own timestamps: executing time averaged 5.80s at 10 concurrent, and at 20, **11.22s. The same three calls, 3.4 times slower, because nineteen other runs are contending for the same five tokens a second.**

That is what makes Little's Law awkward in practice. The law is exact, but W isn't a property of your task you can look up once. It's a property of the system under the load you chose, and raising the limit raises it. Past the vendor's rate, every extra slot mostly holds a run waiting its turn.

So: **measure W at concurrency 1, where nothing contends, compute the limit from that, and climb a step or two to check.** When throughput stops moving while executing time keeps rising, concurrency has stopped buying anything.

## What I'd take away

- **The time term is how long the run holds the slot, and the rate term is in runs, not requests.** Multiplying a request rate by a run duration gives a number that describes nothing.
- **Measure that time at concurrency 1, where nothing contends.** Under load it rises, and then it is telling you about your queue rather than your task.
- **A limit the platform accepts is not a limit the platform reaches, in either direction.** DEV gave 13 of a requested 20; a free-plan PROD queue gave 20 where the docs promise 10. Count what executes before you reason about it.
- **Retries spend the budget the concurrency limit was protecting**, holding their slot for any backoff under a minute.
- **Idempotency keys need `scope: "global"` spelled out.** Since 4.3.1 a plain string key defaults to `run` scope, which mixes in the parent run id, so a weekly refresh would mint fresh keys and buy the whole list again.

## What I'd change next

**Adaptive throttling.** `queues.overrideConcurrencyLimit()` changes a limit live, and it already ran the sweep, so the loop is half built: watch executing time, and step the limit back whenever it rises without throughput following.

The [pipeline and every script in this post](https://github.com/mostafaibrahim17/triggerdev-concurrency-is-not-a-rate-limit) are on GitHub, with a mock vendor that rate-limits, bills you, and can be told to refuse everything. If your lookup job has outgrown a `for` loop with a `sleep` in it, it's worth an afternoon.
