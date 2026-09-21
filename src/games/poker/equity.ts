/**
 * Showdown equity — the probability this hand wins the pot at showdown
 * against `opponents` unknown hands, given what is on the board now.
 *
 * Why this exists at all: `bots.ts` used to score a hand on an invented
 * 0..1 scale (`preflopStrength` before the flop, `value.category / 8`
 * after it) and then compare that number against pot odds. Pot odds are
 * a probability; those scores were not, so the comparison was between
 * two different units and could not work even when it ran. Worse, the
 * two scales disagreed with each other — pocket aces preflop scored
 * 0.95 while a made full house scored 0.75 — which is exactly why bots
 * jammed before the flop and would not bet a real hand after it.
 *
 * Equity is one honest number meaning the same thing on every street,
 * so `equity - potOdds` becomes a real decision and one set of
 * constants can govern preflop and postflop without lying.
 *
 * Deliberately does NOT import from `./rules` or `./state` — it is pure
 * over card ids, like `hand.ts`, so it stays independently testable and
 * cannot join the `rules` -> `bots` import cycle.
 */

import type { PieceId } from "@/engine/types";
import { createRng, hashString, type Rng } from "@/engine/rng";
import { parseCard, RANKS, SUITS, type Suit } from "@/games/_shared/cards";
import { pokerRank } from "./hand";

/* ============================================================
   A fast 7-card evaluator
   ============================================================ */

// Module-level scratch, refilled on every `handScore` call. That
// function is hot enough that per-call allocation dominated its cost.
// Safe to share because it writes every slot it reads, never calls out,
// and is never re-entered (single-threaded, synchronous).
const rankCount = new Array<number>(15).fill(0);
const suitCount = new Array<number>(4).fill(0);
const suitMask = new Array<number>(4).fill(0);

/**
 * `hand.ts`'s `bestOfSeven` stays the canonical evaluator and is what
 * real showdowns use — but it brute-forces all 21 five-card
 * combinations and allocates a `HandValue` for each. A Monte Carlo run
 * evaluates millions of hands, so it needs a version that allocates
 * nothing and returns a single comparable integer.
 *
 * The two MUST agree on ordering, and `equity.test.ts` asserts exactly
 * that against `compareHandValues` over a large random sweep. That test
 * is what keeps this optimisation honest.
 *
 * Layout: `category * 16^5 + r1 * 16^4 + ... + r5`, using the same
 * category numbering as `hand.ts` (0 high card .. 8 straight flush) and
 * the same descending tiebreak ranks. The maximum is under 2^24.
 */
export function handScore(ranks: readonly number[], suits: readonly number[]): number {
  rankCount.fill(0);
  suitCount.fill(0);
  suitMask.fill(0);
  let mask = 0;

  for (let i = 0; i < ranks.length; i++) {
    const r = ranks[i]!;
    const s = suits[i]!;
    rankCount[r]++;
    suitCount[s]++;
    suitMask[s] |= 1 << r;
    mask |= 1 << r;
    // The ace also occupies bit 1, so the A-2-3-4-5 wheel falls out of
    // the same consecutive-bits scan as every other straight.
    if (r === 14) {
      mask |= 2;
      suitMask[s] |= 2;
    }
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s]! >= 5) flushSuit = s;

  // Straight flush first, then the categories in rank order. (In seven
  // cards a flush can never coexist with quads or a full house, but
  // testing in order costs nothing and is obviously correct.)
  if (flushSuit >= 0) {
    const sf = straightHigh(suitMask[flushSuit]!);
    if (sf > 0) return pack(8, sf, 0, 0, 0, 0);
  }

  let quad = 0;
  let trip = 0;
  let trip2 = 0;
  let pair = 0;
  let pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const c = rankCount[r]!;
    if (c === 4) {
      if (!quad) quad = r;
    } else if (c === 3) {
      if (!trip) trip = r;
      else if (!trip2) trip2 = r;
    } else if (c === 2) {
      if (!pair) pair = r;
      else if (!pair2) pair2 = r;
    }
  }

  if (quad > 0) {
    let kicker = 0;
    for (let r = 14; r >= 2; r--) {
      if (r !== quad && rankCount[r]! > 0) {
        kicker = r;
        break;
      }
    }
    return pack(7, quad, kicker, 0, 0, 0);
  }

  // A second trip plays as the pair, but only at its rank — hence the
  // max rather than a preference for either source.
  if (trip > 0 && (trip2 > 0 || pair > 0)) {
    return pack(6, trip, Math.max(trip2, pair), 0, 0, 0);
  }

  if (flushSuit >= 0) {
    return pack(5, ...topFive(suitMask[flushSuit]!));
  }

  const straight = straightHigh(mask);
  if (straight > 0) return pack(4, straight, 0, 0, 0, 0);

  if (trip > 0) {
    const [k1, k2] = kickers(trip, 0, 2);
    return pack(3, trip, k1, k2, 0, 0);
  }

  if (pair > 0 && pair2 > 0) {
    const [k1] = kickers(pair, pair2, 1);
    return pack(2, pair, pair2, k1, 0, 0);
  }

  if (pair > 0) {
    const [k1, k2, k3] = kickers(pair, 0, 3);
    return pack(1, pair, k1, k2, k3, 0);
  }

  let mask5 = 0;
  for (let r = 14; r >= 2; r--) if (rankCount[r]! > 0) mask5 |= 1 << r;
  return pack(0, ...topFive(mask5));
}

