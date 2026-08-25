// @vitest-environment jsdom

/**
 * The room client, driven against a fake socket.
 *
 * Everything else in this feature is verified either as pure logic or
 * over a real WebSocket against the authoritative server. Neither of those
 * touches the part a person actually uses: whether the entry screen sends
 * what it claims to, whether the lobby shows the right people the right
 * controls, whether a kicked player is told.
 *
 * A stubbed `WebSocket` is what makes that testable without a browser —
 * the connection layer was written as a plain class over the global for
 * exactly this reason.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type RoomView, type ServerMessage } from "@/session/protocol";
import { GAMES, GAME_IDS } from "@/session/registry";
import { RoomScreen } from "./RoomScreen";
import { __resetRoomConnectionForTests } from "./connection";

/* ============================================================
   A socket that does nothing but record and replay
   ============================================================ */

const sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readonly CONNECTING = 0;
  readonly OPEN = 1;

  readyState = FakeSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
    // Asynchronous like the real thing, so the queueing path in
    // `RoomConnection` is the one under test rather than being skipped.
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Pushes a server message at the client. */
  deliver(message: ServerMessage): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(message) });
    });
  }

  lastSent(t: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.t === t);
  }
}

function socket(): FakeSocket {
  const s = sockets[sockets.length - 1];
  if (!s) throw new Error("no socket was opened");
  return s;
}

/** The room the server would send, with sensible defaults. */
function roomView(over: Partial<RoomView> = {}): RoomView {
  return {
    code: "ABCD",
    privacy: "public",
    you: "me",
    youAreLeader: true,
    members: [
      { session: "me", name: "Ada", connected: true, seat: null, spectating: false, team: null, isLeader: true },
      { session: "bo", name: "Bo", connected: true, seat: null, spectating: false, team: null, isLeader: false },
    ],
    pending: [],
    gameId: null,
    settings: {},
    seats: 4,
    difficulty: "steady",
    gameRunning: false,
    openSeats: [],
    inGame: false,
    ...over,
  };
}

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

describe("the room client", () => {
  beforeEach(() => {
    sockets.length = 0;
    replace.mockClear();
    __resetRoomConnectionForTests();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Renders and gets past the handshake into the entry screen. */
  async function open() {
    render(<RoomScreen />);
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    socket().deliver({ t: "hello", session: "me", protocol: PROTOCOL_VERSION });
    await screen.findByText("Rooms");
  }

  it("says hello with the stored token before anything else", async () => {
    await open();
    const hello = socket().sent[0]!;
    expect(hello.t).toBe("hello");
    expect(hello.protocol).toBe(PROTOCOL_VERSION);
    expect(typeof hello.token).toBe("string");
    expect((hello.token as string).length).toBeGreaterThan(8);
  });

  it("will not create a room without a name", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /make a room/i }));

    expect(socket().lastSent("createRoom")).toBeUndefined();
    expect(await screen.findByText(/a name is needed/i)).toBeInTheDocument();
  });

  it("creates a room with the name that was typed", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "  Ada  " } });
    fireEvent.click(screen.getByRole("button", { name: /make a room/i }));

    expect(socket().lastSent("createRoom")).toMatchObject({ t: "createRoom", name: "Ada" });
  });

  it("remembers the name for next time", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: /make a room/i }));
    expect(window.localStorage.getItem("table-games.display-name")).toBe("Ada");
  });

  it("uppercases a join code and refuses a short one", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ada" } });

    const code = screen.getByLabelText(/room code/i);
    fireEvent.change(code, { target: { value: "ab" } });
    expect(screen.getByRole("button", { name: /join room/i })).toBeDisabled();

    fireEvent.change(code, { target: { value: "abcd" } });
    fireEvent.click(screen.getByRole("button", { name: /join room/i }));
    expect(socket().lastSent("joinRoom")).toMatchObject({ code: "ABCD", name: "Ada" });
  });

  describe("the lobby", () => {
    async function enterLobby(over: Partial<RoomView> = {}) {
      await open();
      socket().deliver({ t: "room", room: roomView(over) });
      await screen.findByText("ABCD");
    }

    it("shows the code and everybody in the room", async () => {
      await enterLobby();
      expect(screen.getByText("ABCD")).toBeInTheDocument();
      expect(screen.getByText("Ada")).toBeInTheDocument();
      expect(screen.getByText("Bo")).toBeInTheDocument();
    });

    it("puts the code in the address bar so it can be shared", async () => {
      await enterLobby();
      expect(replace).toHaveBeenCalledWith("/room/ABCD");
    });

    it("gives the leader the controls, and dims them for everyone else", async () => {
      // Dimmed rather than missing, per the disclosure policy: hiding them
      // would rearrange the lobby every time leadership moved, which it
      // does whenever the leader's phone sleeps.
      await enterLobby({ youAreLeader: false, gameId: "spades" });
      expect(screen.getByRole("button", { name: /start spades/i })).toBeDisabled();

      const privacy = screen.getByRole("button", { name: /anyone with the code/i });
      expect(privacy).toBeDisabled();
    });

    it("shows join requests to the leader alone", async () => {
      const pending = [{ session: "knocker", name: "Knocker" }];
      await enterLobby({ privacy: "private", pending });
      expect(screen.getByText("Knocker")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /let in/i }));
      expect(socket().lastSent("approve")).toMatchObject({ session: "knocker" });
    });

    it("offers every game the registry calls online, and says so about the rest", async () => {
      // All five are online now — Rummy was the last, and needed its RULES
      // changed rather than its wiring. So the lobby offers all of them
      // and the "single-player only" note has nothing to name.
      //
      // Driven off the registry rather than a hardcoded list, because the
      // bug this guards is precisely the two lists drifting apart: it is
      // the same assertion whether the answer is five, four or six.
      await enterLobby();
      const offline = GAME_IDS.filter((id) => !GAMES[id].online);

      for (const id of GAME_IDS) {
        const button = screen.queryByRole("button", { name: GAMES[id].name });
        if (GAMES[id].online) expect(button, `${id} should be offered`).not.toBeNull();
        else expect(button, `${id} cannot be drawn`).toBeNull();
      }

      const note = screen.queryByText(/single-player only/i);
      if (offline.length === 0) expect(note).toBeNull();
      else expect(note).toBeInTheDocument();
    });

    it("offers a seat or a seat-free watch once a game is running", async () => {
      await enterLobby({ gameId: "spades", gameRunning: true });
      fireEvent.click(screen.getByRole("button", { name: /watch instead/i }));
      expect(socket().lastSent("enterGame")).toMatchObject({ as: "spectator" });

      fireEvent.click(screen.getByRole("button", { name: /join the game/i }));
      expect(socket().lastSent("enterGame")).toMatchObject({ as: "player" });
    });

    it("tells a kicked player, and sends them back to the entry screen", async () => {
      await enterLobby();
      socket().deliver({ t: "left", reason: "kicked" });
      expect(await screen.findByText("Rooms")).toBeInTheDocument();
    });

    it("waits visibly on a private room's leader", async () => {
      await open();
      socket().deliver({ t: "pending", code: "WXYZ" });
      expect(await screen.findByText(/waiting to be let in/i)).toBeInTheDocument();
      expect(screen.getByText(/WXYZ is a private room/i)).toBeInTheDocument();
    });
  });
});
