"use client";

/**
 * Everything a room page needs, in one subscription.
 *
 * The division of labour worth knowing: this hook owns ROOM state — who is
 * here, who leads, what game is selected, whether one is running. It does
 * not own the table. Frames are handed straight to `useOnlineRuntime`,
 * which turns them into the same `GameRuntime` shape `GameHost` already
 * consumes, so nothing below the host knows or cares that the game is
 * happening on a server.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotDifficulty } from "@/engine/types";
import type { GameId, RawSettings } from "@/session/registry";
import type {
  ClientMessage,
  FrameView,
  RoomView,
  ServerErrorCode,
  SettlementView,
} from "@/session/protocol";
import { CHAT_HISTORY, type ChatMessage } from "@/session/chat";
import { announce } from "@/ui/disclosure";
import { roomConnection, type ConnectionStatus } from "./connection";

export type RoomPhase =
  /** Nothing sent yet, or waiting on the first reply. */
  | "connecting"
  /** Not in a room: the create/join screen. */
  | "idle"
  /** Knocked on a private room; waiting on the leader. */
  | "pending"
  /** In a room. */
  | "in-room"
  /** Another tab for this identity took the connection. */
  | "superseded";

/**
 * Why this client is not in the room it was in, and which room that was.
 *
 * Kept, not announced: a toast of "They did not let you in" landed on top
 * of the invitation it was answering and was gone in four seconds, leaving
 * an unexplained form behind. The entry form shows it, for as long as it is
 * the latest thing that happened (`RoomEntryForm`'s `notice`), and a leave
 * the player asked for sends them home instead.
 */
export interface Farewell {
  reason: "left" | "kicked" | "room-closed" | "denied";
  code: string | null;
  /** `room-closed`: the leader who closed it. */
  by?: string;
  /** `room-closed`: who owes whom, if the last game was played for money. */
  settlement?: SettlementView | null;
  /** `room-closed`: this player pressed it. */
  byYou?: boolean;
  /** Who this player was in the room — `SettleUp` says "you" by it. */
  you?: string;
}

export interface RoomApi {
  phase: RoomPhase;
  status: ConnectionStatus;
  room: RoomView | null;
  /** The code we are waiting on approval for, while `phase === "pending"`. */
  pendingCode: string | null;
  error: { code: ServerErrorCode; message: string } | null;
  /** The last way out of a room; cleared by the next room, knock or attempt. */
  farewell: Farewell | null;
  clearError: () => void;
  /** Takes the connection back from another tab. See `phase: "superseded"`. */
  resume: () => void;
  /** The newest frame, or null when no game is running or we are in the lobby. */
  frame: FrameView | null;

  createRoom: (name: string) => void;
  joinRoom: (code: string, name: string) => void;
  leaveRoom: () => void;
  /** Take back a knock on a private room. See `phase: "pending"`. */
  withdraw: () => void;
  rename: (name: string) => void;
  promote: (session: string) => void;
  kick: (session: string) => void;
  setPrivacy: (privacy: "public" | "private") => void;
  approve: (session: string) => void;
  deny: (session: string) => void;
  selectGame: (
    gameId: GameId,
    settings: RawSettings,
    seats: number,
    difficulty: BotDifficulty,
  ) => void;
  /** Leader only: the whole seating plan, `null` for a bot's seat. */
  arrangeSeats: (plan: (string | null)[]) => void;
  shuffleSeats: () => void;
  startGame: () => void;
  enterGame: (as?: "player" | "spectator") => void;
  exitGame: () => void;
  endGame: () => void;
  /** Leader only: closes the room for everybody in it. */
  closeRoom: () => void;
  /** Your photo for this room (a small data URL — `photoFromFile`), or null to take it down. */
  setPhoto: (image: string | null) => void;
  /** What has been said in the room, oldest first, at most `CHAT_HISTORY`. */
  chat: ChatMessage[];
  /**
   * The newest message that arrived as HISTORY — the log replayed on
   * joining, reconnecting or changing page — rather than as it was said.
   * Anything after it is news; anything up to it was said before you got
   * here, and popping it up as if it were new would replay the room's past.
   */
  chatLiveAfter: number;
  /** Says something: typed text, or a quick reply by id. */
  sendChat: (said: { text: string } | { quick: string }) => void;
  send: (message: ClientMessage) => void;
}

