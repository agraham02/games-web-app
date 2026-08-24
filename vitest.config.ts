import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // No @vitejs/plugin-react here: Next 16 pulls a rolldown-based Vite
  // while Vitest bundles its own, and the plugin's types conflict across
  // the two. Tests need the JSX transform, not Fast Refresh, so esbuild's
  // automatic runtime covers it.
  esbuild: { jsx: "automatic" },
  test: {
    // Node by default, jsdom only where a test actually renders. 26 of the
    // 31 test files are pure rules/geometry logic with no DOM in them, and
    // standing a jsdom up for each was costing more wall-clock than every
    // assertion in the suite combined — it also saturated the worker pool
    // hard enough that Vitest's own reporter RPC timed out and failed the
    // run with all 517 tests passing.
    //
    // The five that DO render opt in with a `@vitest-environment jsdom`
    // docblock at the top of the file. Add one if you write a test that
    // touches the DOM; the failure if you forget is immediate and obvious.
    setupFiles: ["./vitest.setup.ts"],
    environment: "node",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // Vitest's 5s default is simply the wrong budget for this suite. The
    // rules layers are verified by brute-force simulation sweeps — rummy
    // plays 200 full matches in one test (~18s), poker fuzzes many seeds
    // and seat counts, spades sweeps 300 — and those are the tests that
    // have actually caught real bugs, so shrinking them to fit a default
    // would be trading away the coverage that matters.
    //
    // At 5s several of them sat just under the line and passed alone but
    // timed out under full-suite contention, which reads as a broken
    // build for a reason that has nothing to do with the code. A genuinely
    // hung test still fails here, just later.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
