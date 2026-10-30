import { createRng } from "@/engine/rng";
import type { BotContext } from "@/engine/types";
import { describe, expect, it } from "vitest";
import type { BridgeOptions, WordBrain } from "./brain";
import { createMindMeld } from "./rules";
import type { MindMeldState } from "./types";

/**
 * A bot says the obvious word to a person and a looser one to another bot
 * (`BridgeOptions.partner`) — and it has to be TOLD which, because the game's
 * own state does not know who is a person. The session tells it
 * (`BotContext.isLive`); these hold the bot to reading it.
 */

function seen() {
  const calls: BridgeOptions[] = [];
  const brain: WordBrain = {
    bridge: (_a, _b, opts) => {
      calls.push(opts);
      return `word${calls.length}`;
    },
    starter: () => "apple",
  };
  const def = createMindMeld({}, { brain: () => brain });
  const rng = createRng(3);
  const { state } = def.startRound!(def.setup({ seats: 4, rng }), rng);
  // A pair with two words said, so the next try is a bridge rather than a start.
  const pairs = state.pairs.map((p) => ({ ...p, chain: ["beach", "sun"], tries: 2 }));
  return { def, state: { ...state, pairs } as MindMeldState, calls, rng };
}

const live = (...seats: number[]): BotContext => ({ isLive: (s) => seats.includes(s) });

describe("a Mind Meld bot reads who its partner is", () => {
  it("treats a person in the partner's seat as a person", () => {
    const { def, state, calls, rng } = seen();
    // Seats 0 and 1 are a pair: the bot is seat 1, the person seat 0.
    def.bots.steady.choose(state, 1, rng, live(0));
    expect(calls[0]).toMatchObject({ partner: "human", misses: 2 });
  });

  it("treats a seat nobody is in as a bot, so two bots stay loose", () => {
    const { def, state, calls, rng } = seen();
    def.bots.steady.choose(state, 1, rng, live());
    expect(calls[0]).toMatchObject({ partner: "bot" });
  });

  it("treats a missing context as a bot too: a simulation has no session", () => {
    const { def, state, calls, rng } = seen();
    def.bots.steady.choose(state, 1, rng);
    expect(calls[0]).toMatchObject({ partner: "bot" });
  });

  it("looks at its OWN partner, not at any person in the room", () => {
    const { def, state, calls, rng } = seen();
    // A person is at seat 2 — the next pair — which is no help to seat 1.
    def.bots.steady.choose(state, 1, rng, live(2));
    expect(calls[0]).toMatchObject({ partner: "bot" });
  });
});
