/**
 * Your own move, shown before the server has answered.
 *
 * Online, a move used to sit still until its frame came back: a round trip
 * of nothing, and on a weak connection a long one (the user's playtest,
 * 2026-10-02). This is the client half of the standard answer — predict
 * your own move, let the server confirm it, correct it in the rare case
 * they disagree (`useOnlineRuntime` does the confirming).
 *
 * It works because a viewer's state (`playerView`) is the real state's
 * shape with the hidden parts swapped for placeholders, so the game's own
 * `reduce` runs on it. Where the move depends only on what the mover can
 * see — playing a card from their own hand — that gives exactly what the
 * server will. Where it depends on something hidden, it does not, and the
 * rules below say so rather than guess:
 *
 *  - The **gesture** is the run of leading piece moves in the result whose
 *    pieces the viewer can name — the card leaving your hand, the meld going
 *    down — with what the table says about them (BS's claim). It plays at
 *    once. It stops at the first event that is anything else — a bot
 *    thinking, a trick being collected, a slam — and the confirming frame
 *    plays those.
 *  - The **state** is predicted only if no event names a hidden piece and
 *    the round goes on. That rules out what is scored from hidden hands
 *    (going out, a blocked round), a new poker street, a draw from the
 *    stock. Without it the gesture still plays and the table waits for the
 *    server for the rest.
 *
 * A game opts a move out entirely with `unpredictable` — a race (Rummy's
 * claim, BS's call), or a move the server rewrites before taking it
 * (`completeAction`: LRC's dice, Spades' blind vote).
 *
 * `predict.test.ts` holds all of this to the truth: across whole games
 * played through the real server, a prediction may never disagree with the
 * frame that answers it.
 */

import type { GameDefinition, GameEvent, PieceId, PlacementMap, SeatId } from "@/engine/types";
import { withFacing } from "./redact";

export interface Prediction<S> {
  /** Shown at once: the mover's own pieces, moving. */
  gesture: GameEvent[];
  /** The position after the move, as this viewer will be shown it — or null. */
  state: S | null;
}

/**
 * What a gesture may hold: pieces moving, and what the table says about it
 * — BS's claim is said before its cards go down, and the claim is the move.
 */
const GESTURE = new Set<GameEvent["t"]>(["play", "move", "draw", "flip", "announce"]);

function piecesIn(event: GameEvent): PieceId[] {
  switch (event.t) {
    case "deal":
    case "draw":
    case "play":
    case "move":
    case "flip":
    case "highlight":
    case "slam":
    case "unmask":
      return [event.piece];
    case "collect":
    case "sweep":
      return event.pieces;
    case "mask":
      return [...event.drop, ...event.add.map((a) => a.piece)];
    default:
      return [];
  }
}

/**
 * Predicts `seat`'s `action` against `view`, the viewer's own state.
 * `known` says whether the viewer can name a piece: real pieces it has been
 * told about, never a placeholder. Null when there is nothing to predict.
 */
export function predict<S, A>(
  definition: GameDefinition<S, A>,
  view: S,
  seat: SeatId,
  action: A,
  known: (piece: PieceId) => boolean,
): Prediction<S> | null {
  if (definition.unpredictable?.(view, seat, action)) return null;
  if (definition.isOver(view) || definition.isRoundOver?.(view)) return null;
  if (definition.legalActions(view, seat).length === 0) return null;
  if (definition.validate?.(view, seat, action)) return null;

  let next: S;
  let raw: GameEvent[];
  let after: PlacementMap;
  try {
    ({ state: next, events: raw } = definition.reduce(view, action));
    after = definition.placements(next, seat);
  } catch {
    // A view is not the whole truth, and a reduce that needed what is
    // missing may throw. That is a move to wait for, not an error.
    return null;
  }
  // Faced as the server's projection faces them: by where each piece lands
  // for this viewer (a card drawn into your own hand is face up to you).
  // Only ever asked of a piece the viewer can name, whose place in a view's
  // board is real.
  const events = raw.map((event) => withFacing(event, after));

  const blind = events.some((event) => !piecesIn(event).every(known));
  const ends = definition.isOver(next) || Boolean(definition.isRoundOver?.(next));
  // Through `playerView` again: the server's frame is the truth seen by this
  // seat, and some of what the move did is hidden even from the mover (BS's
  // pile is face down to everybody, including whoever just played to it).
  const state = blind || ends ? null : definition.playerView(next, seat);

  // A toast only where the whole move is predicted: its words can be worked
  // out from what is hidden ("Sam goes out — 21" is scored from the other
  // hands), and nothing hidden went into a move whose state is known.
  const gesture: GameEvent[] = [];
  for (const event of events) {
    const shown = event.t === "announce" ? state !== null : GESTURE.has(event.t);
    if (!shown || !piecesIn(event).every(known)) break;
    gesture.push(event);
  }
  // A toast alone is not a move to show: wait for the frame that has one.
  if (!gesture.some((event) => event.t !== "announce")) gesture.length = 0;

  if (gesture.length === 0 && state === null) return null;
  return { gesture, state };
}
