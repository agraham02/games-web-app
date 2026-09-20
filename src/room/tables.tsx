"use client";

/**
 * Which games a room can actually put on screen.
 *
 * This exists because of a bug worth not repeating. The shared registry
 * marks a game `online`, and the server honours that by agreeing to start
 * one — but agreeing to start a game and being able to RENDER it are two
 * different claims, held in two different places, and they drifted. Three
 * games were marked online while the room could only draw Spades, so
 * picking one of them would have dealt a real game onto a table showing
 * somebody else's.
 *
 * The registry cannot own this itself: it is imported by the server, and
 * these are React components. So the two lists stay separate and a test
 * (`tables.test.tsx`) asserts they agree — every game the registry calls
 * online must appear here. Adding a game to one and forgetting the other
 * is now a failing test rather than a broken table.
 */

import type { GameId } from "@/session/registry";
import type { FrameView, RoomView } from "@/session/protocol";
import type { RoomApi } from "./useRoom";
import type { PieceId } from "@/engine/types";
import { BsOnline } from "./tables/BsOnline";
import { DominoesOnline } from "./tables/DominoesOnline";
import { LrcOnline } from "./tables/LrcOnline";
import { PokerOnline } from "./tables/PokerOnline";
import { RummyOnline } from "./tables/RummyOnline";
import { SpadesOnline } from "./tables/SpadesOnline";

/**
 * What every game's online table is handed. Deliberately the same shape
 * for all of them: the room, the frame, and the scratch state a table
 * needs to keep across a trip out to the lobby and back.
 */
export interface OnlineTableProps {
  api: RoomApi;
  room: RoomView;
  frame: FrameView;
  /** Pieces the player has picked up but not yet committed. */
  held: PieceId[];
  onToggleHeld: (id: PieceId) => void;
  onClearHeld: () => void;
  /**
   * The raw setter, for a game whose selection has a RULE — how many may
   * be held, what picking one up looks like. `onToggleHeld` is a bare
   * toggle and cannot express either, which is how Spades' online
   * exchange came to disagree with its offline one.
   */
  setHeld: (next: (prev: PieceId[]) => PieceId[]) => void;
}

export type OnlineTableComponent = (props: OnlineTableProps) => React.ReactNode;

/**
 * All six. Rummy was the last of the original five in, and it sat out not
 * because the room could not draw it but because its RULES answered "the
 * human" with seat 0 in three places — see the note on `GameEntry.online`.
 *
 * BS came after that work rather than before it, and cost almost nothing as a
 * result: a game whose `deadline`, `validate` and redaction were built for two
 * drivers from the first commit needs wiring here, not rules changes.
 */

export const TABLES: Partial<Record<GameId, OnlineTableComponent>> = {
  spades: SpadesOnline,
  poker: PokerOnline,
  dominoes: DominoesOnline,
  lrc: LrcOnline,
  rummy: RummyOnline,
  bs: BsOnline,
};

export function tableFor(gameId: GameId | null): OnlineTableComponent | null {
  return gameId ? (TABLES[gameId] ?? null) : null;
}