/** The `count` highest ranks present, skipping `skipA`/`skipB`. */
function kickers(skipA: number, skipB: number, count: number): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < count; r--) {
    if (r === skipA || r === skipB || rankCount[r]! === 0) continue;
    out.push(r);
  }
  while (out.length < count) out.push(0);
  return out;
}

/** The five highest bits set in a rank mask, high first, zero-padded. */
function topFive(m: number): [number, number, number, number, number] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < 5; r--) if (m & (1 << r)) out.push(r);
  while (out.length < 5) out.push(0);
  return [out[0]!, out[1]!, out[2]!, out[3]!, out[4]!];
}

function pack(cat: number, a: number, b: number, c: number, d: number, e: number): number {
  return ((((cat * 16 + a) * 16 + b) * 16 + c) * 16 + d) * 16 + e;
}

/** The high card of a 5-in-a-row run in a rank bitmask, or 0 for none. */
function straightHigh(m: number): number {
  for (let hi = 14; hi >= 5; hi--) {
    const need = (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3)) | (1 << (hi - 4));
    if ((m & need) === need) return hi;
  }
  return 0;
}

/* ============================================================
   Monte Carlo equity
   ============================================================ */

const SUIT_INDEX: Record<Suit, number> = { S: 0, H: 1, D: 2, C: 3 };

interface Decoded {
  rank: number;
  suit: number;
}

function decode(id: PieceId): Decoded {
  const card = parseCard(id);
  return { rank: pokerRank(card.rank), suit: SUIT_INDEX[card.suit] };
}

/**
 * How many opponents to actually simulate. Past four, one more unknown
 * hand barely moves equity but costs a full evaluation on every sample,
 * and the bot's raise gate already accounts for field size separately.
 * Capping here is what keeps a 9-seat table affordable.
 */
export const MAX_MODELLED_OPPONENTS = 4;

/**
 * Probability of winning the pot at showdown, 0..1. A split counts as
 * its fair share (`1 / winners`) rather than as a loss — folding a hand
 * that chops half the time is a real mistake, and the number has to be
 * able to say so.
 *
 * `rng` should be seeded from the decision position (see `equityFor`)
 * rather than from live game randomness, so that a bot re-reading the
 * same spot gets the same answer instead of changing its mind.
 */
