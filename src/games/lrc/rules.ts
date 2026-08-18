/**
 * Left Right Center — GameDefinition.
 *
 * Rules verified against gamerules.com, ultraboardgames.com and
 * officialgamerules.org before writing this (see dice.ts for the die
 * face distribution, which is the one detail every source needs read
 * carefully — it is NOT an even split).
 *
 * One deliberate departure from the printed rules: a player who reaches
 * zero chips is out for the rest of the ROUND, not merely skipped until
 * a later pass happens to reach them again. L/R dice redirect past an
 * eliminated seat to the next one still in — see `passLeft`/`passRight`
 * in state.ts for exactly how. They come back at full strength the
 * moment the next round deals.
 *
 * Played as a MATCH of rounds, not one pot-win — the same shape as
 * Dominoes. `setup` returns an undealt skeleton (every chip in the
 * `"bank"`, `dealt: false`); `startRound` sweeps whatever the last round
 * left, cuts a fresh random seat to roll first, and deals 3 chips to
 * everyone. A round's winner earns one point toward `target`; nothing
 * else about a round (chip count, elimination) survives into the next
 * one.
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
import type { Rng } from "@/engine/rng";
import { botName } from "@/games/_shared/botIdentity";
import type { LrcAction, LrcState } from "./types";
import { lrcBots } from "./bots";
import {
  activeSeats,
  chipsHeld,
  nextActiveSeat,
  ownedChips,
  passLeft,
  passRight,
  potSize,
} from "./state";

export const CHIPS_PER_PLAYER = 3;

/** A match is "first to N rounds won." No printed convention to anchor
 * a default on (LRC has no target score the way Dominoes' 61/100 do) —
 * 5 keeps an opening match short without being over in one pot. */
export const LRC_DEFAULT_TARGET = 5;
export const LRC_TARGET_MIN = 1;
export const LRC_TARGET_MAX = 20;

function chipId(seat: SeatId, index: number): PieceId {
  return `chip-${seat}-${index}`;
}

/** Returns an UNDEALT match: every chip in the bank, nothing owned by
 * anyone. The deal itself is `startRound`'s job, which is what makes it
 * ANIMATE — chips fly out from the bank instead of simply appearing
 * already stacked at each pod the instant the table mounts. */
export function makeSetup(target: number) {
  return function setup(opts: SetupOptions): LrcState {
    const scores: Record<SeatId, number> = {};
    const chipOwner: Record<PieceId, SeatId | "pot" | "bank"> = {};
    for (let seat = 0; seat < opts.seats; seat++) {
      scores[seat] = 0;
      for (let i = 0; i < CHIPS_PER_PLAYER; i++) chipOwner[chipId(seat, i)] = "bank";
    }
    return {
      seats: opts.seats,
      target,
      round: 0,
      scores,
      chipOwner,
      turn: HERO,
      result: null,
      winner: null,
      dealt: false,
    };
  };
}

export function startRound(state: LrcState, rng: Rng): ReduceResult<LrcState> {
  const events: GameEvent[] = [];

  // Round 2+ inherits every chip from wherever the last round left it —
  // one seat holding the whole pile, the rest at zero. Sweep it back to
  // the bank before redealing, mirroring Dominoes' own round-transition
  // sweep. A no-op on round 1: every chip is already there.
  const owned = Object.entries(state.chipOwner)
    .filter(([, owner]) => owner !== "bank")
    .map(([id]) => id);
  if (owned.length > 0) events.push({ t: "sweep", pieces: owned, to: "boneyard" });

  const chipOwner: Record<PieceId, SeatId | "pot" | "bank"> = {};
  const all: SeatId[] = [];
  for (let seat = 0; seat < state.seats; seat++) {
    all.push(seat);
    for (let i = 0; i < CHIPS_PER_PLAYER; i++) chipOwner[chipId(seat, i)] = seat;
  }

  // A fresh cut every round, not just for the match's first — LCR has no
  // dealer convention the way a card or domino game does (no highest
  // double, no rotating dealer button), so there is nothing more
  // meaningful to hand the lead to than another honest cut. This is also
  // "ensure the starting player is random" applied to EVERY round, not
  // only game 1 — the bug it fixes is subtler than a hardcoded HERO: a
  // rule that only randomised the very first deal would let whichever
  // seat won round 1 quietly become a fixed opener for round 2 onward if
  // the implementation ever threaded `opener` through the way Dominoes
  // does. There is no such threading here at all — every round is an
  // independent cut.
  const turn = rng.pick(all);

  const round = state.round + 1;
  for (let seat = 0; seat < state.seats; seat++) {
    for (let i = 0; i < CHIPS_PER_PLAYER; i++) {
      const id = chipId(seat, i);
      events.push({
        t: "move",
        piece: id,
        // `collected`, not the generic `deal` event's hardcoded `hand` —
        // a chip never has a hand, it goes straight to a seat's own
        // pile. `move` carries a full Placement for exactly this, the
        // same reason Dominoes' played tile bypasses `play` for it.
        to: { zone: "collected", seat, index: 0, count: 1, faceUp: true },
      });
    }
  }

  events.push({ t: "phase", phase: `round-${round}` });
  events.push({
    t: "announce",
    seat: turn,
    text: turn === HERO ? "You roll first" : `${botName(turn)} rolls first`,
    tone: "info",
  });

  return {
    state: { ...state, round, chipOwner, turn, result: null, dealt: true },
    events,
  };
}

