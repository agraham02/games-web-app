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
