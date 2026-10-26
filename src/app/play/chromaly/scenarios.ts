/**
 * Dev-panel scenarios: positions that are only reachable by waiting.
 *
 * A window opens when somebody reaches their last card without calling it, or
 * holds the twin of what was just played - rare enough in ordinary play that
 * looking at one means grinding through rounds. Each of these arranges the
 * table and then lets the engine's own `reduce` make the move that opens it,
 * so what is on screen is exactly what play would have produced rather than a
 * state written by hand and hoped to be the same.
 *
 * The panel knows nothing about what they do (see `GameHostProps.scenarios`),
 * so none of this rig leaks into it.
 */

import { HERO, type PieceId, type SeatId } from "@/engine/types";
import { deckIds, parseCard } from "@/games/chromaly/cards";
import { reduce } from "@/games/chromaly/rules";
import type { ChromalyAction, ChromalyRules, ChromalyState } from "@/games/chromaly/types";
import type { GameRuntime } from "@/table/useGameRuntime";

type Live = GameRuntime<ChromalyState, ChromalyAction>;

interface Layout {
  /** Seats named here get exactly these cards. */
  hands: Record<number, PieceId[]>;
  top: PieceId;
  turn: SeatId;
  rules?: Partial<ChromalyRules>;
  /** Cards to sit at the top of the draw pile, next to be drawn first. */
  draw?: PieceId[];
  /** Leave only this many cards in the draw pile (the pile-empty case). */
  drawPileSize?: number;
}

/**
 * Re-deals the table around named hands, keeping the deck whole: every other
 * seat keeps its size (topped up from the pile where a named card was taken
 * from it), and everything unaccounted for goes to the draw pile.
 */
function arrange(state: ChromalyState, layout: Layout): ChromalyState {
  const rules = { ...state.rules, ...layout.rules };
  const all = deckIds(rules.shuffleHands);
  const named = new Set<PieceId>([layout.top, ...Object.values(layout.hands).flat(), ...(layout.draw ?? [])]);
  const spare = all.filter((id) => !named.has(id));

  const hands: Record<SeatId, PieceId[]> = {};
  for (let s = 0; s < state.seats; s++) {
    const seat = s as SeatId;
    if (layout.hands[seat]) {
      hands[seat] = [...layout.hands[seat]!];
      continue;
    }
    const size = (state.hands[seat] ?? []).length || 7;
    hands[seat] = spare.splice(0, Math.max(2, size));
  }

  let drawPile = [...spare];
  if (layout.drawPileSize !== undefined) drawPile = drawPile.slice(0, layout.drawPileSize);
  // The pile draws from the END, so what is named first goes last.
  drawPile = [...drawPile, ...[...(layout.draw ?? [])].reverse()];
  const placed = new Set<PieceId>([layout.top, ...Object.values(hands).flat(), ...drawPile]);
  // Whatever is left over goes under the top card, so the deck stays whole.
  const under = all.filter((id) => !placed.has(id));

  const topCard = parseCard(layout.top)!;
  return {
    ...state,
    rules,
    hands,
    drawPile,
    discard: [...under, layout.top],
    color: topCard.color ?? "R",
    direction: 1,
    turn: layout.turn,
    drawn: null,
    pendingDraw: null,
    challenge: null,
    window: null,
    calls: Object.fromEntries(
      Object.entries(hands)
        .filter(([, h]) => h.length === 1)
        .map(([s]) => [Number(s), "passed" as const]),
    ),
    result: null,
    winner: null,
    dealt: true,
  };
}

/** Arranges the table, then makes one move on it with the real engine. */
function after(state: ChromalyState, layout: Layout, move: ChromalyAction): ChromalyState {
  return reduce(arrange(state, layout), move).state;
}

export function chromalyScenarios(live: Live) {
  const go = (build: (s: ChromalyState) => ChromalyState) => () => live.replaceState(build(live.rawState));

  return [
    {
      // Seat 1 goes down to one card without saying so. The button comes up
      // for everybody; the first to press it wins.
      label: "Somebody forgot to call",
      run: go((s) =>
        after(
          s,
          { hands: { 1: ["R3.1", "R4.1"], [HERO]: ["B1.1", "G2.1", "Y3.1", "B4.1"] }, top: "R5.1", turn: 1 },
          { t: "play", cards: ["R3.1"] },
        ),
      ),
    },
    {
      // You are on two cards on your turn: the button pops up beside Draw.
      label: "You are on two cards",
      run: go((s) =>
        arrange(s, {
          hands: { [HERO]: ["R3.1", "R4.1"] },
          top: "R5.1",
          turn: HERO,
        }),
      ),
    },
    {
      // Seat 1 plays a red 7 and you hold the twin: the jump-in window.
      label: "Jump-in window",
      run: go((s) =>
        after(
          s,
          {
            hands: { 1: ["R7.1", "B1.1", "B2.1"], [HERO]: ["R7.2", "G2.1", "Y3.1", "B4.1"] },
            top: "R5.1",
            turn: 1,
            rules: { jumpIn: true },
          },
          { t: "play", cards: ["R7.1"] },
        ),
      ),
    },
    {
      // A Wild +4 aimed at you, played over a red card: a real bluff.
      label: "+4 challenge (a bluff)",
      run: go((s) =>
        after(
          s,
          {
            hands: { 1: ["F.1", "R2.1", "B1.1"], [HERO]: ["B1.2", "G2.1", "Y3.1", "B4.1"] },
            top: "R5.1",
            turn: 1,
          },
          { t: "play", cards: ["F.1"], color: "B" },
        ),
      ),
    },
    {
      // A Draw 2 with stacking on, and you hold a Draw 2 of your own.
      label: "Stack to answer",
      run: go((s) =>
        after(
          s,
          {
            hands: { 1: ["RD.1", "B1.1", "B2.1"], [HERO]: ["GD.1", "G2.1", "Y3.1", "F.2"] },
            top: "R5.1",
            turn: 1,
            rules: { stacking: "upward" },
          },
          { t: "play", cards: ["RD.1"] },
        ),
      ),
    },
    {
      label: "7 to swap",
      run: go((s) =>
        arrange(s, {
          hands: { [HERO]: ["R7.1", "R0.1", "B1.1", "G2.1"], 1: ["Y1.1"], 2: ["Y2.1", "Y3.1", "Y4.1"] },
          top: "R5.1",
          turn: HERO,
          rules: { sevenZero: true },
        }),
      ),
    },
    {
      label: "Pair to play",
      run: go((s) =>
        arrange(s, {
          hands: { [HERO]: ["R3.1", "R3.2", "B3.1", "G3.1", "B8.1", "Y9.1"] },
          top: "R5.1",
          turn: HERO,
          rules: { doubles: true },
        }),
      ),
    },
    {
      label: "Draw pile nearly empty",
      run: go((s) =>
        arrange(s, {
          hands: { [HERO]: ["B1.1", "G2.1", "Y3.1"] },
          top: "R5.1",
          turn: HERO,
          drawPileSize: 1,
        }),
      ),
    },
  ];
}
