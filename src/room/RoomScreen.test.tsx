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

import { StrictMode } from "react";
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
    seatPlan: ["me", "bo", null, null],
    pending: [],
    gameId: null,
    settings: {},
    seats: 4,
    difficulty: "steady",
    gameRunning: false,
    openSeats: [],
    inGame: false,
    youMayContinue: true,
    settlement: null,
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
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Renders and gets past the handshake into the entry screen. */
  async function open() {
    render(<RoomScreen />);
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    socket().deliver({ t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: false });
    await screen.findByText("Rooms");
  }

  it("does not flash the join form while a returning member's room is on its way", async () => {
    // `hello` says "you are still in a room" a moment before the room
    // itself; the gap used to render the join form on every reload.
    render(<RoomScreen code="ABCD" />);
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    socket().deliver({ t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: true });
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    socket().deliver({ t: "room", room: roomView() });
    expect(await screen.findByText("ABCD")).toBeInTheDocument();
  });

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

  it("presses the primary button on Enter: Make, until a whole code makes it Join", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ada" } });
    const form = screen.getByLabelText(/your name/i).closest("form")!;

    fireEvent.change(screen.getByLabelText(/room code/i), { target: { value: "wxyz" } });
    fireEvent.submit(form);
    expect(socket().lastSent("joinRoom")).toMatchObject({ code: "WXYZ", name: "Ada" });
    expect(socket().lastSent("createRoom")).toBeUndefined();

    fireEvent.change(screen.getByLabelText(/room code/i), { target: { value: "" } });
    fireEvent.submit(form);
    expect(socket().lastSent("createRoom")).toMatchObject({ name: "Ada" });
  });

  it("asks for the rest of a half-typed code on Enter, rather than making a room", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ada" } });
    const code = screen.getByLabelText(/room code/i);
    fireEvent.change(code, { target: { value: "wx" } });
    fireEvent.keyDown(code, { key: "Enter" });

    expect(socket().lastSent("createRoom")).toBeUndefined();
    expect(socket().lastSent("joinRoom")).toBeUndefined();
    expect(await screen.findByText("A room code is 4 letters")).toBeInTheDocument();
    expect(code).toHaveFocus();
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

    it("lets go of a room the server no longer has", async () => {
      // A server restart is the ordinary way here: the socket comes back,
      // `hello` answers "you are not in a room", and everything on screen
      // describes one that no longer exists. The connection already dropped
      // its replay cache on this, but that only decides what a FUTURE mount
      // sees - the tab that is open kept its own state, so the player was
      // left holding a fully interactive lobby whose every button answers
      // `no-room`, which nothing renders.
      await enterLobby();
      expect(screen.getByText("ABCD")).toBeInTheDocument();

      socket().deliver({
        t: "hello",
        session: "me",
        protocol: PROTOCOL_VERSION,
        inRoom: false,
      });

      await screen.findByText("Rooms");
      expect(screen.queryByText("ABCD")).not.toBeInTheDocument();
    });

    it("shows the code and everybody in the room", async () => {
      await enterLobby();
      expect(screen.getByText("ABCD")).toBeInTheDocument();
      expect(screen.getByText("Ada")).toBeInTheDocument();
      expect(screen.getByText("Bo")).toBeInTheDocument();
    });

    it("lists every seat, bots included, with the team each seat plays for", async () => {
      await enterLobby({ gameId: "spades", seats: 4, seatPlan: ["me", "bo", null, null] });
      const plan = screen.getByRole("list", { name: "Seating plan" });
      expect(plan.querySelectorAll("li")).toHaveLength(4);
      expect(screen.getAllByText("Bot")).toHaveLength(2);
      // Partners sit across: seats 1 and 3 against 2 and 4.
      expect(screen.getAllByText("Team A")).toHaveLength(2);
      expect(screen.getAllByText("Team B")).toHaveLength(2);
      expect(screen.getByText(/clockwise/)).toBeInTheDocument();
    });

    it("lets the leader move somebody with the keyboard, and sends the plan", async () => {
      await enterLobby({ gameId: "spades", seats: 4, seatPlan: ["me", "bo", null, null] });
      fireEvent.keyDown(screen.getByRole("button", { name: /move ada/i }), { key: "ArrowDown" });
      expect(socket().lastSent("arrangeSeats")).toMatchObject({ plan: ["bo", "me", null, null] });
    });

    it("gives nobody but the leader a grip", async () => {
      await enterLobby({ youAreLeader: false, gameId: "spades", seats: 4, seatPlan: ["me", "bo", null, null] });
      expect(screen.queryByRole("button", { name: /move /i })).toBeNull();
    });

    it("shows everyone but the leader the rules as they ARE, just locked", async () => {
      // A locked toggle used to render as off whatever its value, so every
      // non-leader was told Partners and Key tile were off while the leader
      // (and the Team A/B chips beside them) said they were on.
      await enterLobby({
        youAreLeader: false,
        gameId: "dominoes",
        settings: { mode: "caribbean", teams: true, keyTileBonus: true, sixLove: false },
      });
      // On a phone somebody else's game folds to one line — which already
      // says the rules as they are.
      expect(screen.getByText(/Dominoes · Caribbean · .*Partners on · Key tile on · Six love off/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      const teams = await screen.findByRole("switch", { name: /partners/i });
      expect(teams).toHaveAttribute("aria-checked", "true");
      expect(teams).toHaveAttribute("aria-readonly", "true");
      expect(screen.getByRole("switch", { name: /six love/i })).toHaveAttribute("aria-checked", "false");
      // By label, not role: Base UI keeps a slider's thumb invisible until
      // it has measured the track, jsdom never lays anything out, and an
      // invisible input computes no accessible name.
      expect(screen.getByLabelText(/bot skill/i)).toBeDisabled();
    });

    it("does not tell the maker of a fresh room that the table is full", async () => {
      // No game yet means no seats: the plan's count is 0, and every row
      // used to read "No seat — Will watch — table full".
      await enterLobby({ gameId: null, seats: 0, seatPlan: ["me"] });
      expect(screen.queryByText(/table full/i)).toBeNull();
      expect(screen.queryByText(/no seat/i)).toBeNull();
      expect(screen.getByText(/pick a game to set up the seats/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /shuffle seats/i })).toBeNull();
    });

    it("puts the code in the address bar so it can be shared", async () => {
      await enterLobby();
      expect(replace).toHaveBeenCalledWith("/room/ABCD");
    });

    it("says what Start is waiting for, in words", async () => {
      // The button said it only through `title`, which a phone never shows.
      await enterLobby({ youAreLeader: false, gameId: null, seats: 0, seatPlan: ["me"] });
      expect(screen.getByText("Ada is choosing a game")).toBeInTheDocument();
    });

    it("tells somebody who is not the leader who they are waiting on", async () => {
      await enterLobby({ youAreLeader: false, gameId: "spades", seats: 4 });
      expect(screen.getByText("Waiting for Ada to start")).toBeInTheDocument();
    });

    it("gives the leader the controls, and dims them for everyone else", async () => {
      // Dimmed rather than missing, per the disclosure policy: hiding them
      // would rearrange the lobby every time leadership moved, which it
      // does whenever the leader's phone sleeps.
      await enterLobby({ youAreLeader: false, gameId: "spades" });
      const privacy = screen.getByRole("button", { name: /anyone with the code/i });
      expect(privacy).toBeDisabled();
    });

    it("gives Start to the leader alone", async () => {
      // The exception to dimming: somebody else could never press it, at
      // any point, and the status line already says who they wait on.
      await enterLobby({ youAreLeader: false, gameId: "spades" });
      expect(screen.queryByRole("button", { name: /start/i })).toBeNull();
      expect(screen.getByText("Waiting for Ada to start")).toBeInTheDocument();
    });

    it("shows join requests to the leader alone", async () => {
      const pending = [{ session: "knocker", name: "Knocker" }];
      await enterLobby({ privacy: "private", pending });
      expect(screen.getByText("Knocker")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /^let in$/i }));
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
        const button = screen.queryByRole("button", { name: new RegExp(`^${GAMES[id].name},`) });
        if (GAMES[id].online) expect(button, `${id} should be offered`).not.toBeNull();
        else expect(button, `${id} cannot be drawn`).toBeNull();
      }

      const note = screen.queryByText(/single-player only/i);
      if (offline.length === 0) expect(note).toBeNull();
      else expect(note).toBeInTheDocument();
    });

    it("offers a seat or a seat-free watch once a game is running", async () => {
      await enterLobby({ gameId: "spades", gameRunning: true, openSeats: [2, 3] });
      fireEvent.click(screen.getByRole("button", { name: /watch instead/i }));
      expect(socket().lastSent("enterGame")).toMatchObject({ as: "spectator" });

      fireEvent.click(screen.getByRole("button", { name: /join the game/i }));
      expect(socket().lastSent("enterGame")).toMatchObject({ as: "player" });
    });

    it("says so instead of offering a seat at a full table", async () => {
      // `openSeats` was on the room view and never read, so this button
      // was always enabled — and pressing it at a full table quietly made
      // you a spectator, announced only by a toast.
      await enterLobby({ gameId: "spades", gameRunning: true, openSeats: [] });

      expect(screen.getByRole("button", { name: /table is full/i })).toBeDisabled();
      // Watching is still on offer, and is now the honest way in.
      expect(screen.getByRole("button", { name: /watch instead/i })).toBeEnabled();
    });

    it("tells a kicked player, and sends them back to the entry screen", async () => {
      await enterLobby();
      socket().deliver({ t: "left", reason: "kicked" });
      expect(await screen.findByText("Rooms")).toBeInTheDocument();
      // On the form, where it stays — not a toast that was gone in four
      // seconds — and naming the room.
      expect(screen.getByText("You were removed from room ABCD.")).toBeInTheDocument();
      // Not offered back: the code field starts empty, so Join is not the
      // button Enter would press.
      expect(screen.getByLabelText(/room code/i)).toHaveValue("");
      expect(screen.getByRole("button", { name: /^join room$/i })).toBeDisabled();
    });

    it("sends somebody who leaves home, not to the room's own invitation", async () => {
      // It used to land on the entry form at /room/ABCD: "You have been
      // invited to a room" — to the room they had just walked out of.
      await enterLobby();
      fireEvent.click(screen.getByRole("button", { name: /leave room/i }));
      expect(socket().lastSent("leaveRoom")).toBeDefined();

      socket().deliver({ t: "left", reason: "left" });
      expect(replace).toHaveBeenCalledWith("/");
      expect(screen.queryByText(/you have been invited/i)).toBeNull();
    });

    it("waits visibly on a private room's leader", async () => {
      await open();
      socket().deliver({ t: "pending", code: "WXYZ" });
      expect(await screen.findByText(/waiting to be let in/i)).toBeInTheDocument();
      expect(screen.getByText(/WXYZ is a private room/i)).toBeInTheDocument();
    });
  });

  /* ---------- arriving from the home page ---------- */

  /**
   * Renders past the handshake without waiting for any particular screen.
   * In StrictMode, as the dev server runs it: reading the intent inside a
   * state updater consumed it on the first of React's two runs, and the
   * room was never made (found in Chrome).
   */
  async function arrive(code?: string) {
    render(
      <StrictMode>
        <RoomScreen code={code} />
      </StrictMode>,
    );
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    socket().deliver({ t: "hello", session: "me", protocol: PROTOCOL_VERSION, inRoom: false });
  }

  it("makes the room the home page asked for, without asking again", async () => {
    window.localStorage.setItem("table-games.display-name", "Ada");
    window.sessionStorage.setItem("table-games.entry-intent", JSON.stringify({ t: "make" }));
    await arrive();

    await waitFor(() =>
      expect(socket().lastSent("createRoom")).toMatchObject({ t: "createRoom", name: "Ada" }),
    );
    expect(screen.getByText("Making your room…")).toBeInTheDocument();
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    // Consumed: a refresh must not make a second room.
    expect(window.sessionStorage.getItem("table-games.entry-intent")).toBeNull();
  });

  it("joins the room the home page asked for", async () => {
    window.localStorage.setItem("table-games.display-name", "Ada");
    window.sessionStorage.setItem(
      "table-games.entry-intent",
      JSON.stringify({ t: "join", code: "WXYZ" }),
    );
    await arrive("WXYZ");

    await waitFor(() =>
      expect(socket().lastSent("joinRoom")).toMatchObject({ code: "WXYZ", name: "Ada" }),
    );
    expect(screen.getByText("Joining WXYZ…")).toBeInTheDocument();
  });

  it("shows a refused join on the join form, with the reason", async () => {
    window.localStorage.setItem("table-games.display-name", "Ada");
    window.sessionStorage.setItem(
      "table-games.entry-intent",
      JSON.stringify({ t: "join", code: "WXYZ" }),
    );
    await arrive("WXYZ");
    await waitFor(() => expect(socket().lastSent("joinRoom")).toBeDefined());

    socket().deliver({ t: "error", code: "no-such-room", message: "no such room" });

    expect(await screen.findByText("No room with that code")).toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Ada");
  });

  it("keeps a turned-down knock on the form, with the room ready to ask again", async () => {
    await arrive("WXYZ");
    socket().deliver({ t: "pending", code: "WXYZ" });
    socket().deliver({ t: "left", reason: "denied" });

    expect(
      await screen.findByText("The leader of room WXYZ didn't let you in. Ask again, or make your own room."),
    ).toBeInTheDocument();
    // Asking again is one press: the code is still there, and Join is the
    // button Enter would press.
    expect(screen.getByLabelText(/room code/i)).toHaveValue("WXYZ");
    const join = screen.getByRole("button", { name: /^join room$/i });
    expect(join).toBeEnabled();
    expect(join).toHaveAttribute("type", "submit");
  });

  it("shows a name somebody already has under the name, and stays an invitation", async () => {
    window.localStorage.setItem("table-games.display-name", "Ada");
    window.sessionStorage.setItem(
      "table-games.entry-intent",
      JSON.stringify({ t: "join", code: "WXYZ" }),
    );
    await arrive("WXYZ");
    await waitFor(() => expect(socket().lastSent("joinRoom")).toBeDefined());

    socket().deliver({
      t: "error",
      code: "name-taken",
      message: "somebody in this room already goes by that name",
    });

    expect(
      await screen.findByText("Somebody in this room already goes by that name"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join room WXYZ" })).toBeInTheDocument();
  });

  it("asks somebody who followed a link to JOIN that room, not to make one", async () => {
    await arrive("ABCD");

    expect(await screen.findByRole("button", { name: "Join room ABCD" })).toBeInTheDocument();
    // Making a room is still possible, but it is not the button beside the name.
    expect(screen.queryByRole("button", { name: /^make a room$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /make a room of your own/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/room code/i)).toBeNull();
  });
});
