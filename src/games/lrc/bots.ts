/**
 * LRC bots.
 *
 * There is no decision to make — rolling is the only legal action, and
 * the dice are random. "Difficulty" here is entirely about feel: how
 * long a bot pauses before rolling, and how that pause varies. A bot
 * that always takes exactly 900ms reads as a machine; a little jitter
 * reads as a person deciding whether to make a show of the roll.
 */

import type { BotDifficulty, BotStrategy, SeatId } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { rollAction } from "./dice";
import { diceCountFor } from "./state";
import type { LrcAction, LrcState } from "./types";

function makeBot(id: string, thinkMs: (rng: Rng) => number): BotStrategy<LrcState, LrcAction> {
  return {
    id,
    choose(state: LrcState, seat: SeatId, rng: Rng): LrcAction {
      return rollAction(rng, diceCountFor(state, seat));
    },
    thinkMs(_state: LrcState, _seat: SeatId, rng: Rng): number {
      return thinkMs(rng);
    },
  };
}

export const lrcBots: Record<BotDifficulty, BotStrategy<LrcState, LrcAction>> = {
  // Quick and a little erratic — feels eager to get to the next roll.
  casual: makeBot("casual", (rng) => 350 + rng.int(300)),
  // The baseline pace used everywhere else in the app.
  steady: makeBot("steady", (rng) => 600 + rng.int(400)),
  // Pauses a beat longer, as if sizing up the table before rolling.
  sharp: makeBot("sharp", (rng) => 800 + rng.int(500)),
};
