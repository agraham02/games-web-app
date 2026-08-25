// @vitest-environment node

/**
 * The debug endpoints, which exist to be dangerous in exactly one
 * environment and inert everywhere else.
 *
 * Two properties are worth pinning, and neither is about what they
 * return: that production refuses them outright, and that the one which
 * ACTS on a live game will not do so on a verb the web treats as safe to
 * fetch on its own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TestClock } from "@/session/clock";
import { RoomRegistry } from "./RoomRegistry";
import { handleDebugRequest } from "./debug";

/** Just enough of a response to see what was written to it. */
function fakeRes() {
  const res = {
    status: 0,
    body: "",
    writeHead(status: number) {
      res.status = status;
      return res as unknown as ServerResponse;
    },
    end(payload?: string) {
      res.body = payload ?? "";
    },
  };
  return res;
}

function request(method: string, url: string) {
  return { method, url } as IncomingMessage;
}

describe("the debug endpoints", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses everything in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const registry = new RoomRegistry({ clock: new TestClock(), seed: 1 });
    const res = fakeRes();

    const handled = handleDebugRequest(
      request("GET", "/debug/rooms"),
      res as unknown as ServerResponse,
      registry,
    );

    // Handled, so it never reaches Next — and answered with nothing.
    expect(handled).toBe(true);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("rooms");
  });

  it("will not drop a player on a GET", () => {
    // It answered any verb, so a pasted link, a prefetch or a crawler on a
    // dev box was enough to disconnect somebody mid-hand.
    const clock = new TestClock();
    const registry = new RoomRegistry({ clock, seed: 1 });
    const runtime = registry.create("s1", "Ada");
    const dropped = vi.spyOn(runtime, "dropConnection");
    const res = fakeRes();

    handleDebugRequest(
      request("GET", `/debug/drop/${runtime.code}/s1`),
      res as unknown as ServerResponse,
      registry,
    );

    expect(res.status).toBe(405);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("still drops on a POST, which is what the tests use it for", () => {
    const clock = new TestClock();
    const registry = new RoomRegistry({ clock, seed: 1 });
    const runtime = registry.create("s1", "Ada");
    runtime.attach("s1", { send: () => {}, close: () => {}, bufferedAmount: () => 0 });
    const dropped = vi.spyOn(runtime, "dropConnection");
    const res = fakeRes();

    handleDebugRequest(
      request("POST", `/debug/drop/${runtime.code}/s1`),
      res as unknown as ServerResponse,
      registry,
    );

    expect(res.status).toBe(200);
    expect(dropped).toHaveBeenCalledWith("s1");
  });
});
