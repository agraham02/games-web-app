/**
 * The wire.
 *
 * Shared verbatim by the browser and the server, which is the point: a
 * message shape that drifts between the two is the classic way a
 * real-time feature rots, and there is no reason to describe it twice
 * when both ends are TypeScript in one repo.
 *
 * ## Tokens and session ids are not the same thing, deliberately
 *
 * The `token` is a **secret**. It lives in the client's `localStorage`, it
 * is how a returning player proves they are the person who owns seat 2,
 * and it is never shown to anybody else — a leaked one lets a stranger
 * reclaim your seat, your hand and your score.
 *
 * The `SessionId` is **public**. The server mints one per token and it is
 * what everything else addresses: who the leader is, who to kick, who owns
 * which seat. It appears in every roster sent to every member.
 *
 * Keeping them apart is what lets the roster be broadcast at all. Using
 * the token as the identifier — the obvious shortcut, since it is already
 * unique per person — would publish every member's credential to every
 * other member on the first roster update.
 */

import type { GameEvent, PieceId, PieceMeta, PlacementMap, SeatId } from "@/engine/types";
import type { BotDifficulty } from "@/engine/types";
import type { GameId, RawSettings } from "./registry";
import type { Privacy, RoomCode, RoomError, SessionId, TurnTimer } from "./room";

export const PROTOCOL_VERSION = 3;

/* ============================================================
   Client -> server
   ============================================================ */

/**
 * Mutating messages carry a `reqId` so a client can match an error back to
 * the thing it tried, and so a retry after a flaky send is recognisable
 * rather than being applied twice.
 */
export interface Addressed {
  reqId?: string;
}

export type ClientMessage =
  /** Always first. Establishes (or re-establishes) who is speaking. */
  | ({ t: "hello"; token: string; protocol: number } & Addressed)
  | ({ t: "createRoom"; name: string } & Addressed)
  | ({ t: "joinRoom"; code: RoomCode; name: string } & Addressed)
  | ({ t: "leaveRoom" } & Addressed)
  /**
   * This tab is leaving the room's page on purpose — the back gesture, a
   * link home — and is about to hang up. The server decides what that
   * means: somebody holding a seat in a running game keeps it (a bot plays
   * it, exactly as when they drop), anybody else leaves the room at once
   * instead of waiting out `LOBBY_GRACE_MS`. A refresh or a closed tab
   * never sends it, which is precisely the split wanted: those might be
   * back in a moment.
   */
  | ({ t: "bye" } & Addressed)
  /** Take back a knock on a private room that has not been answered. */
  | ({ t: "withdraw" } & Addressed)
  | ({ t: "rename"; name: string } & Addressed)
  | ({ t: "promote"; session: SessionId } & Addressed)
  | ({ t: "kick"; session: SessionId } & Addressed)
  | ({ t: "setPrivacy"; privacy: Privacy } & Addressed)
  | ({ t: "approve"; session: SessionId } & Addressed)
  | ({ t: "deny"; session: SessionId } & Addressed)
  | ({
      t: "selectGame";
      gameId: GameId;
      settings: RawSettings;
      seats: number;
      difficulty: BotDifficulty;
    } & Addressed)
  /** Leader only: the whole seating plan, `null` for a bot's seat. */
  | ({ t: "arrangeSeats"; plan: (SessionId | null)[] } & Addressed)
  | ({ t: "shuffleSeats" } & Addressed)
  | ({ t: "startGame" } & Addressed)
  | ({ t: "enterGame"; as?: "player" | "spectator" } & Addressed)
  | ({ t: "exitGame" } & Addressed)
  | ({ t: "endGame" } & Addressed)
  /** Leader only: closes the room for everybody in it. */
  | ({ t: "closeRoom" } & Addressed)
  /**
   * Your own photo, as a small JPEG or WebP data URL the browser has already
   * cropped (see `session/photo.ts`), or null to take it down.
   */
  | ({ t: "setPhoto"; image: string | null } & Addressed)
  /** Leader only, between games: the turn timer on or off, and how long. */
  | ({ t: "setTurnTimer"; on?: boolean; seconds?: number } & Addressed)
  /** "I'm back" — after the turn timer handed your seat to a bot. */
  | ({ t: "resume" } & Addressed)
  /** A move. `action` is the game's own action type, validated server-side. */
  | ({ t: "action"; action: unknown } & Addressed)
  | ({ t: "nextRound" } & Addressed)
  /**
   * `sent` is the client's own clock, echoed straight back in the `pong`,
   * so the client can time the round trip — the only latency it needs to
   * know, to show a turn clock that ends when the server's does.
   */
  | { t: "ping"; sent?: number };

