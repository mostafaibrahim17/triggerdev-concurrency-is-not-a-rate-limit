import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Set TRIGGER_PROJECT_REF in .env to your own ref from the Trigger.dev
  // dashboard, under Project settings.
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./src/trigger"],
  // Required by the TriggerConfig type as of SDK 4.5.10, despite the docs
  // listing it as optional. Seconds of CPU time per attempt; waits don't count.
  maxDuration: 300,
  retries: {
    // The CLI's `init` sets this to false. Leaving it false means a 429 in
    // local dev fails on the first attempt and you never see the retry
    // behaviour this whole pipeline is built around — so it is on here
    // deliberately.
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      randomize: true,
    },
  },
});
