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
  held: string[];
  onToggleHeld: (id: string) => void;
  onClearHeld: () => void;
}

export type OnlineTableComponent = (props: OnlineTableProps) => React.ReactNode;

/**
 * All five, and the last one in was Rummy. It sat out not because the
 * room could not draw it but because its RULES answered "the human" with
 * seat 0 in three places — see the note on `GameEntry.online`.
 */

export const TABLES: Partial<Record<GameId, OnlineTableComponent>> = {
  spades: SpadesOnline,
  poker: PokerOnline,
  dominoes: DominoesOnline,
  lrc: LrcOnline,
  rummy: RummyOnline,
};

export function tableFor(gameId: GameId | null): OnlineTableComponent | null {
  return gameId ? (TABLES[gameId] ?? null) : null;
}
