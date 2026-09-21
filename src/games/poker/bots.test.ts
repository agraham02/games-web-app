import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { BotDifficulty } from "@/engine/types";
import { createPoker } from "./rules";
import { contestingSeats } from "./state";
import type { PokerAction, PokerState } from "./types";

/**
 * These tests exist because the suite they replace could not see the
 * bug it was written to guard.
 *
 * A player reported bots going all-in constantly and hands never
 * reaching a real street. The guard written at the time asserted
 * `reachedFlop / hands > 0.25`, measured as `communityOrder.length > 0`
 * — but a preflop all-in still deals the whole board, so it counts as
 * "reached the flop". A table that shoved every single hand passed that
 * assertion at 100%. Its companion assertion sampled only the FIRST
 * decision of each hand, so it never once observed a re-raise, which is
 * where the all-ins actually came from. Both stayed green through the
 * entire regression.
 *
 * So everything below measures what a player would actually see, over
 * complete matches at the real default configuration, and the flop
 * metric specifically requires that a hand of poker was still PLAYABLE
 * when the flop landed — two seats with chips behind — rather than that
 * some cards hit the felt.
 */

interface Metrics {
  hands: number;
  allInHands: number;
  preflopAllInHands: number;
  playableFlops: number;
  preflopDecisions: number;
  preflopRaises: number;
  preflopVoluntary: number;
  maxRaisesInAStreet: number;
  handsToFirstBust: number[];
}

/** Plays complete matches to elimination and records what happened. */
function measure(tier: BotDifficulty, seeds: number, stack = 2000, bb = 20, seats = 6): Metrics {
  const d = createPoker(stack, bb);
  const m: Metrics = {
    hands: 0,
    allInHands: 0,
    preflopAllInHands: 0,
    playableFlops: 0,
    preflopDecisions: 0,
    preflopRaises: 0,
    preflopVoluntary: 0,
    maxRaisesInAStreet: 0,
    handsToFirstBust: [],
  };

  for (let seed = 0; seed < seeds; seed++) {
    const rng = createRng(seed);
    let state: PokerState = d.setup({ seats, rng });
    ({ state } = d.startRound!(state, rng));

    let handsThisMatch = 0;
    let firstBust: number | null = null;
    let allIn = false;
    let preflopAllIn = false;
    let flopSeen = false;
    let playable = false;

    for (let i = 0; i < 5000 && !d.isOver(state); i++) {
      if (d.isRoundOver!(state)) {
        m.hands++;
        handsThisMatch++;
        if (allIn) m.allInHands++;
        if (preflopAllIn) m.preflopAllInHands++;
        if (playable) m.playableFlops++;
        allIn = preflopAllIn = flopSeen = playable = false;

        if (firstBust === null) {
          const busted = Array.from({ length: seats }, (_, s) => s).some(
            (s) => (state.stacks[s] ?? 0) === 0,
          );
          if (busted) firstBust = handsThisMatch;
        }
        ({ state } = d.startRound!(state, rng));
        continue;
      }

      const seat = d.currentSeat(state);
      if (seat === null) break;
      const view = d.playerView(state, seat);
      const action = d.bots[tier].choose(view, seat, rng);

      if (state.communityOrder.length === 0 && !state.pendingShowdown) {
        m.preflopDecisions++;
        if (action.t === "bet" || action.t === "raise") m.preflopRaises++;
        if (action.t !== "fold" && action.t !== "check") m.preflopVoluntary++;
      }

      ({ state } = d.reduce(state, action));
      m.maxRaisesInAStreet = Math.max(m.maxRaisesInAStreet, state.raisesThisStreet);

      for (const s of contestingSeats(state)) {
        if ((state.stacks[s] ?? 0) === 0) {
          allIn = true;
          if (state.communityOrder.length === 0) preflopAllIn = true;
        }
      }

      if (!flopSeen && state.communityOrder.length >= 3) {
        flopSeen = true;
        playable = contestingSeats(state).filter((s) => (state.stacks[s] ?? 0) > 0).length >= 2;
      }
    }
    if (firstBust !== null) m.handsToFirstBust.push(firstBust);
  }
  return m;
}

/** Heads-up, alternating who sits where so the blind/button asymmetry
 * cannot decide the result. Returns `a`'s share of matches won. */
