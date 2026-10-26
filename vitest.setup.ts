/**
 * Registers `@testing-library/jest-dom`'s matchers.
 *
 * The package has been a devDependency since long before this file, but
 * nothing ever registered it — there was no setup file at all — so
 * `toBeInTheDocument` and friends failed as unknown Chai properties the
 * first time a test reached for one.
 *
 * It is loaded for every environment rather than only jsdom. The matchers
 * are just assertions being added to `expect`; the ones that need a DOM
 * are only reachable from a test that has one.
 */

import "@testing-library/jest-dom/vitest";

/**
 * Nothing is saved between tests.
 *
 * A game's setup is remembered on the device (`ui/setup/savedSetup.ts`), in
 * `localStorage` and a module-level copy of it. In one test file that is one
 * browser, so a choice made by one test would be the starting point of the
 * next. Only jsdom has a `localStorage` to clear, and the module is only
 * worth loading where there is one.
 */
import { beforeEach } from "vitest";

beforeEach(async () => {
  if (typeof window === "undefined" || !window.localStorage) return;
  for (const game of ["spades", "dominoes", "poker", "lrc", "rummy", "bs"]) {
    window.localStorage.removeItem(`table-games:setup:${game}`);
  }
  const { resetSavedSetupCache } = await import("./src/ui/setup/savedSetup");
  resetSavedSetupCache();
});
