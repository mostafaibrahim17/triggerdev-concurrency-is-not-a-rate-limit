import { tasks, logger } from "@trigger.dev/sdk";

/**
 * Global failure hook. Fires once a run has exhausted every attempt.
 *
 * Trigger.dev picks this file up automatically because it sits in the trigger
 * directory. In a real pipeline this is where a dead-letter row gets written so
 * the handful of records that never succeeded are recoverable without trawling
 * the dashboard.
 *
 * Two caveats: errors thrown in here are swallowed (they show in the dashboard
 * but change nothing), and it does not fire for `Crashed`, `System failure`, or
 * `Canceled` runs — so it is not a complete audit of everything that went wrong.
 */
tasks.onFailure(({ ctx, error }) => {
  logger.error("run failed permanently", {
    taskId: ctx.task.id,
    runId: ctx.run.id,
    attempts: ctx.attempt.number,
    error: error instanceof Error ? error.message : String(error),
  });
});