/* ============================================================
   Server -> client
   ============================================================ */

/** One member, as everybody else is allowed to see them. */
export interface MemberView {
  session: SessionId;
  name: string;
  connected: boolean;
  /** Null when the game is not running, or they are not seated in it. */
  seat: SeatId | null;
  /** In the game and not seated. */
  spectating: boolean;
  /**
   * The side they play for in a partnership game, 0 or 1 — decided by the
   * seat (partners sit across) — or null where there are no teams or no seat.
   */
  team: number | null;
  isLeader: boolean;
  /** Their photo's id — fetch it from `photoUrl(id)` — or null for none. */
  photo: string | null;
  /** The turn timer has handed their seat to a bot until they come back. */
  idle: boolean;
}

export interface RoomView {
  code: RoomCode;
  privacy: Privacy;
  /** The recipient's own public id, so a client can find itself in `members`. */
  you: SessionId;
  youAreLeader: boolean;
  members: MemberView[];
  /**
   * Who sits in each seat when the next game is dealt, seat 0 first and
   * clockwise from there; `null` is a seat a bot plays. Entries past
   * `seats` are people who will watch because the table is full. See
   * `seatingPlan`.
   */
  seatPlan: (SessionId | null)[];
  /**
   * Only ever populated for the leader. Everyone else gets an empty list:
   * a pending request carries a name the room has not agreed to admit, and
   * broadcasting it would leak who is knocking to people with no say in it.
   */
  pending: Array<{ session: SessionId; name: string }>;
  gameId: GameId | null;
  settings: RawSettings;
  seats: number;
  difficulty: BotDifficulty;
  /** True while a game is running, whether or not the recipient is in it. */
  gameRunning: boolean;
  /** Seats nobody has claimed. Absent when no game is running. */
  openSeats: SeatId[];
  /** Whether the recipient is currently at the table. */
  inGame: boolean;
  /**
   * Whether the recipient may deal the next round: the leader at the table,
   * or anyone seated while the leader is not. See `mayContinueRound`.
   */
  youMayContinue: boolean;
  /**
   * Who pays whom for the last game played for money, from the moment it
   * finished or was ended until the next one starts (`settle.ts`). Null for
   * a game with no stake set, and before any game.
   */
  settlement: SettlementView | null;
  /** Between games, what the next one will be played with. */
  turnTimer: TurnTimer;
}

/**
 * The payments that square up a game played for money, with the names they
 * had when it ended — the lobby shows it after the table has gone, and the
 * seats it was worked out from may have changed hands by then.
 */
export interface SettlementView {
  gameId: GameId;
  /** "$20 buy-in", "25¢ a chip". */
  stake: string;
  /** Played to a winner, or ended by the leader partway through. */
  finished: boolean;
  /**
   * Everyone who sat at the table, most up first — including anybody who
   * has since left the room, who still owes or is owed for the time the
   * seat was theirs. Cents; negative owes.
   */
  results: Array<{ session: SessionId; name: string; cents: number }>;
  /** The fewest payments that square everyone up. */
  payments: Array<{ from: SessionId; fromName: string; to: SessionId; toName: string; cents: number }>;
  /** Some of the money was won from or lost to bots, and is left out. */
  botsLeftOut: boolean;
}

/**
 * One batch of things that happened at the table, already redacted for the
 * recipient. Every field is per-viewer: two people in the same room get
 * different `events`, different `state` and different `placements` out of
 * the same server-side turn.
 */