export function handEquity(
  hole: readonly PieceId[],
  board: readonly PieceId[],
  opponents: number,
  samples: number,
  rng: Rng,
): number {
  if (hole.length < 2 || samples <= 0) return 0;
  const rivals = Math.max(1, Math.min(MAX_MODELLED_OPPONENTS, Math.floor(opponents)));

  const knownSet = new Set([...hole.slice(0, 2), ...board]);
  const deckRank: number[] = [];
  const deckSuit: number[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const id = `${suit}${rank}`;
      if (knownSet.has(id)) continue;
      deckRank.push(pokerRank(rank));
      deckSuit.push(SUIT_INDEX[suit]);
    }
  }

  const boardToCome = 5 - board.length;
  const needed = rivals * 2 + boardToCome;
  if (boardToCome < 0 || needed > deckRank.length) return 0;

  const heroFixed = hole.slice(0, 2).map(decode);
  const boardFixed = board.map(decode);

  // Seven slots — 2 hole cards then the 5 board cards — refilled in
  // place every sample so the loop allocates nothing.
  const ranks = new Array<number>(7);
  const suits = new Array<number>(7);

  let won = 0;

  for (let s = 0; s < samples; s++) {
    // Partial Fisher-Yates: draw `needed` cards to the front of the
    // deck without rebuilding or fully shuffling it.
    for (let i = 0; i < needed; i++) {
      const j = i + rng.int(deckRank.length - i);
      const tr = deckRank[i]!;
      const ts = deckSuit[i]!;
      deckRank[i] = deckRank[j]!;
      deckSuit[i] = deckSuit[j]!;
      deckRank[j] = tr;
      deckSuit[j] = ts;
    }

    // The board is shared by everyone in this sample, so it is written
    // once and only the two hole slots change per player.
    for (let i = 0; i < boardFixed.length; i++) {
      ranks[2 + i] = boardFixed[i]!.rank;
      suits[2 + i] = boardFixed[i]!.suit;
    }
    const runoutAt = rivals * 2;
    for (let i = 0; i < boardToCome; i++) {
      ranks[2 + boardFixed.length + i] = deckRank[runoutAt + i]!;
      suits[2 + boardFixed.length + i] = deckSuit[runoutAt + i]!;
    }

    ranks[0] = heroFixed[0]!.rank;
    suits[0] = heroFixed[0]!.suit;
    ranks[1] = heroFixed[1]!.rank;
    suits[1] = heroFixed[1]!.suit;
    const hero = handScore(ranks, suits);

    let ties = 0;
    let beaten = false;
    for (let o = 0; o < rivals; o++) {
      ranks[0] = deckRank[o * 2]!;
      suits[0] = deckSuit[o * 2]!;
      ranks[1] = deckRank[o * 2 + 1]!;
      suits[1] = deckSuit[o * 2 + 1]!;
      const score = handScore(ranks, suits);
      if (score > hero) {
        beaten = true;
        break;
      }
      if (score === hero) ties++;
    }

    if (!beaten) won += 1 / (ties + 1);
  }

  return won / samples;
}

/* ============================================================
   The bot-facing entry point
   ============================================================ */

/**
 * Preflop equity is the same for every hand of the same shape — AhKh
 * and AsKs are one entry — so there are only 169 shapes per opponent
 * count. Computing each once at a high sample count makes the preflop
 * read both the most accurate one and effectively free, which matters
 * because preflop is where nearly every decision lives, and where the
 * whole reported all-in problem lived.
 *
 * A lazily-filled runtime cache rather than a generated data file: no
 * table to keep in sync, and a cold start costs one batch of samples.
 */
const preflopCache = new Map<string, number>();
const PREFLOP_SAMPLES = 1500;

/**
 * Postflop boards genuinely repeat inside a single hand — a bot acts
 * more than once on the same flop — so a bounded cache pays for itself
 * without growing without limit across a long simulation.
 */
const postflopCache = new Map<string, number>();
const POSTFLOP_CACHE_LIMIT = 4000;

/** A real accuracy/CPU trade, tuned so a full test sweep stays quick
 * while a live decision sits comfortably inside the bot's own think
 * time (hundreds of milliseconds). */
export const POSTFLOP_SAMPLES = 200;

function canonicalPreflop(hole: readonly PieceId[]): string {
  const a = decode(hole[0]!);
  const b = decode(hole[1]!);
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const shape = a.rank === b.rank ? "p" : a.suit === b.suit ? "s" : "o";
  return `${hi}-${lo}${shape}`;
}

/**
 * Equity for a real decision point — memoised, and deterministically
 * seeded from the position itself via `hashString` (the same precedent
 * `reduce` already uses for slams and for Rummy's claim reaction
 * times). Two consequences, both of which matter: a seed replays a
 * bot's reads exactly, and a bot asked twice about one spot cannot
 * quietly change its mind between the fold check and the raise check.
 */
export function equityFor(
  hole: readonly PieceId[],
  board: readonly PieceId[],
  opponents: number,
): number {
  if (hole.length < 2) return 0;
  const rivals = Math.max(1, Math.min(MAX_MODELLED_OPPONENTS, Math.floor(opponents)));

  if (board.length === 0) {
    const key = `${canonicalPreflop(hole)}|${rivals}`;
    const hit = preflopCache.get(key);
    if (hit !== undefined) return hit;
    const value = handEquity(hole, board, rivals, PREFLOP_SAMPLES, createRng(hashString(key)));
    preflopCache.set(key, value);
    return value;
  }

  const key = `${[...hole].sort().join(",")}|${[...board].sort().join(",")}|${rivals}`;
  const hit = postflopCache.get(key);
  if (hit !== undefined) return hit;
  const value = handEquity(hole, board, rivals, POSTFLOP_SAMPLES, createRng(hashString(key)));
  if (postflopCache.size >= POSTFLOP_CACHE_LIMIT) postflopCache.clear();
  postflopCache.set(key, value);
  return value;
}
