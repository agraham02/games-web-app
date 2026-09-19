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
import type { Privacy, RoomCode, RoomError, SessionId } from "./room";

export const PROTOCOL_VERSION = 1;

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
  | ({ t: "assignTeam"; session: SessionId; team: number } & Addressed)
  | ({ t: "randomizeTeams" } & Addressed)
  | ({ t: "startGame" } & Addressed)
  | ({ t: "enterGame"; as?: "player" | "spectator" } & Addressed)
  | ({ t: "exitGame" } & Addressed)
  | ({ t: "endGame" } & Addressed)
  /** A move. `action` is the game's own action type, validated server-side. */
  | ({ t: "action"; action: unknown } & Addressed)
  | ({ t: "nextRound" } & Addressed)
  | { t: "ping" };

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
  team: number | null;
  isLeader: boolean;
}

export interface RoomView {
  code: RoomCode;
  privacy: Privacy;
  /** The recipient's own public id, so a client can find itself in `members`. */
  you: SessionId;
  youAreLeader: boolean;
  members: MemberView[];
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

export type ServerErrorCode = RoomError | "no-room" | "bad-message" | "no-such-room" | "rate-limited";

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
  "no-room": "you are not in a room",
  "bad-message": "that request could not be handled",
  "no-such-room": "no room with that code",
  "rate-limited": "slow down",
};

export function errorText(code: ServerErrorCode): string {
  return ERROR_TEXT[code] ?? "something went wrong";
}

export type ServerMessage =
  | { t: "hello"; session: SessionId; protocol: number }
  | { t: "room"; room: RoomView }
  | { t: "frame"; frame: FrameView }
  /** The recipient is no longer in any room — kicked, left, or it expired. */
  | { t: "left"; reason: "left" | "kicked" | "room-closed" }
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
  | { t: "pong" };

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
      return { t: "ping" };

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

    case "assignTeam": {
      const session = str("session");
      if (session === null || typeof data.team !== "number") return null;
      return { t: "assignTeam", session, team: data.team, reqId };
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
    case "randomizeTeams":
    case "startGame":
    case "exitGame":
    case "endGame":
    case "nextRound":
      return { t: data.t, reqId };

    default:
      return null;
  }
}
