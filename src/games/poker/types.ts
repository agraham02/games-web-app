/**
 * Poker (No-Limit Texas Hold'em) — state and action shapes.
 *
 * Match-scoped fields persist across hands (stacks, button, blinds);
 * hand-scoped fields reset every `startRound`. One sub-decision sits
 * OUTSIDE the ordinary betting-turn loop, the same shape as Rummy's
 * `claimWindow`/`dealSizePending` (see `src/games/rummy/types.ts`) — it
 * seizes `currentSeat` regardless of whose turn it would otherwise be:
 *
 *   `pendingShowdown`   who still has to choose to show or muck
 *
 * A busted seat is never stored as its own flag — every reader that
 * needs it (dealing, blind rotation, turn order) derives it fresh from
 * `stacks`, the same way LRC derives `isEliminated` from `chipsHeld`
 * rather than storing it. The one place that matters: `stacks[seat]
 * === 0` means "busted from the match" only BETWEEN hands — mid-hand it
 * just as often means "all-in, still very much in this pot" (see
 * `isAllIn` vs the plain stack check in `state.ts`).
 */

import type { PieceId, SeatId } from "@/engine/types";

export type PokerStreet = "preflop" | "flop" | "turn" | "river";

export interface PotLayer {
  amount: number;
  /** Non-folded seats who covered this layer's contribution level —
   * whoever holds the best hand among these splits it. */
  eligible: SeatId[];
}

export interface PokerHandResult {
  /** False when the hand ended by everyone-but-one folding — no hand was
   * ever compared, nothing was revealed. */
  showdown: boolean;
  winningSeats: SeatId[];
  /**
   * What each seat was PAID from the pot(s) — only winners appear. Not a
   * net change: a winner's own contribution is inside it, and a loser is
   * simply absent. It was documented as "net", and the scorecard showed it
   * as net: +50 for a winner who had put in 20, +0 for a player $20 down.
   */
  deltas: Record<SeatId, number>;
  /** Net stack change this hand, for every seat dealt in — payout minus
   * what the seat put in. What the scorecard shows. */
  net: Record<SeatId, number>;
  /** Seats still in at a showdown, including any who then mucked — so a
   * losing hand that was not shown reads as lost, not folded. Empty when
   * the hand ended without one. */
  showdownSeats: SeatId[];
}

/**
 * A genuine showdown in progress. Real payout never depends on who
 * visually reveals — winners are already decided the moment this is
 * built — but it still has to run to completion before `result` is set,
 * or the runtime would move straight to the round scorecard with no
 * chance for the hero to answer (see `useGameRuntime`'s `isRoundOver`
 * gate).
 */
export interface PendingShowdown {
  /** Auto-shown, no decision — you don't get to hide that you won. */
  winningSeats: SeatId[];
  /** Remaining non-winning, non-folded seats still to decide, in reveal
   * order (`order[0]` is whoever's turn it is). Empties as each seat
   * resolves show/muck — a bot resolves inline the instant it's
   * reached; the hero gets a real (timed) turn. */
  order: SeatId[];
  /** Computed once, at showdown-start; applied once `order` empties. */
  pendingDeltas: Record<SeatId, number>;
  /** Everyone still in when the showdown began — see `showdownSeats`. */
  contested: SeatId[];
}

export interface PokerState {
  // ---- match-scoped: persist across hands ----
  seats: number;
  smallBlind: number;
  bigBlind: number;
  /** 1-based; 0 before the first deal. */
  hand: number;
  button: SeatId;
  /** Chips NOT committed to the current hand's pot. */
  stacks: Record<SeatId, number>;
  /** Set once only one seat has stack > 0. */
  winner: SeatId | null;