export interface FrameView {
  seq: number;
  events: GameEvent[];
  /** `playerView(state, seat)` — the game's own redaction. */
  state: unknown;
  /** Face-down pieces already swapped for anonymous stand-ins. */
  placements: PlacementMap;
  /** Meta for those stand-ins, to merge over the real piece meta. */
  meta: Record<PieceId, PieceMeta>;
  /** The recipient's seat, or null if they are watching. */
  seat: SeatId | null;
  currentSeat: SeatId | null;
  round: number;
  dealtRound: number | null;
  isOver: boolean;
  isRoundOver: boolean;
  winner: SeatId | null;
  winningSeats: SeatId[] | null;
  roundWinner: SeatId | null;
  roundWinningSeats: SeatId[] | null;
  /** Names by seat, so the table can label pods without a second lookup. */
  seatNames: Array<string | null>;
  /** Which seats a bot is currently playing — drives the "away" pod treatment. */
  botSeats: SeatId[];
  /**
   * The move that produced this frame, for a screen that needs to show
   * WHAT just happened rather than only its effect — LRC's dice overlay
   * reads the roll off it.
   *
   * Null when the action names something this viewer is not allowed to
   * identify. Spades' blind-nil exchange is the case: the action carries
   * the two cards being passed, and those are concealed from the
   * receiving side, so shipping the action would hand over exactly what
   * the redaction elsewhere is protecting.
   */
  lastAction: { seat: SeatId; action: unknown } | null;
}

export type ServerErrorCode =
  | RoomError
  | "no-room"
  | "bad-message"
  | "no-such-room"
  | "rate-limited"
  /**
   * The client is built against a different wire. Its own code because
   * it is the one error a reconnect cannot fix: the server says so and
   * closes, and a client that treats that as a network blip retries
   * forever behind a "Reconnecting…" spinner that will never resolve.
   */
  | "protocol-mismatch"
  /**
   * A move the server would not take. Its own code rather than
   * `bad-message`, because the two mean opposite things to a client: a
   * malformed frame is a bug worth surfacing loudly, while a rejected
   * move is ordinary — your view was a moment stale, or somebody beat
   * you to a claim — and the next frame already puts you right.
   */
  | "move-refused"
  /** Not a picture the server will keep: the wrong kind, or too big. */
  | "photo-rejected";

/**
 * What each refusal says out loud.
 *
 * The codes are the wire's vocabulary and the client switches on them; the
 * text is for a person, and it lives here rather than in the client so that
 * a `message` field sent by the server is already readable in a log, in the
 * ws harness, and in the one place the UI prints it verbatim. Every entry
 * is lower-case and sentence-shaped, because it is rendered inline next to
 * a control rather than as a heading.
 */
/**
 * Why a move was refused, in words.
 *
 * The reasons themselves come from the engine and are CODES - "not-in-game",
 * "illegal-action" - written for a caller, not for a person. They were being
 * forwarded onto the toast seam verbatim, so losing a race to press Continue
 * announced the string "not-in-game" to the player, in the one place a
 * refusal is most likely to be seen.
 *
 * Here for the same reason `ERROR_TEXT` is: the server sends the words, so a
 * log line, a harness transcript and the UI all say the same readable thing.
 */
export const MOVE_REFUSED_TEXT: Record<string, string> = {
  "not-your-turn": "it is not your turn",
  "illegal-action": "that move is not allowed",
  "game-over": "the game is already over",
  "round-over": "the round is already over",
  "no-game-running": "no game is running",
  "not-in-game": "you are not at the table",
};

/** The readable form of a refusal, falling back to something sayable. */
export function moveRefusedText(reason: string | undefined): string {
  return (reason && MOVE_REFUSED_TEXT[reason]) ?? "that move is no longer available";
}

export const ERROR_TEXT: Record<ServerErrorCode, string> = {
  "not-leader": "only the party leader can do that",
  "not-a-member": "you are not in this room",
  "name-required": "a name is needed to join a room",
  "name-taken": "somebody in this room already goes by that name",
  "needs-approval": "this room is private — the leader has to let you in",
  "no-such-request": "that request is no longer waiting",
  "no-game-selected": "pick a game first",
  "needs-two-players": "a room game needs at least two people here",
  "game-not-online": "that game cannot be played in a room yet",
  "game-already-running": "a game is already running",
  "no-game-running": "no game is running",
  "not-in-game": "you are not at the table",
  "cannot-target-self": "that one only works on somebody else",
  "bad-seat-count": "that seat count does not fit this game",
  "bad-seat-plan": "that seating plan does not match who is here",
  "bad-turn-timer": "that is not a length the turn timer can be",
  "room-full": "this room is full",
  "no-room": "you are not in a room",
  "bad-message": "that request could not be handled",
  "no-such-room": "no room with that code",
  "rate-limited": "slow down",
  "move-refused": "that move is no longer available",
  "protocol-mismatch": "this page is out of date — reload to keep playing",
  "photo-rejected": "that picture could not be used — try another",
};