export function useRoom(): RoomApi {
  const connection = useMemo(() => roomConnection(), []);
  const [status, setStatus] = useState<ConnectionStatus>(connection.status);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [frame, setFrame] = useState<FrameView | null>(null);
  const [error, setError] = useState<{ code: ServerErrorCode; message: string } | null>(null);
  const [farewell, setFarewell] = useState<Farewell | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatLiveAfter, setChatLiveAfter] = useState(0);
  /** The room we are in or knocking on, for `farewell` to name. Read inside
   * the message handler, which is created once and would see stale state. */
  const codeRef = useRef<string | null>(null);
  /** Whether a room is on screen, for the same reason `codeRef` is a ref. */
  const inRoomRef = useRef(false);
  /** Who we are in the room on screen, for the farewell to remember. */
  const youRef = useRef<string | null>(null);
  /** This player asked to close the room, so its `room-closed` is theirs. */
  const closingRef = useRef(false);
  const [greeted, setGreeted] = useState(false);
  /**
   * The server said this identity is still in a room, and the room itself
   * has not arrived yet. It follows `hello` a moment later, and in that gap
   * the page drew the join form ("You have been invited…") on every reload
   * of a room (seen in Chrome, 2026-09-26).
   */
  const [awaitingRoom, setAwaitingRoom] = useState(false);

  // The newest frame wins, always. An older one arriving late (or a
  // re-render racing a burst) must never roll the table backwards, and
  // sequence numbers are the only ordering the wire guarantees.
  const lastSeq = useRef(-1);

  useEffect(() => {
    const off = connection.subscribe({
      onStatus: setStatus,
      onMessage: (message) => {
        switch (message.t) {
          case "hello":
            setGreeted(true);
            setAwaitingRoom(message.inRoom);
            // The server has just said whether this identity is still in a
            // room, and a reconnect is the only time it can say no while we
            // are showing one. `connection` already drops its replay cache
            // on this (see its own `hello` case), but that only decides what
            // a FUTURE mount replays - the tab that is open keeps its React
            // state, so a server restart left a fully interactive lobby for a
            // room that no longer existed, every button on it answering
            // `no-room` into a screen that renders no error.
            if (!message.inRoom) {
              inRoomRef.current = false;
              setChat([]);
              setChatLiveAfter(0);
              setRoom(null);
              setFrame(null);
              lastSeq.current = -1;
              // A knock the server has forgotten cannot be approved, so
              // sitting on "waiting to be let in" would wait forever.
              setPendingCode((code) => {
                if (code) announce("That room is no longer there.");
                return null;
              });
            }
            break;

          case "room":
            setAwaitingRoom(false);
            inRoomRef.current = true;
            youRef.current = message.room.you;
            setRoom(message.room);
            setPendingCode(null);
            setFarewell(null);
            codeRef.current = message.room.code;
            // Whatever was last refused, it is moot: we are in a room and
            // the server is talking to us. Nothing else ever cleared this,
            // so a failed join left "no room with that code" sitting under
            // the code field long after a later join had worked, and a
            // refusal from inside a room greeted the player on the entry
            // screen the next time they left one.
            setError(null);
            if (!message.room.gameRunning) {
              // The table is gone; anything still on screen from it is
              // stale. Clearing here rather than waiting for a frame is
              // what makes "the leader ended the game" land immediately.
              setFrame(null);
              lastSeq.current = -1;
            }
            break;

          case "frame":
            // `seq` 0 is a position, not a step — the server sends one on
            // reconnect and on entering a game — so it is always accepted.
            if (message.frame.seq !== 0 && message.frame.seq < lastSeq.current) break;
            lastSeq.current = message.frame.seq;
            setFrame(message.frame);
            break;

          case "pending":
            setAwaitingRoom(false);
            setPendingCode(message.code);
            inRoomRef.current = false;
            setRoom(null);
            setFarewell(null);
            codeRef.current = message.code;
            break;

          case "left":
            setAwaitingRoom(false);
            inRoomRef.current = false;
            setChat([]);
            setChatLiveAfter(0);
            setRoom(null);
            setFrame(null);
            setPendingCode(null);
            lastSeq.current = -1;
            // Every reason is said out loud — only "kicked" used to be, so
            // being turned away from a private room dropped you back on the
            // entry screen with no explanation at all. Said on the FORM now
            // (see `Farewell`), rather than as a toast over it.
            setFarewell({
              reason: message.reason,
              code: codeRef.current,
              by: message.by,
              settlement: message.settlement ?? null,
              byYou: message.reason === "room-closed" && closingRef.current,
              you: youRef.current ?? undefined,
            });
            codeRef.current = null;
            closingRef.current = false;
            break;

          case "chatLog":
            setChat(message.messages);
            setChatLiveAfter(message.messages.at(-1)?.id ?? 0);
            break;

          case "chat":
            setChat((log) => [...log, message.message].slice(-CHAT_HISTORY));
            break;

          case "notice":
            // Straight onto the existing toast seam, so a join or a
            // disconnect reads exactly like a bot's move already does.
            announce(message.text, "info");
            break;

          case "error":
            // Whatever this answers, a close we asked for did not happen.
            closingRef.current = false;
            // A refused MOVE is not a form error. It has no control to sit
            // next to — the thing that caused it was a tap on a card — and
            // the only screen that renders `error` is the entry form, so
            // it used to vanish entirely: you tapped, nothing happened,
            // and nothing said why. It goes on the toast seam instead,
            // which is where everything else that "just happened" goes.
            //
            // It is also deliberately NOT stored: a stale "not your turn"
            // outliving the turn it referred to is worse than silence, and
            // that is exactly what greeted people on the entry screen
            // later, because nothing ever cleared it.
            if (message.code === "move-refused") {
              announce(message.message || "that move is no longer available", "bad");
              break;
            }
            // Any other refusal from inside a room goes the same way, for
            // the same reason: the entry form is not on screen to show it.
            // A Start refused because somebody had just dropped (they look
            // present through their silent `LOBBY_GRACE_MS`) said nothing
            // at all.
            if (inRoomRef.current) {
              announce(message.message, "bad");
              break;
            }
            setAwaitingRoom(false);
            setError({ code: message.code, message: message.message });
            break;

          case "pong":
            break;
        }
      },
    });
    connection.connect();
    return off;
  }, [connection]);

  const send = useCallback((message: ClientMessage) => connection.send(message), [connection]);

  // Checked before `room`, deliberately. The cached roster is kept so
  // resuming lands back at the table, but while another tab holds the
  // socket it describes a room this tab is no longer talking to — and a
  // lobby whose every button silently does nothing is worse than saying
  // plainly what happened.
  const phase: RoomPhase =
    status === "superseded"
      ? "superseded"
      : room
        ? "in-room"
        : pendingCode
          ? "pending"
          : greeted && status === "open" && !awaitingRoom
            ? "idle"
            : "connecting";

  return useMemo(
    (): RoomApi => ({
      phase,
      status,
      room,
      pendingCode,
      frame,
      error,
      clearError: () => setError(null),
      farewell,
      resume: () => connection.resume(),
      send,
      // A new attempt clears the last one's answer, so a refusal that is
      // about to be repeated is not still on screen while it is asked again.
      createRoom: (name) => {
        setError(null);
        setFarewell(null);
        send({ t: "createRoom", name });
      },
      joinRoom: (code, name) => {
        setError(null);
        setFarewell(null);
        send({ t: "joinRoom", code: code.toUpperCase(), name });
      },
      leaveRoom: () => send({ t: "leaveRoom" }),
      withdraw: () => send({ t: "withdraw" }),
      rename: (name) => send({ t: "rename", name }),
      promote: (session) => send({ t: "promote", session }),
      kick: (session) => send({ t: "kick", session }),
      setPrivacy: (privacy) => send({ t: "setPrivacy", privacy }),
      approve: (session) => send({ t: "approve", session }),
      deny: (session) => send({ t: "deny", session }),
      selectGame: (gameId, settings, seats, difficulty) =>
        send({ t: "selectGame", gameId, settings, seats, difficulty }),
      arrangeSeats: (plan) => send({ t: "arrangeSeats", plan }),
      shuffleSeats: () => send({ t: "shuffleSeats" }),
      startGame: () => send({ t: "startGame" }),
      enterGame: (as) => send({ t: "enterGame", as }),
      exitGame: () => send({ t: "exitGame" }),
      endGame: () => send({ t: "endGame" }),
      closeRoom: () => {
        closingRef.current = true;
        send({ t: "closeRoom" });
      },
      setPhoto: (image) => send({ t: "setPhoto", image }),
      chat,
      chatLiveAfter,
      sendChat: (said) => send({ t: "chat", ...said }),
    }),
    [phase, status, room, pendingCode, frame, error, farewell, chat, chatLiveAfter, send, connection],
  );
}