  // ---- hand-scoped: reset every startRound ----
  /**
   * Every one of the 52 cards' current location — the same flat
   * ownership-map shape as LRC's `chipOwner`. `"deck"` covers both the
   * undealt stock and cards not yet reached; `"burnt"` is a card
   * discarded face-down ahead of a street reveal, never referenced
   * again by any hand or `communityOrder`.
   */
  cardOwner: Record<PieceId, SeatId | "community" | "burnt" | "deck">;
  /**
   * The remaining `"deck"`-valued cards, in shuffle order — `deck[0]` is
   * the next card dealt or burnt. `reduce` gets no `rng` (see
   * `engine/types.ts`'s `ReduceResult` contract), so this is what lets a
   * street transition inside `reduce` itself deal deterministically:
   * the one real shuffle happens once, in `startRound`, and every card
   * after the opening deal is just consumed off the front of this array
   * from then on. Same role Rummy's `stock: PieceId[]` plays for its own
   * draw pile.
   */
  deck: PieceId[];
  /** Reveal order — length derives the street (0 preflop, 3 flop, 4
   * turn, 5 river). See `deriveStreet`. */
  communityOrder: PieceId[];
  /** Only ever has entries for seats DEALT INTO this hand — see
   * `dealtSeats`, which reads this map's keys as the source of truth for
   * "who is in this hand" for the whole hand's lifetime. */
  folded: Record<SeatId, boolean>;
  /** This street only; every entry resets to 0 when a street closes. */
  streetCommitted: Record<SeatId, number>;
  /** The whole hand — side-pot layering (`computePots`) reads this. */
  totalCommitted: Record<SeatId, number>;
  /** The size of the last FULL bet/raise this street — the increment a
   * new raise must at least match to reopen the action. */
  lastRaiseSize: number;
  /**
   * How many full bets/raises have landed THIS street, reset to 0 when
   * a street closes. Public information — everyone at the table can
   * count the raises — so `playerView` leaves it alone.
   *
   * Carried on the state rather than inferred by the bots because a
   * bot re-deriving a fact `rules.ts` already knows is how this game
   * shipped its one pre-release bug (bots read "bet vs raise" off
   * `amountToCall` while `legalActions` read it off
   * `highestStreetCommitted`). `lastRaiseSize` cannot answer this:
   * several different raise sequences produce the same increment.
   *
   * What reads it: `bots.ts` raises its required equity for each raise
   * already faced. Without that, a bot's preflop strength never changes
   * within a street, so two bots that both liked their hands re-raised
   * each other until one was all-in — the reported "bots go all-in way
   * too much" bug.
   */
  raisesThisStreet: number;
  /**
   * Set once an incomplete (under-minraise) all-in raise happens this
   * street. Deliberate scope cut from exact casino rules: rather than
   * tracking, per seat, whether they'd already closed out their raise
   * rights before the short all-in landed, betting simply closes for
   * EVERYONE for the rest of the street once this fires — everyone
   * still owed a response may only call or fold. This is one of the
   * most obscure rules in poker and rarely enforced precisely even at a
   * real casual table; the simplification costs nothing on the much
   * more common path (a seat who already called being denied a phantom
   * re-raise right) and only differs from exact casino rules in the
   * rare case of a NOT-yet-acted seat also losing a raise it would
   * technically still be owed.
   */
  raiseCapped: boolean;
  /** Ordered queue of seats still owed a response this street.
   * `toAct[0]` is whoever's turn it is; empty once the street is
   * settled. */
  toAct: SeatId[];
  pendingShowdown: PendingShowdown | null;
  result: PokerHandResult | null;
}

export type PokerAction =
  | { t: "fold" }
  | { t: "check" }
  | { t: "call" }
  /** Legal only when nobody has bet yet this street. `to` is the TOTAL
   * amount committed THIS STREET once the bet lands, not a delta. */
  | { t: "bet"; to: number }
  /** Legal only once someone has already bet this street. Same
   * total-not-delta shape as `bet`. */
  | { t: "raise"; to: number }
  | { t: "show" }
  | { t: "muck" };
