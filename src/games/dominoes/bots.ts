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
 * How good a move looks with only public information:
 *
 *  - shedding pips is the whole game, so weight matters most;
 *  - a move that leaves ends your own hand still covers keeps you off
 *    the boneyard next turn, which is worth roughly a pip apiece;
 *  - making BOTH ends the same number narrows what anyone else can
 *    answer with — the standard blocking squeeze.
 *
 * The squeeze is the one term that has to know about partners. It is
 * worth playing because it strangles WHOEVER GOES NEXT, and in Caribbean
 * team mode that seat is your own partner half the time — turn order
 * alternates opponent/partner/opponent around the table. Rewarding it
 * unconditionally had a sharp bot cheerfully blocking its own side, so
 * it is scored against the seat it actually lands on: a bonus when that
 * is an opponent, a penalty of the same weight when it is your partner.
 */
function judge(state: DomState, seat: SeatId, play: Play): number {
  const after = endsAfter(state, play.tile, play.end);
  let cover = 0;
  for (const id of state.hands[seat] ?? []) {
    if (id === play.tile) continue;
    if (tileHas(id, after.left) || tileHas(id, after.right)) cover++;
  }
  const squeezes = after.left === after.right;
  const hitsPartner = sameSide(state, nextSeat(state, seat), seat);
  const squeeze = squeezes ? (hitsPartner ? -3 : 3) : 0;
  return tilePips(play.tile) + cover * 1.5 + squeeze;
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
