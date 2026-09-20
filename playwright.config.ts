import { defineConfig, devices } from "@playwright/test";

/**
 * Multi-client browser tests.
 *
 * This is the layer nothing else reaches. The engine tests are pure, the
 * ws harness talks to the server with no UI in front of it, and the jsdom
 * tests render the room against a fake socket — so none of them can tell
 * whether four real browsers, on one real server, actually show four
 * people a coherent table.
 *
 * One worker, deliberately: these share a server and rooms are global to
 * the process, so parallel workers would be several tests racing over the
 * same room codes and the same bot timers.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_URL ?? "http://localhost:3210",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile.spec.ts/,
    },
    {
      // A phone, for the half of the layout a desktop viewport cannot
      // reach: the short-viewport branch, the pannable fans, and the one
      // game that declines to lay out and asks to be turned. Its own
      // spec rather than the whole suite run twice - the point is the
      // viewport, so only the tests whose behaviour depends on it.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /mobile.spec.ts/,
    },
  ],
  webServer: process.env.E2E_URL
    ? undefined
    : {
        // The real server, not `next dev` — the socket is the thing under
        // test and only this entry point serves it.
        command: "npx tsx server.ts",
        env: { PORT: "3210", NODE_ENV: "development" },
        url: "http://localhost:3210",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
