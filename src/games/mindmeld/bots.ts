/**
 * Mind Meld's bots: a partner who tries to meet you, and rivals who try to meet
 * each other.
 *
 * A bot is only as good as the words it is given (`WordBrain`), so what separates
 * the tiers is how it uses them: how many of the best bridges it will consider.
 * That, and nothing else, because the whole game is whether two minds land on
 * the same word - a bot that always chose the single best bridge would make two
 * bots in one pair meet at once, every time.
 *
 * What a bot may use is what its own pair has said: it sees `playerView`, and
 * only its own chain is ever any use to it.
 */

import { hashString } from "@/engine/rng";
import type { BotDifficulty, BotStrategy, SeatId } from "@/engine/types";
import type { WordBrain } from "./brain";
import { isProfane } from "./profanity";
import { lastTwo, pairOf } from "./state";
import type { MindMeldAction, MindMeldState } from "./types";
import { refusal, sameAsAny } from "./words";

/** How many attempts at a valid word before giving up and using a stand-by. */
const ATTEMPTS = 6;

/** A stable 0..1 per seat, so two bots at one table are not the same mind. */
function personality(seat: SeatId): number {
  return (hashString(`mindmeld|personality|${seat}`) % 1000) / 1000;
}

function usable(word: string, chain: readonly string[], familySafe: boolean): boolean {
  if (refusal(word)) return false;
  if (familySafe && isProfane(word)) return false;
  return !sameAsAny(word, chain);
}

export function makeBots(brain: () => WordBrain): Record<BotDifficulty, BotStrategy<MindMeldState, MindMeldAction>> {
  const strategy = (tier: BotDifficulty): BotStrategy<MindMeldState, MindMeldAction> => ({
    id: `mindmeld-${tier}`,
    choose(state, seat, rng) {
      const pair = pairOf(state, seat);
      const chain = pair?.chain ?? [];
      const two = pair ? lastTwo(pair) : null;
      const b = brain();

      const exclude = [...chain];
      let word = "";
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const candidate = two
          ? b.bridge(two[0], two[1], { exclude, tier, personality: personality(seat), rng })
          : b.starter(rng, exclude);
        if (usable(candidate, chain, state.rules.familySafe)) {
          word = candidate;
          break;
        }
        exclude.push(candidate);
      }
      // Every try ran dry (a tiny brain, a long chain): something is better than nothing.
      if (word === "") word = `thing${chain.length}`;
      return { t: "submit", seat, word };
    },
    thinkMs() {
      // A bot waits out its time in `turnHold`, before it answers; thinking as
      // well would be the same wait twice.
      return 120;
    },
  });
  return { casual: strategy("casual"), steady: strategy("steady"), sharp: strategy("sharp") };
}