function headsUpWinRate(a: BotDifficulty, b: BotDifficulty, seeds: number): number {
  const d = createPoker(2000, 20);
  let aWins = 0;
  for (let seed = 0; seed < seeds; seed++) {
    const rng = createRng(seed);
    const swap = seed % 2 === 1;
    const tiers: BotDifficulty[] = swap ? [b, a] : [a, b];
    let state: PokerState = d.setup({ seats: 2, rng, difficulty: [...tiers] });
    ({ state } = d.startRound!(state, rng));
    for (let i = 0; i < 20000 && !d.isOver(state); i++) {
      if (d.isRoundOver!(state)) {
        ({ state } = d.startRound!(state, rng));
        continue;
      }
      const seat = d.currentSeat(state);
      if (seat === null) break;
      const view = d.playerView(state, seat);
      ({ state } = d.reduce(state, d.bots[tiers[seat]!]!.choose(view, seat, rng)));
    }
    const aSeat = swap ? 1 : 0;
    if ((state.stacks[aSeat] ?? 0) > (state.stacks[1 - aSeat] ?? 0)) aWins++;
  }
  return aWins / seeds;
}

/* ============================================================
   The reported bug
   ============================================================ */

describe("bots do not jam — the reported all-in bug", () => {
  /**
   * The exact configuration the report came from: 6 seats, steady,
   * default stacks and blind. Measured at the time of writing: 1.1% of
   * hands see a preflop all-in, 7.5% see one at any point.
   */
  it("almost never puts anyone all-in before the flop", () => {
    const m = measure("steady", 12);
    expect(m.hands).toBeGreaterThan(200);
    expect(m.preflopAllInHands / m.hands).toBeLessThan(0.05);
  });

  it("keeps all-ins rare across the whole hand, not just preflop", () => {
    for (const tier of ["casual", "steady", "sharp"] as const) {
      const m = measure(tier, 8);
      expect(m.allInHands / m.hands).toBeLessThan(0.25);
    }
  });

  /**
   * The direct guard on the escalation that caused it. Before the fix
   * the raise test did not depend on the action already faced, so two
   * bots re-raised each other until a stack ran out; raise counts in a
   * single street were effectively unbounded.
   */
  it("never ratchets a street past its tier's raise cap", () => {
    expect(measure("casual", 6).maxRaisesInAStreet).toBeLessThanOrEqual(2);
    expect(measure("steady", 6).maxRaisesInAStreet).toBeLessThanOrEqual(3);
    expect(measure("sharp", 6).maxRaisesInAStreet).toBeLessThanOrEqual(4);
  });

  /**
   * The assertion the old `reachedFlop` test was trying to make.
   * Counting a flop only when two seats still have chips behind is what
   * makes it impossible to satisfy by shoving — an all-in runout deals
   * the same five cards and does not count here.
   */
  it("reaches flops that are still playable, not all-in runouts", () => {
    const m = measure("steady", 12);
    expect(m.playableFlops / m.hands).toBeGreaterThan(0.3);
  });

  /**
   * "Players go out too soon" in its own terms. Measured: the first of
   * six players busts after ~13 hands at 100 big blinds.
   */
  it("does not bust a six-handed table in a handful of hands", () => {
    const m = measure("steady", 12);
    const average =
      m.handsToFirstBust.reduce((a, b) => a + b, 0) / Math.max(1, m.handsToFirstBust.length);
    expect(m.handsToFirstBust.length).toBeGreaterThan(0);
    expect(average).toBeGreaterThan(6);
  });
});

/* ============================================================
   Ordinary poker shape
   ============================================================ */

describe("preflop play looks like poker", () => {
  /**
   * Measured for steady: 29% voluntary, 11% raising. Real six-handed
   * play sits near 25%/18%. Sampled over EVERY preflop decision — the
   * test this replaces looked only at each hand's first decision, which
   * is why it never saw the re-raises that caused the bug.
   */
  it("keeps steady inside an ordinary range rather than playing everything", () => {
    const m = measure("steady", 12);
    const vpip = m.preflopVoluntary / m.preflopDecisions;
    const pfr = m.preflopRaises / m.preflopDecisions;
    expect(vpip).toBeGreaterThan(0.12);
    expect(vpip).toBeLessThan(0.45);
    expect(pfr).toBeGreaterThan(0.03);
    expect(pfr).toBeLessThan(0.3);
  });

  it("makes casual the loose one and sharp the selective one", () => {
    const casual = measure("casual", 8);
    const sharp = measure("sharp", 8);
    const vpip = (m: Metrics) => m.preflopVoluntary / m.preflopDecisions;
    expect(vpip(casual)).toBeGreaterThan(vpip(sharp));
  });
});

/* ============================================================
   The tiers are ordered by skill
   ============================================================ */

