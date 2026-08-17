/**
 * Left Right Center — GameDefinition.
 *
 * Rules verified against gamerules.com, ultraboardgames.com and
 * officialgamerules.org before writing this (see dice.ts for the die
 * face distribution, which is the one detail every source needs read
 * carefully — it is NOT an even split).
 *
 * One deliberate departure from the printed rules: a player who reaches
 * zero chips is out for the rest of the game, not merely skipped until
 * a later pass happens to reach them again. L/R dice redirect past an
 * eliminated seat to the next one still in — see `passLeft`/`passRight`
 * in state.ts for exactly how.
 */

import type {
  GameDefinition,
  GameEvent,
  PieceId,
  PieceMeta,
  Placement,
  PlacementMap,
  ReduceResult,
  SeatId,
  SetupOptions,
} from "@/engine/types";
import { HERO } from "@/engine/types";
import type { LrcAction, LrcState } from "./types";
import { lrcBots } from "./bots";
import { activeSeats, chipsHeld, nextActiveSeat, ownedChips, passLeft, passRight, potSize } from "./state";

export const CHIPS_PER_PLAYER = 3;

function chipId(seat: SeatId, index: number): PieceId {
  return `chip-${seat}-${index}`;
}

export function setup(opts: SetupOptions): LrcState {
  const chipOwner: Record<PieceId, SeatId | "pot"> = {};
  const all: SeatId[] = [];
  for (let seat = 0; seat < opts.seats; seat++) {
    all.push(seat);
    for (let i = 0; i < CHIPS_PER_PLAYER; i++) {
      chipOwner[chipId(seat, i)] = seat;
    }
  }
  // A real cut for who rolls first, then plain rotation from there
  // (`nextActiveSeat`). It used to be a hardcoded `HERO`, which meant the
  // hero opened every single game — the same thing Spades' own setup was
  // fixed for. LRC is pure luck, so going first is a real edge, and
  // always having it is both unfair and immediately noticeable.
  return { seats: opts.seats, chipOwner, turn: opts.rng.pick(all), winner: null };
}

export function reduce(
  state: LrcState,
  action: LrcAction,
): ReduceResult<LrcState> {
  const seat = state.turn;
  const chipOwner = { ...state.chipOwner };
  const events: GameEvent[] = [];

  // Every die face that isn't a dot claims one of THIS seat's own chips,
  // oldest-held first — a stable pre-roll snapshot, so a later die in
  // this same roll never double-claims a chip an earlier die already
  // moved away.
  const owned = ownedChips(state, seat);
  let cursor = 0;

  for (const face of action.dice) {
    if (face === "dot") continue;
    const piece = owned[cursor++];
    if (!piece) break; // Defensive: a well-formed action never hits this.

    if (face === "C") {
      chipOwner[piece] = "pot";
      events.push({ t: "move", piece, to: potPlacement(state) });
    } else {
      const target = face === "L" ? passLeft(state, seat) : passRight(state, seat);
      chipOwner[piece] = target;
      events.push({
        t: "move",
        piece,
        to: heldPlacement(target, 0), // index/count corrected by reindex in the table layer
      });
    }
  }

  let next: LrcState = { ...state, chipOwner };
  const stillActive = activeSeats(next);

  if (stillActive.length <= 1) {
    const winner = stillActive[0] ?? seat;
    next = { ...next, winner };
    events.push({
      t: "announce",
      seat: winner,
      text: winner === HERO ? "You win the pot!" : "Takes the pot",
      tone: winner === HERO ? "good" : "info",
    });
    events.push({ t: "gameEnd", winner });
  } else {
    next = { ...next, turn: nextActiveSeat(next, seat) };
  }

  return { state: next, events };
}

export function legalActions(state: LrcState, seat: SeatId): LrcAction[] {
  if (state.winner !== null || state.turn !== seat) return [];
  // Shape sentinel — the real dice are resolved at submission time (see
  // dice.ts / types.ts), not enumerated here.
  return [{ t: "roll", dice: [] }];
}

// Both of these hand out placeholder index/count values — good enough
// for one instant, since applyEvent's reindex() renormalizes every
// piece sharing a zone+seat bucket immediately after, before React ever
// renders the intermediate value. Safe even when two dice in the SAME
// roll both land on "C": both compute the same pre-roll potSize, tie,
// and reindex resolves the tie deterministically.
function heldPlacement(seat: SeatId, index: number): Placement {
  return { zone: "collected", seat, index, count: 1, faceUp: true };
}

function potPlacement(state: LrcState): Placement {
  return { zone: "center", index: potSize(state), count: potSize(state) + 1, faceUp: true };
}

export function pieces(state: LrcState): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  // One colour for every chip, not a cycled palette. A chip's colour has
  // never meant anything here — it doesn't track which die face last
  // moved it, and real LCR chips are plain besides — so the earlier
  // three-colour cycle was pure decoration. It backfired on a pile:
  // three different colours read as three separate small things sitting
  // together, not as one pile, which fights the whole point of a chip
  // stack (glance at it, read the count). Uniform colour reads as a
  // single pile whose height still tells you how many.
  for (let seat = 0; seat < state.seats; seat++) {
    for (let i = 0; i < CHIPS_PER_PLAYER; i++) {
      out[chipId(seat, i)] = { kind: "chip", face: "ruby" };
    }
  }
  return out;
}

// No `viewer` param: nothing in LRC is hidden, so every seat sees the
// identical board — TS is fine with a function taking fewer parameters
// than the GameDefinition.placements type declares, since the extra
// arg a caller passes is simply unused rather than mismatched.
export function placements(state: LrcState): PlacementMap {
  const out: PlacementMap = {};
  const perSeatIndex: Record<string, number> = {};
  const seatCounts: Record<SeatId, number> = {};
  for (let s = 0; s < state.seats; s++) seatCounts[s] = chipsHeld(state, s);

  const pot = potSize(state);
  let potIndex = 0;

  for (const [piece, owner] of Object.entries(state.chipOwner)) {
    if (owner === "pot") {
      out[piece] = { zone: "center", index: potIndex++, count: pot, faceUp: true, fanned: true };
    } else {
      const i = perSeatIndex[owner] ?? 0;
      perSeatIndex[owner] = i + 1;
      out[piece] = {
        zone: "collected",
        seat: owner,
        index: i,
        count: seatCounts[owner] ?? 1,
        faceUp: true,
      };
    }
  }
  return out;
}

/** No hidden information in LRC — every chip count is public. */
export function playerView(state: LrcState): LrcState {
  return state;
}

export function currentSeat(state: LrcState): SeatId | null {
  return state.winner === null ? state.turn : null;
}

export function isOver(state: LrcState): boolean {
  return state.winner !== null;
}

export const lrc: GameDefinition<LrcState, LrcAction> = {
  id: "lrc",
  name: "Left Right Center",
  minSeats: 3,
  maxSeats: 10,
  setup,
  reduce,
  legalActions,
  pieces,
  placements,
  playerView,
  currentSeat,
  isOver,
  bots: lrcBots,
};