export function errorText(code: ServerErrorCode): string {
  return ERROR_TEXT[code] ?? "something went wrong";
}

export type ServerMessage =
  /**
   * `inRoom` is the answer to "am I still where I think I am".
   *
   * A client caches the last roster it was sent so that a client-side
   * navigation does not strand it on "Connecting…". That cache outlives
   * the SERVER, though: restart the process and a reconnecting client
   * greeted with nothing but its own identity went on rendering a
   * complete, interactive lobby for a room that no longer existed, whose
   * every button then failed silently. Saying so plainly is the only
   * thing that distinguishes "you are new" from "that is gone".
   */
  | { t: "hello"; session: SessionId; protocol: number; inRoom: boolean }
  | { t: "room"; room: RoomView }
  | { t: "frame"; frame: FrameView }
  /** The recipient is no longer in any room — kicked, left, or it expired. */
  | {
      t: "left";
      /**
       * Why you are not in the room.
       *
       * `denied` is its own reason rather than being folded into
       * `room-closed`: a leader saying no and a room that no longer
       * exists are different things to be told, and the second is a lie
       * about a room that is very much still there. It was the only
       * answer a refused knock had.
       */
      reason: "left" | "kicked" | "room-closed" | "denied";
      /** `room-closed` by its leader: who closed it. */
      by?: string;
      /**
       * `room-closed`: who owes whom, when the last game was played for
       * money. The room — and the lobby that showed this — is gone, so it
       * travels with the news or nobody sees it.
       */
      settlement?: SettlementView | null;
    }
  /** Waiting on a private room's leader to decide. */
  | { t: "pending"; code: RoomCode }
  /**
   * Something happened in the room worth a glance — somebody joined, a
   * seat changed hands, the leader ended the game.
   *
   * A message rather than a field on `RoomView` because it is an EVENT,
   * not state: a roster update says who is here now, and cannot express
   * "Sam left" in a way that fires once and then stops being true. The
   * client surfaces these through the same `announce` toast seam bot
   * actions already use, so they obey the existing disclosure policy —
   * rung 3, never a banner, never a modal.
   */
  | { t: "notice"; text: string }
  /**
   * This SOCKET has been replaced by a newer one for the same identity —
   * almost always a second tab. The recipient is still a member, still
   * holds its seat, and is simply no longer the socket the room talks to.
   *
   * Distinct from `left`, which says the person is out of the room, and
   * distinct from an ordinary close, which says the network went away.
   * The difference is the whole point: a client that cannot tell a
   * deliberate takeover from a blip will RECONNECT, which closes the tab
   * that just took over, which reconnects... Two tabs on one machine
   * produced roughly four reconnections a second, indefinitely, and at
   * any instant one of them was holding a dead socket — which looks
   * exactly like the game desyncing.
   */
  | { t: "superseded" }
  | { t: "error"; code: ServerErrorCode; message: string; reqId?: string }
  /**
   * Whose move the table is waiting on, and how long they have — or null
   * when nobody's clock is running. Sent when it changes, and with the time
   * actually left to anybody arriving mid-move.
   *
   * Relative, never a time of day: `endsInMs` counts from the moment it was
   * sent, so two machines whose clocks disagree still agree on it. The
   * client takes off half a round trip. What anyone is shown ends
   * `TURN_GRACE_MS` before the server acts, so a move made as the ring
   * empties still arrives in time.
   */
  | { t: "turnClock"; clock: TurnClockView | null }
  | { t: "pong"; sent?: number };

export interface TurnClockView {
  seat: SeatId;
  /** Changes with the position: a new key is a new move's clock. */
  key: string;
  /** A full clock's worth, ms. */
  totalMs: number;
  /** Until the clock on screen runs out, from when this was sent. */
  endsInMs: number;
}

