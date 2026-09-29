// @vitest-environment node

/**
 * The home page's "am I still in a room?". Two properties matter beyond
 * the answer itself: asking must not create an identity (a stranger
 * probing tokens mints nothing), and only a room the asker is actually IN
 * is ever offered.
 */

import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TestClock } from "@/session/clock";
import { RoomRegistry } from "./RoomRegistry";
import { REJOIN_PATH, TOKEN_HEADER, handleRejoinRequest, type RejoinAnswer } from "./rejoin";

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

function ask(registry: RoomRegistry, token?: string, method = "GET") {
  const res = fakeRes();
  const req = {
    method,
    url: REJOIN_PATH,
    headers: token ? { [TOKEN_HEADER]: token } : {},
  } as unknown as IncomingMessage;
  const handled = handleRejoinRequest(req, res as unknown as ServerResponse, registry);
  return { handled, status: res.status, answer: res.body ? (JSON.parse(res.body) as RejoinAnswer) : null };
}

describe("the rejoin check", () => {
  it("names the room somebody is still a member of", () => {
    const registry = new RoomRegistry({ clock: new TestClock(), seed: 1 });
    const session = registry.sessionFor("token-a");
    const runtime = registry.create(session, "Ada");

    const { handled, status, answer } = ask(registry, "token-a");

    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(answer?.room).toEqual({ code: runtime.code, game: null, running: false });
  });

  it("offers nothing to a token in no room, and mints no identity for asking", () => {
    const registry = new RoomRegistry({ clock: new TestClock(), seed: 1 });
    registry.create(registry.sessionFor("token-a"), "Ada");

    expect(ask(registry, "somebody-else").answer?.room).toBeNull();
    expect(ask(registry).answer?.room).toBeNull();
    expect(registry.peekSession("somebody-else")).toBeNull();
  });

  it("stops offering a room once it is gone", () => {
    const registry = new RoomRegistry({ clock: new TestClock(), seed: 1 });
    const runtime = registry.create(registry.sessionFor("token-a"), "Ada");
    registry.destroy(runtime.code);

    expect(ask(registry, "token-a").answer?.room).toBeNull();
  });

  it("leaves every other path to the rest of the server", () => {
    const registry = new RoomRegistry({ clock: new TestClock(), seed: 1 });
    const res = fakeRes();
    const req = { method: "GET", url: "/room", headers: {} } as unknown as IncomingMessage;
    expect(handleRejoinRequest(req, res as unknown as ServerResponse, registry)).toBe(false);
  });

  it("answers only GET", () => {
    const registry = new RoomRegistry({ clock: new TestClock(), seed: 1 });
    expect(ask(registry, "token-a", "POST").status).toBe(405);
  });
});
