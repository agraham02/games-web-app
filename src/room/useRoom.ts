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
import type { ClientMessage, FrameView, RoomView, ServerErrorCode } from "@/session/protocol";
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

export interface RoomApi {
  phase: RoomPhase;
  status: ConnectionStatus;
  room: RoomView | null;
  /** The code we are waiting on approval for, while `phase === "pending"`. */
  pendingCode: string | null;
  error: { code: ServerErrorCode; message: string } | null;
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
  assignTeam: (session: string, team: number) => void;
  randomizeTeams: () => void;
  startGame: () => void;
  enterGame: (as?: "player" | "spectator") => void;
  exitGame: () => void;
  endGame: () => void;
  send: (message: ClientMessage) => void;
}

export function useRoom(): RoomApi {
  const connection = useMemo(() => roomConnection(), []);
  const [status, setStatus] = useState<ConnectionStatus>(connection.status);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [frame, setFrame] = useState<FrameView | null>(null);
  const [error, setError] = useState<{ code: ServerErrorCode; message: string } | null>(null);
  const [greeted, setGreeted] = useState(false);

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
            // The server has just said whether this identity is still in a
            // room, and a reconnect is the only time it can say no while we
            // are showing one. `connection` already drops its replay cache
            // on this (see its own `hello` case), but that only decides what
            // a FUTURE mount replays - the tab that is open keeps its React
            // state, so a server restart left a fully interactive lobby for a
            // room that no longer existed, every button on it answering
            // `no-room` into a screen that renders no error.
            if (!message.inRoom) {
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
            setRoom(message.room);
            setPendingCode(null);
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
            setPendingCode(message.code);
            setRoom(null);
            break;

          case "left":
            setRoom(null);
            setFrame(null);
            setPendingCode(null);
            lastSeq.current = -1;
            // Every reason is said out loud. Only "kicked" used to be,
            // so being turned away from a private room — or having the
            // room closed under you — dropped you back on the entry
            // screen with no explanation at all.
            announce(
              message.reason === "kicked"
                ? "You were removed"
                : message.reason === "denied"
                  ? "They did not let you in"
                  : message.reason === "room-closed"
                    ? "That room is closed"
                    : "You left the room",
              message.reason === "left" ? "info" : "bad",
            );
            break;

          case "notice":
            // Straight onto the existing toast seam, so a join or a
            // disconnect reads exactly like a bot's move already does.
            announce(message.text, "info");
            break;

          case "error":
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
          : greeted && status === "open"
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
      resume: () => connection.resume(),
      send,
      createRoom: (name) => send({ t: "createRoom", name }),
      joinRoom: (code, name) => send({ t: "joinRoom", code: code.toUpperCase(), name }),
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
      assignTeam: (session, team) => send({ t: "assignTeam", session, team }),
      randomizeTeams: () => send({ t: "randomizeTeams" }),
      startGame: () => send({ t: "startGame" }),
      enterGame: (as) => send({ t: "enterGame", as }),
      exitGame: () => send({ t: "exitGame" }),
      endGame: () => send({ t: "endGame" }),
    }),
    [phase, status, room, pendingCode, frame, error, send, connection],
  );
}