export function reduce(state: LrcState, action: LrcAction): ReduceResult<LrcState> {
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
    const roundWinner = stillActive[0] ?? seat;
    const scores = {
      ...state.scores,
      [roundWinner]: (state.scores[roundWinner] ?? 0) + 1,
    };
    const matchWinner = (scores[roundWinner] ?? 0) >= state.target ? roundWinner : null;

    events.push({
      t: "announce",
      seat: roundWinner,
      text: roundWinner === HERO ? "You win the pot!" : `${botName(roundWinner)} takes the pot`,
      tone: roundWinner === HERO ? "good" : "info",
    });
    const deltas: Record<SeatId, number> = {};
    for (let s = 0; s < state.seats; s++) deltas[s] = s === roundWinner ? 1 : 0;
    events.push({ t: "score", deltas });
    events.push({ t: "roundEnd", round: state.round });
    if (matchWinner !== null) events.push({ t: "gameEnd", winner: matchWinner });

    next = { ...next, scores, result: { winner: roundWinner }, winner: matchWinner };
  } else {
    next = { ...next, turn: nextActiveSeat(next, seat) };
  }

  // A roll landing entirely on dots moves nothing, which is a real,
  // legal outcome — not an empty batch to special-case away. Without
  // a `pause` here, this turn would snap straight to the next one with
  // none of the settle time a roll that DID move a chip gets, reading
  // as visibly rushed by comparison. See the event's own doc for why
  // it carries no duration itself — `choreograph` decides that.
  if (events.length === 0) events.push({ t: "pause" });

  return { state: next, events };
}

export function legalActions(state: LrcState, seat: SeatId): LrcAction[] {
  if (!state.dealt || state.result !== null || state.winner !== null || state.turn !== seat) {
    return [];
  }
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
  const bankTotal = Object.values(state.chipOwner).filter((o) => o === "bank").length;
  let bankIndex = 0;

  for (const [piece, owner] of Object.entries(state.chipOwner)) {
    if (owner === "bank") {
      // The reserve a round deals FROM — reuses the "boneyard" zone
      // (a plain resting pile, unused by any other part of this game)
      // rather than inventing a new one for a single game to draw on.
      out[piece] = { zone: "boneyard", index: bankIndex++, count: bankTotal, faceUp: true };
    } else if (owner === "pot") {
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
  if (!state.dealt || state.result !== null || state.winner !== null) return null;
  return state.turn;
}

export function isRoundOver(state: LrcState): boolean {
  return state.result !== null;
}

export function isOver(state: LrcState): boolean {
  return state.winner !== null;
}

export function createLrc(target: number = LRC_DEFAULT_TARGET): GameDefinition<LrcState, LrcAction> {
  return {
    id: "lrc",
    name: "Left Right Center",
    minSeats: 3,
    maxSeats: 10,
    setup: makeSetup(target),
    reduce,
    legalActions,
    pieces,
    placements,
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: lrcBots,
  };
}

export const lrc = createLrc();