describe("difficulty is a real gradient, not just pacing", () => {
  /**
   * No poker test has ever asserted that a sharper bot actually plays
   * better, and it turned out not to: `sharp` lost heads-up matches to
   * `casual` (40%) while this was being written, because it charged
   * itself a positional penalty for completing the small blind — which
   * heads-up is the BUTTON, the best seat at the table. Only a test
   * that pits the tiers against each other can catch that.
   *
   * Fully deterministic (fixed seeds), so these are exact, not flaky.
   * Measured: sharp 65% over casual, sharp 60% over steady, steady 57%
   * over casual.
   */
  it("orders sharp above steady above casual, heads-up", () => {
    expect(headsUpWinRate("sharp", "casual", 60)).toBeGreaterThan(0.5);
    expect(headsUpWinRate("sharp", "steady", 60)).toBeGreaterThan(0.5);
    expect(headsUpWinRate("steady", "casual", 60)).toBeGreaterThan(0.5);
  }, 120_000);
});

/* ============================================================
   Behaviour that already worked, kept
   ============================================================ */

describe("bot tier differentiation", () => {
  it("bet sizing varies rather than always landing on the same amount", () => {
    const d = createPoker(2000, 20);
    const sizes = new Set<number>();
    for (let seed = 0; seed < 60; seed++) {
      const rng = createRng(seed);
      let state: PokerState = d.setup({ seats: 3, rng });
      ({ state } = d.startRound!(state, rng));
      for (let i = 0; i < 6; i++) {
        const seat = d.currentSeat(state);
        if (seat === null || state.pendingShowdown) break;
        const view = d.playerView(state, seat);
        const action: PokerAction = d.bots.sharp.choose(view, seat, rng);
        if (action.t === "bet" || action.t === "raise") sizes.add(action.to);
        ({ state } = d.reduce(state, action));
        if (d.isRoundOver!(state)) break;
      }
    }
    expect(sizes.size).toBeGreaterThan(1);
  });

  it("a losing bot shows at a bounded, tier-ordered rate — reachable, not just possible", () => {
    const rates: Record<"casual" | "sharp", { shown: number; offered: number }> = {
      casual: { shown: 0, offered: 0 },
      sharp: { shown: 0, offered: 0 },
    };
    for (const tier of ["casual", "sharp"] as const) {
      const d = createPoker(300, 20);
      for (let seed = 0; seed < 50; seed++) {
        const rng = createRng(seed);
        const difficulty = [tier, tier, tier, tier] as const;
        let state: PokerState = d.setup({ seats: 4, rng, difficulty: [...difficulty] });
        ({ state } = d.startRound!(state, rng));
        for (let i = 0; i < 400 && !d.isOver(state); i++) {
          if (d.isRoundOver!(state)) {
            ({ state } = d.startRound!(state, rng));
            continue;
          }
          const seat = d.currentSeat(state);
          if (seat === null) break;
          const view = d.playerView(state, seat);
          const action = d.bots[tier].choose(view, seat, rng);
          if (state.pendingShowdown && !state.pendingShowdown.winningSeats.includes(seat)) {
            rates[tier].offered++;
            if (action.t === "show") rates[tier].shown++;
          }
          ({ state } = d.reduce(state, action));
        }
      }
    }
    expect(rates.casual.offered + rates.sharp.offered).toBeGreaterThan(0);
    if (rates.casual.offered > 0 && rates.sharp.offered > 0) {
      const casualRate = rates.casual.shown / rates.casual.offered;
      const sharpRate = rates.sharp.shown / rates.sharp.offered;
      expect(sharpRate).toBeGreaterThanOrEqual(casualRate);
    }
  });

  /**
   * Seats are no longer clones of each other: `botPersonality` gives
   * each one a stable offset inside its tier. Without it, five seats
   * with the same tier reached identical conclusions from identical
   * reads, which is both obviously artificial and what let two bots
   * ratchet each other in perfect lockstep.
   */
  it("gives different seats different thresholds within one tier", () => {
    const d = createPoker(2000, 20);
    const byHole = new Map<string, Set<string>>();
    for (let seed = 0; seed < 300; seed++) {
      const rng = createRng(seed);
      let state: PokerState = d.setup({ seats: 6, rng });
      ({ state } = d.startRound!(state, rng));
      const seat = d.currentSeat(state);
      if (seat === null) continue;
      const view = d.playerView(state, seat);
      const hole = Object.entries(view.cardOwner)
        .filter(([, owner]) => owner === seat)
        .map(([id]) => id)
        .sort()
        .join(",");
      // Same two cards, same spot, different seat — a table of clones
      // would always reach the same verdict.
      const key = `${hole}|${state.raisesThisStreet}`;
      const seen = byHole.get(key) ?? new Set<string>();
      for (const other of [0, 1, 2, 3, 4, 5]) {
        seen.add(`${other}:${d.bots.steady.choose(view, other, rng).t}`);
      }
      byHole.set(key, seen);
    }
    const disagreed = [...byHole.values()].some((verdicts) => {
      const kinds = new Set([...verdicts].map((v) => v.split(":")[1]));
      return kinds.size > 1;
    });
    expect(disagreed).toBe(true);
  });
});