/* ============================================================
   Parsing — everything below assumes the sender is hostile
   ============================================================ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Turns a raw socket payload into a message, or null.
 *
 * Deliberately shallow: it proves the discriminant and the shape of the
 * fields this layer needs to route on, and leaves the semantic checks to
 * the room machine and the registry's `parse`, which is where the rules
 * about what a legal seat count or a legal action actually is already
 * live. Validating twice, in two places, is how the two drift apart.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.t !== "string") return null;

  const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : null);
  const reqId = typeof data.reqId === "string" ? data.reqId : undefined;

  switch (data.t) {
    case "ping":
      return typeof data.sent === "number" && Number.isFinite(data.sent)
        ? { t: "ping", sent: data.sent }
        : { t: "ping" };

    case "setTurnTimer": {
      const on = typeof data.on === "boolean" ? data.on : undefined;
      // Range and step are the room's to judge; this only proves a number.
      const seconds = typeof data.seconds === "number" ? data.seconds : undefined;
      if (on === undefined && seconds === undefined) return null;
      return { t: "setTurnTimer", on, seconds, reqId };
    }

    case "bye":
      return { t: "bye" };

    case "hello": {
      const token = str("token");
      if (!token) return null;
      const protocol = typeof data.protocol === "number" ? data.protocol : 0;
      return { t: "hello", token, protocol, reqId };
    }

    case "createRoom": {
      const name = str("name");
      return name === null ? null : { t: "createRoom", name, reqId };
    }

    case "joinRoom": {
      const code = str("code");
      const name = str("name");
      return code === null || name === null ? null : { t: "joinRoom", code, name, reqId };
    }

    case "rename": {
      const name = str("name");
      return name === null ? null : { t: "rename", name, reqId };
    }

    case "promote":
    case "kick":
    case "approve":
    case "deny": {
      const session = str("session");
      return session === null ? null : { t: data.t, session, reqId };
    }

    case "setPrivacy": {
      const privacy = data.privacy;
      if (privacy !== "public" && privacy !== "private") return null;
      return { t: "setPrivacy", privacy, reqId };
    }

    case "selectGame": {
      const gameId = str("gameId");
      if (!gameId) return null;
      const difficulty = data.difficulty;
      if (difficulty !== "casual" && difficulty !== "steady" && difficulty !== "sharp") return null;
      return {
        t: "selectGame",
        // Narrowed for real by the registry, which owns the list.
        gameId: gameId as GameId,
        settings: isRecord(data.settings) ? data.settings : {},
        seats: typeof data.seats === "number" ? data.seats : 0,
        difficulty,
        reqId,
      };
    }

    case "setPhoto": {
      const image = data.image;
      if (image !== null && typeof image !== "string") return null;
      return { t: "setPhoto", image, reqId };
    }

    case "arrangeSeats": {
      const plan = data.plan;
      if (!Array.isArray(plan) || plan.length > 64) return null;
      if (!plan.every((s) => s === null || typeof s === "string")) return null;
      return { t: "arrangeSeats", plan: plan as (SessionId | null)[], reqId };
    }

    case "action":
      // The action itself is the game's business: `legalActions` and the
      // seat gate in `GameSession.submit` decide, and neither of them can
      // be usefully anticipated here.
      return { t: "action", action: data.action, reqId };

    case "enterGame":
      return {
        t: "enterGame",
        as: data.as === "spectator" ? "spectator" : "player",
        reqId,
      };

    case "leaveRoom":
    case "withdraw":
    case "shuffleSeats":
    case "startGame":
    case "exitGame":
    case "endGame":
    case "closeRoom":
    case "resume":
    case "nextRound":
      return { t: data.t, reqId };

    default:
      return null;
  }
}

/* ============================================================
   The rejoin check — plain HTTP, not the socket (see server/rejoin.ts)
   ============================================================ */

/** `GET` it with the identity token in `TOKEN_HEADER`. */
export const REJOIN_PATH = "/api/rejoin";
export const TOKEN_HEADER = "x-table-games-token";

export interface RejoinAnswer {
  room: {
    code: string;
    /** The selected game's name, or null in a lobby with none picked. */
    game: string | null;
    /** Whether a game is being played right now. */
    running: boolean;
  } | null;
}
