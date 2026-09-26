/**
 * Dominoes bots.
 *
 * Unlike LRC — where rolling was the only legal action and "difficulty"
 * was purely about pacing — there is a real decision here, so the tiers
 * differ in judgement as well as in feel.
 *
 * Every bot is handed `playerView(state, seat)`, so its own hand is the
 * only one it can read. Anything below that reasons about opponents does
 * so from public facts only: how many tiles they hold, how deep the
 * boneyard is, and what the open ends are.
 */

import type { BotDifficulty, BotStrategy, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { tileHas, tilePips } from "@/games/_shared/tiles";
import {
  canPlay,
  drawableTiles,
  endsAfter,
  isKeyTile,
  nextSeat,
  playableTiles,
  sameSide,
} from "./state";
import type { ChainEnd, DomAction, DomState } from "./types";

interface Play {
  tile: string;
  end: ChainEnd;
}

function allPlays(state: DomState, seat: SeatId): Play[] {
  const out: Play[] = [];
  for (const { tile, ends } of playableTiles(state, seat)) {
    for (const end of ends) out.push({ tile, end });
  }
  return out;
}

/** Drawing and passing are never choices — they are what is left. */
function forced(state: DomState): DomAction {
  return drawableTiles(state) > 0 ? { t: "draw" } : { t: "pass" };
}

function bestOf(
  plays: readonly Play[],
  score: (p: Play) => number,
  rng: Rng,
): Play {
  let best = -Infinity;
  let tied: Play[] = [];
  for (const p of plays) {
    const s = score(p);
    if (s > best) {
      best = s;
      tied = [p];
    } else if (s === best) {
      tied.push(p);
    }
  }
  return rng.pick(tied);
}

/**
 * Seats that have shown they cannot play a given number, by passing
 * while it was an open end. Opponents only — blocking a partner is
 * helping the other side.
 */
function opponentsVoidIn(state: DomState, seat: SeatId, pip: number): number {
  let n = 0;
  for (let s = 0; s < state.seats; s++) {
    const other = s as SeatId;
    if (other === seat || sameSide(state, other, seat)) continue;
    if ((state.passedEnds[other] ?? []).includes(pip)) n++;
  }
  return n;
}

/** The fewest tiles any opponent is holding — how close the other side
 * is to going out. Redacted hands keep their length, so this is
 * readable from the bot's own view. */
function closestOpponent(state: DomState, seat: SeatId): number {
  let fewest = Infinity;
  for (let s = 0; s < state.seats; s++) {
    const other = s as SeatId;
    if (other === seat || sameSide(state, other, seat)) continue;
    fewest = Math.min(fewest, (state.hands[other] ?? []).length);
  }
  return Number.isFinite(fewest) ? fewest : 7;
}

/**
 * How good a move looks with only public information.
 *
 * The weights matter as much as the terms. The first version summed
 * `tilePips + cover * 1.5 + squeeze`, and `tilePips` runs 0-12 while
 * everything else moved the score by at most 3 — so whenever the
 * heaviest legal tile was four pips clear of the next, sharp and steady
 * chose the identical tile and the two tiers were the same bot. Weight
 * is now scaled down to roughly the range of the positional terms, so
 * control can actually outrank a heavy tile instead of only breaking
 * ties between equally heavy ones.
 *
 * The terms:
 *
 *  - shedding pips still matters — it is how the round is scored;
 *  - a move that leaves ends your own hand still covers keeps you off
 *    the boneyard next turn;
 *  - making BOTH ends the same number narrows what anyone else can
 *    answer with — the standard blocking squeeze;
 *  - leaving an end an opponent has ALREADY passed on is the real prize
 *    (`state.passedEnds`): that seat is provably stuck on it, and the
 *    closer they are to going out the more it is worth;
 *  - in Caribbean, going out on the one tile that fits nowhere else is
 *    worth a whole extra game (`isKeyTile`), which no bot used to check
 *    even while the rule was enabled.
 *
 * The squeeze is the one term that has to know about partners. It is
 * worth playing because it strangles WHOEVER GOES NEXT, and in team
 * mode that seat is your own partner half the time — turn order
 * alternates opponent/partner/opponent around the table. Rewarding it
 * unconditionally had a sharp bot cheerfully blocking its own side, so
 * it is scored against the seat it actually lands on: a bonus when that
 * is an opponent, a penalty of the same weight when it is a partner.
 */
function judge(state: DomState, seat: SeatId, play: Play): number {
  const after = endsAfter(state, play.tile, play.end);
  const hand = state.hands[seat] ?? [];

  let cover = 0;
  for (const id of hand) {
    if (id === play.tile) continue;
    if (tileHas(id, after.left) || tileHas(id, after.right)) cover++;
  }

  const squeezes = after.left === after.right;
  const hitsPartner = sameSide(state, nextSeat(state, seat), seat);
  const squeeze = squeezes ? (hitsPartner ? -3 : 3) : 0;

  // Pressure: how many opponents are provably stuck on the ends this
  // move leaves. Counting both ends means a squeeze onto a number the
  // table has already passed on scores twice, which is exactly right —
  // that is the move that ends a round.
  let pressure = 0;
  for (const end of [after.left, after.right]) {
    pressure += opponentsVoidIn(state, seat, end) * 2.5;
  }
  // Worth more when somebody is about to go out and be scored on.
  if (closestOpponent(state, seat) <= 2) pressure *= 1.6;

  // Going out on the key tile takes an extra game in Caribbean. Only
  // counts when this play actually empties the hand.
  const goingOut = hand.length === 1;
  const keyTile = goingOut && state.rules.keyTileBonus && isKeyTile(state, play.tile) ? 6 : 0;

  // With the boneyard gone and the table already passing, the round is
  // heading for a block — and a blocked round is scored on pips left in
  // hand, so dumping weight goes back to being the whole game. Nothing
  // used to notice this: `pipsInHand`/`lightestTile` exist in state.ts
  // for exactly this tiebreak and no bot ever called them.
  const blockLikely = drawableTiles(state) === 0 && state.passes > 0;
  const weight = blockLikely ? 1.2 : 0.35;

  return tilePips(play.tile) * weight + cover * 1.5 + squeeze + pressure + keyTile;
}

function makeBot(
  id: string,
  pick: (state: DomState, seat: SeatId, plays: Play[], rng: Rng) => Play,
  pace: (rng: Rng) => number,
): BotStrategy<DomState, DomAction> {
  return {
    id,
    choose(state, seat, rng) {
      const plays = allPlays(state, seat);
      if (plays.length === 0) return forced(state);
      const { tile, end } = pick(state, seat, plays, rng);
      return { t: "play", tile, end };
    },
    thinkMs(state, seat, rng) {
      // A forced draw is not a decision, and a bot that appears to
      // deliberate over one reads as broken rather than thoughtful.
      // Note this still consumes rng either way, so the sequence stays
      // deterministic regardless of which branch is taken.
      const beat = pace(rng);
      return canPlay(state, seat) ? beat : 220 + Math.round(beat * 0.25);
    },
  };
}

export const dominoBots: Record<BotDifficulty, BotStrategy<DomState, DomAction>> = {
  // Plays whatever it can, in no particular order — the player who
  // never counts what is left.
  casual: makeBot("casual", (_s, _seat, plays, rng) => rng.pick(plays), (rng) => 400 + rng.int(350)),

  // Sheds the heaviest tile it can. The first thing anyone learns, and
  // enough to punish a careless hand.
  steady: makeBot(
    "steady",
    (_s, _seat, plays, rng) => bestOf(plays, (p) => tilePips(p.tile), rng),
    (rng) => 650 + rng.int(400),
  ),

  // Weighs shedding against keeping its own options open, and takes a
  // blocking squeeze when one is going cheap.
  sharp: makeBot(
    "sharp",
    (state, seat, plays, rng) => bestOf(plays, (p) => judge(state, seat, p), rng),
    (rng) => 800 + rng.int(500),
  ),
};
