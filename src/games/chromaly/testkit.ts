/**
 * Test helpers for Chromaly: build exact positions, and drive whole matches.
 * Not imported by the game itself.
 */

import { createRng } from "@/engine/rng";
import type { BotDifficulty, GameEvent, PieceId, SeatId } from "@/engine/types";
import { COLORS, deckIds, parseCard, type Color } from "./cards";
import { createChromaly } from "./rules";
import type { ChromalyAction, ChromalyRules, ChromalyState } from "./types";

export interface Scenario {
  rules?: Partial<ChromalyRules>;
  seats?: number;
  /** Each seat's hand, by seat. Seats not named are dealt nothing. */
  hands: Record<number, PieceId[]>;
  /** The card showing, and (for a wild) the colour in force. */
  top: PieceId;
  color?: Color;
  turn?: SeatId;
  direction?: 1 | -1;
  /** Cards at the TOP of the draw pile, next to be drawn FIRST. */
  draw?: PieceId[];
  seed?: number;
}

/**
 * A dealt position with exactly these hands. Every other card goes to the
 * draw pile, so the deck is whole and conserved; `draw` names what comes off
 * the top first, which is how a test makes a draw predictable.
 */
export function position(s: Scenario): { def: ReturnType<typeof createChromaly>; state: ChromalyState } {
  const def = createChromaly(s.rules);
  const seats = s.seats ?? 4;
  const rng = createRng(s.seed ?? 7);
  const base = def.setup({ seats, rng });
  const hands: Record<SeatId, PieceId[]> = {};
  for (let seat = 0; seat < seats; seat++) hands[seat as SeatId] = [...(s.hands[seat] ?? [])];

  const used = new Set<PieceId>([s.top, ...Object.values(hands).flat(), ...(s.draw ?? [])]);
  const rest = deckIds(base.rules.shuffleHands).filter((id) => !used.has(id));
  // The pile draws from the END, so the cards named first go last.
  const drawPile = [...rest, ...[...(s.draw ?? [])].reverse()];

  // In a real game every seat on one card has already called it or got away
  // with not doing so - the moment it reached one card a window opened - so a
  // scenario's single-card seats are "passed", and only the seat a test is
  // about is left to be caught.
  const calls: ChromalyState["calls"] = {};
  for (let seat = 0; seat < seats; seat++) {
    if (hands[seat as SeatId]!.length === 1) calls[seat as SeatId] = "passed";
  }

  const top = parseCard(s.top)!;
  const state: ChromalyState = {
    ...base,
    round: 1,
    dealt: true,
    turn: s.turn ?? 0,
    direction: s.direction ?? 1,
    color: s.color ?? top.color ?? "R",
    calls,
    hands,
    drawPile,
    discard: [s.top],
  };
  return { def, state };
}

/** Every card in the game, wherever it is. Must stay the whole deck. */
export function everyCard(state: ChromalyState): PieceId[] {
  return [...Object.values(state.hands).flat(), ...state.drawPile, ...state.discard];
}

export function act(
  def: ReturnType<typeof createChromaly>,
  state: ChromalyState,
  seat: SeatId,
  action: ChromalyAction,
): { state: ChromalyState; events: GameEvent[] } {
  const problem = def.validate?.(state, seat, action);
  if (problem) throw new Error(`illegal for seat ${seat}: ${problem} (${JSON.stringify(action)})`);
  if (def.legalActions(state, seat).length === 0) throw new Error(`seat ${seat} may not act`);
  const resolved = def.completeAction ? def.completeAction(state, action, seat, createRng(1)) : action;
  return def.reduce(state, resolved);
}

export interface Played {
  state: ChromalyState;
  rounds: number;
  steps: number;
  /** Everything the match emitted, for counting what happened. */
  events: GameEvent[];
}

/**
 * Plays a whole match with every seat a bot, the way the session does: ask
 * `currentSeat`, show the bot `playerView`, reduce its choice. Checks along
 * the way that the deck is whole, that every choice passes `validate`, and
 * that something always happens.
 */
export function playMatch(opts: {
  rules?: Partial<ChromalyRules>;
  seats: number;
  seed: number;
  tiers?: BotDifficulty[];
  /** Stop after this many rounds, for rules whose target takes long. */
  maxRounds?: number;
  onStep?: (state: ChromalyState, seat: SeatId, action: ChromalyAction) => void;
}): Played {
  const def = createChromaly(opts.rules);
  const rng = createRng(opts.seed);
  let state = def.setup({ seats: opts.seats, rng });
  const total = deckIds(state.rules.shuffleHands).length;
  const events: GameEvent[] = [];
  let rounds = 0;
  let steps = 0;

  const deal = () => {
    const r = def.startRound!(state, rng);
    state = r.state;
    events.push(...r.events);
    rounds += 1;
  };
  deal();

  while (!def.isOver(state)) {
    if (def.isRoundOver!(state)) {
      if (rounds >= (opts.maxRounds ?? 60)) break;
      deal();
      continue;
    }
    if (++steps > 40_000) throw new Error(`no end after ${steps} steps (seed ${opts.seed})`);
    const seat = def.currentSeat(state);
    if (seat === null) throw new Error("nobody to act in a live round");
    const tier = opts.tiers?.[seat] ?? "steady";
    const bot = def.bots[tier];
    const view = def.playerView(state, seat);
    const action = bot.choose(view, seat, rng);
    const problem = def.validate!(state, seat, action);
    if (problem) {
      throw new Error(
        `bot ${tier} seat ${seat} chose an invalid action: ${problem} ${JSON.stringify(action)} (seed ${opts.seed})`,
      );
    }
    if (def.legalActions(state, seat).length === 0) throw new Error("a bot acted without a legal action");
    opts.onStep?.(state, seat, action);
    const r = def.reduce(state, action);
    state = r.state;
    events.push(...r.events);
    const all = everyCard(state);
    if (all.length !== total || new Set(all).size !== total) {
      throw new Error(`the deck is not whole after ${JSON.stringify(action)}: ${all.length}/${total}`);
    }
  }
  return { state, rounds, steps, events };
}

export { COLORS };
