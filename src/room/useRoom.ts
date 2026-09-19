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
            break;

          case "room":
            setRoom(message.room);
            setPendingCode(null);
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
            if (message.reason === "kicked") announce("You were removed", "bad");
            break;

          case "notice":
            // Straight onto the existing toast seam, so a join or a
            // disconnect reads exactly like a bot's move already does.
            announce(message.text, "info");
            break;

          case "error":
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
