import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// e2e runs the production build against a fresh SQLite file on :3200, with the real Docker sandbox and the fake provider.
// One run at a time (HARNESS_CONCURRENCY=1) so the M3 spec can see a run wait in the queue.
// HEADED=1 opens a visible browser in slow motion so you can watch each step.
// REAL_MODEL=<ollama model> runs only e2e/real-model.spec.ts against local Ollama (http://localhost:11434) instead of the fake provider.
const headed = !!process.env.HEADED;
const realModel = process.env.REAL_MODEL;
const port = 3200;

export default defineConfig({
  testDir: "e2e",
  ...(realModel ? { testMatch: "**/real-*.spec.ts" } : { testIgnore: "**/real-*.spec.ts" }),
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${port}`,
    headless: !headed,
    launchOptions: { slowMo: headed ? 350 : 0 },
    video: "on",
    trace: "on",
    screenshot: "on",
  },
  webServer: {
    command: "npx vite build --logLevel warn && node server/index.ts",
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      DB_PATH: join(tmpdir(), `harness-e2e-${Date.now()}.db`),
      BETTER_AUTH_URL: `http://localhost:${port}`,
      ...(realModel ? {} : { HARNESS_PROVIDER: "fake" }), // the real-model spec adds an Ollama provider through the UI
      HARNESS_CONCURRENCY: "1",
      HARNESS_SECRET_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", // test key only
      HARNESS_DATA_DIR: join(tmpdir(), `harness-e2e-runs-${Date.now()}`),
      BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
    },
  },
});
