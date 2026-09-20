// @vitest-environment node

/**
 * A free host puts a service to sleep after 15 minutes without inbound
 * traffic, and a room lives in that process's memory — so a game that runs
 * past fifteen minutes with nothing else touching the server would be
 * ended by the platform, mid-hand, with no warning.
 *
 * The properties that matter are both directions at once: it must keep an
 * ACTIVE game awake, and it must NOT keep an empty service awake, because
 * the second is what makes this a courtesy to the free tier rather than a
 * way around it.
 */

import { describe, expect, it } from "vitest";
import { TestClock } from "@/session/clock";
import { KEEP_AWAKE_INTERVAL_MS, KeepAwake, keepAwakeUrl } from "./keepAwake";

const MIN = 60_000;
const IDLE_LIMIT_MS = 15 * MIN;

function rig(opts: { people?: () => boolean; fail?: boolean } = {}) {
  const clock = new TestClock();
  const calls: string[] = [];
  let people = true;
  const awake = new KeepAwake({
    url: "https://games.example.com/",
    hasPeople: opts.people ?? (() => people),
    clock,
    fetch: (url) => {
      calls.push(url);
      return opts.fail ? Promise.reject(new Error("network down")) : Promise.resolve({});
    },
  });
  return { clock, calls, awake, setPeople: (v: boolean) => (people = v) };
}

describe("keeping an active game awake", () => {
  it("asks for the service's own address, and only its health check", () => {
    const { clock, calls, awake } = rig();
    awake.start();
    clock.advance(KEEP_AWAKE_INTERVAL_MS);
    // The trailing slash on the configured URL must not double up.
    expect(calls).toEqual(["https://games.example.com/healthz"]);
  });

  it("never lets a fifteen-minute game go without traffic", () => {
    // The requirement itself. Sample the whole first hour: at no point may
    // more than the platform's idle limit pass between two requests.
    const { clock, calls, awake } = rig();
    awake.start();

    const seen: number[] = [];
    let last = 0;
    let longestGap = 0;
    for (let t = 0; t <= 60 * MIN; t += 1000) {
      const before = calls.length;
      clock.advance(1000);
      if (calls.length > before) {
        seen.push(clock.now());
        longestGap = Math.max(longestGap, clock.now() - last);
        last = clock.now();
      }
    }
    expect(seen.length).toBeGreaterThan(10);
    expect(longestGap).toBeLessThan(IDLE_LIMIT_MS);
  });

  it("leaves room for a request to be lost", () => {
    // If it were 8 minutes, a single failed request would leave nothing
    // between the last good one and the deadline.
    expect(KEEP_AWAKE_INTERVAL_MS * 3).toBeLessThan(IDLE_LIMIT_MS);
  });

  it("survives a request that fails, and tries again on schedule", () => {
    const { clock, calls, awake } = rig({ fail: true });
    awake.start();
    clock.advance(KEEP_AWAKE_INTERVAL_MS * 3);
    expect(calls).toHaveLength(3);
  });
});

describe("not keeping an empty service awake", () => {
  it("stays silent while nobody is connected", () => {
    const { clock, calls, awake } = rig({ people: () => false });
    awake.start();
    clock.advance(60 * MIN);
    expect(calls).toEqual([]);
  });

  it("starts as soon as somebody arrives, and stops when they leave", () => {
    const { clock, calls, awake, setPeople } = rig();
    setPeople(false);
    awake.start();
    clock.advance(KEEP_AWAKE_INTERVAL_MS * 2);
    expect(calls).toHaveLength(0);

    setPeople(true);
    clock.advance(KEEP_AWAKE_INTERVAL_MS * 2);
    expect(calls).toHaveLength(2);

    setPeople(false);
    clock.advance(KEEP_AWAKE_INTERVAL_MS * 5);
    expect(calls).toHaveLength(2);
  });

  it("does nothing once stopped, and leaves no timer behind", () => {
    const { clock, calls, awake } = rig();
    awake.start();
    awake.stop();
    clock.advance(60 * MIN);
    expect(calls).toEqual([]);
    expect(clock.pending).toBe(0);
  });
});

describe("deciding whether to run", () => {
  const prod = { NODE_ENV: "production" };

  it("uses the address Render provides, with no configuration", () => {
    expect(keepAwakeUrl({ ...prod, RENDER_EXTERNAL_URL: "https://a.onrender.com" })).toBe(
      "https://a.onrender.com",
    );
  });

  it("lets another host say where it lives, and prefers that", () => {
    expect(
      keepAwakeUrl({
        ...prod,
        KEEP_AWAKE_URL: "https://mine.example.com",
        RENDER_EXTERNAL_URL: "https://a.onrender.com",
      }),
    ).toBe("https://mine.example.com");
  });

  it("can be switched off", () => {
    expect(keepAwakeUrl({ ...prod, RENDER_EXTERNAL_URL: "https://a.onrender.com", KEEP_AWAKE: "0" })).toBeNull();
  });

  it("does not run without an address to call", () => {
    expect(keepAwakeUrl(prod)).toBeNull();
    expect(keepAwakeUrl({ ...prod, RENDER_EXTERNAL_URL: "  " })).toBeNull();
  });

  it("never runs outside production", () => {
    // A developer with the variable in their shell must not have a local
    // server phoning a live one.
    expect(keepAwakeUrl({ NODE_ENV: "development", RENDER_EXTERNAL_URL: "https://a.onrender.com" })).toBeNull();
    expect(keepAwakeUrl({ RENDER_EXTERNAL_URL: "https://a.onrender.com" })).toBeNull();
  });
});
