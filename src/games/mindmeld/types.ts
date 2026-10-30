/**
 * Mind Meld state and actions.
 *
 * Teams of two, adjacent seats: pair `i` is seats `2i` and `2i + 1`. Each pair
 * keeps its own chain of words. Every try, each partner types a word in secret;
 * when everybody is in, a shared countdown runs and all the words are shown at
 * once. A pair whose two words are the same has melded; otherwise the next try
 * bridges the last two words said.
 *
 * Nothing here is a piece: the game places nothing on the table, so what a
 * viewer may know is entirely a matter of `playerView` - and the one secret is
 * a typed word until it is revealed.
 */

import type { SeatId } from "@/engine/types";

export interface MindMeldRules {
  /** Rounds in a match. */
  rounds: number;
  /** Tries a pair gets in a round before it scores nothing. */
  tries: number;
  /** Seconds to think each try; 0 is no limit. */
  thinkSeconds: number;
  /** `free`: any word to begin. `dealt`: each pair is given two to bridge. */
  start: "free" | "dealt";
  /** Keep the last two words faintly on the field while players think. */
  showLast: boolean;
  /** Refuse rude words before they are locked in. */
  familySafe: boolean;
  /**
   * `together`: every pair writes at once. `turns`: one pair at a time, the
   * rest watching (the user, 2026-10-30). Either way the first meld ends the
   * round. See `schedule.ts`.
   */
  pace: "together" | "turns";
}

export interface Pair {
  id: number;
  seats: [SeatId, SeatId];
  /**
   * Every word revealed, in order, the two partners' alternating: `[a1, b1, a2,
   * b2, ...]`. Public once revealed, which is the only time a word is. In a
   * dealt start it begins with the two words the pair was given.
   */
  chain: string[];
  /** Reveals (and timeouts) this round. */
  tries: number;
  /** The try it melded on, or null while it has not. */
  meldedOn: number | null;
  /** What it has earned this round. */
  points: number;
}

/** What one reveal came to, for every pair in it - public once shown. */
export interface Reveal {
  pair: number;
  a: string;
  b: string;
  outcome: "meld" | "close" | "miss" | "timeout";
}

/**
 * Every seat still to lock in a word, with how long a bot takes to think of
 * one, in ms from the try opening, soonest first. A person's entry is only
 * there to be ordered by; they lock in when they lock in. The same race shape
 * as BS's window: `currentSeat` names the soonest, every unlocked seat may
 * act, and a bot waits out its time before it answers (`turnHold`).
 */
export interface Window {
  pending: ReadonlyArray<{ seat: SeatId; ms: number }>;
  elapsed?: number;
}

export interface RoundResult {
  /** Points earned this round, by seat (mirrored within a pair). */
  deltas: Record<SeatId, number>;
  pairs: ReadonlyArray<{ seats: [SeatId, SeatId]; points: number; meldedOn: number | null; tries: number; chain: string[] }>;
  /** The first seat of the top pair: what the pod crown reads. */
  winner: SeatId;
  /** Always null: a round here is never ended by a backstop. */
  wentOut: null;
  blocked: false;
}

export interface MindMeldState {
  seats: number;
  rules: MindMeldRules;
  round: number;
  dealt: boolean;
  pairs: Pair[];
  /**
   * The word each seat has locked in this try, or null. PRIVATE: `playerView`
   * blanks everyone's but the viewer's, and a word only becomes public by being
   * revealed into a `chain`.
   */
  locks: Record<SeatId, string | null>;
  /** Tries so far this round: what a deadline's key is built from. */
  tryNo: number;
  window: Window | null;
  /** The last reveal, kept until the next one so the table can show it. */
  reveal: Reveal[] | null;
  /** Points by seat, mirrored within a pair, so every reader works without knowing about teams. */
  scores: Record<SeatId, number>;
  result: RoundResult | null;
  winner: SeatId | null;
}

export type MindMeldAction =
  /** Lock in a word. The seat is stamped by `completeAction`, never trusted. */
  | { t: "submit"; seat: SeatId; word: string }
  /** The think time is up: every pair still waiting forfeits its try. */
  | { t: "timeout" };
