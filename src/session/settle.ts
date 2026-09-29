/**
 * Who pays whom, once a game played for real money is over.
 *
 * Poker and LRC are played for money (the user, 2026-09-28), and a room's
 * players may be anywhere, so at the end somebody has to send somebody
 * something. This works out the FEWEST payments that square everyone up —
 * not merely "every loser pays every winner a share", which with five
 * players can be six or more transfers where two would do.
 *
 * Three steps, each its own function so each can be tested alone:
 *
 *  1. What each seat is up or down, in cents (`pokerNets`, `lrcNets`). The
 *     game's own numbers turned into money at the room's stake.
 *  2. People only (`amongPeople`). A room fills empty seats with bots, and
 *     nobody pays a bot or is paid by one: what people won from bots, or lost
 *     to them, is left out, and the rest is scaled down to what people can
 *     actually pay each other (the user's call).
 *  3. The fewest payments (`fewestPayments`). Exact, not greedy: the fewest
 *     possible is the number of people owed or owing, less the most groups
 *     they split into that each square up among themselves. At ten players
 *     at most that is a search over 1,024 subsets, which is instant.
 *
 * Everything is whole cents, and every rounding keeps the total at exactly
 * zero, so the payments always balance to the cent.
 */

import type { SeatId } from "@/engine/types";
import { CHIPS_PER_PLAYER } from "@/games/lrc/rules";
import type { LrcState } from "@/games/lrc/types";
import type { PokerState } from "@/games/poker/types";

export interface Payment {
  from: SeatId;
  to: SeatId;
  cents: number;
}

/* ============================================================
   Rounding that keeps a total
   ============================================================ */

/**
 * Whole numbers for `exact`, adding up to `total` exactly: everything
 * rounded down, then the shortfall handed out one at a time to the largest
 * fractions (ties to the lower seat, so the result never depends on order).
 */
function roundToTotal(exact: ReadonlyArray<{ seat: SeatId; value: number }>, total: number): Map<SeatId, number> {
  const out = new Map<SeatId, number>();
  const rest = exact.map(({ seat, value }) => {
    const down = Math.floor(value + 1e-9);
    out.set(seat, down);
    return { seat, frac: value - down };
  });
  let short = total - [...out.values()].reduce((a, b) => a + b, 0);
  rest.sort((a, b) => b.frac - a.frac || a.seat - b.seat);
  for (const r of rest) {
    if (short <= 0) break;
    out.set(r.seat, out.get(r.seat)! + 1);
    short--;
  }
  return out;
}

/* ============================================================
   1. What each seat is up or down
   ============================================================ */

/**
 * Poker: each seat's chips now against what it bought in with, at the
 * room's buy-in for a starting stack.
 *
 * A hand still being played is called off — everyone takes back what they
 * put into it — since nobody has won it. A hand at its showdown HAS been
 * won (the pots are decided before anyone shows or mucks), so it is paid.
 */
export function pokerNets(state: PokerState, buyInCents: number, startingStack: number): Record<SeatId, number> {
  const chips: Array<{ seat: SeatId; value: number }> = [];
  for (let seat = 0; seat < state.seats; seat++) {
    let held = state.stacks[seat] ?? 0;
    if (state.result === null) {
      held += state.pendingShowdown
        ? (state.pendingShowdown.pendingDeltas[seat] ?? 0)
        : (state.totalCommitted[seat] ?? 0);
    }
    chips.push({ seat, value: ((held - startingStack) * buyInCents) / startingStack });
  }
  return Object.fromEntries(roundToTotal(chips, 0));
}

/**
 * LRC: every round, everybody antes their three chips and the last player
 * holding any takes all of them — so a round won is everyone else's three
 * chips, and a round lost is your own three. Only rounds played to the end
 * count; a round stopped halfway has no winner yet, and its chips go back.
 */
export function lrcNets(state: LrcState, chipCents: number): Record<SeatId, number> {
  let rounds = 0;
  for (let seat = 0; seat < state.seats; seat++) rounds += state.scores[seat] ?? 0;
  const out: Record<SeatId, number> = {};
  for (let seat = 0; seat < state.seats; seat++) {
    const won = state.scores[seat] ?? 0;
    out[seat] = (won * state.seats - rounds) * CHIPS_PER_PLAYER * chipCents;
  }
  return out;
}

/* ============================================================
   2. People only
   ============================================================ */

/**
 * The same results with every bot left out. Where people between them won
 * more than they lost (the rest came from bots), each winner's share is
 * scaled down to what the losers actually owe; the other way round, each
 * loser's. `scaled` says whether that happened, so the table can say why
 * the numbers are smaller than the game's.
 */
export function amongPeople(
  nets: Readonly<Record<SeatId, number>>,
  people: readonly SeatId[],
): { nets: Record<SeatId, number>; scaled: boolean } {
  const mine = people.map((seat) => ({ seat, value: nets[seat] ?? 0 }));
  const up = mine.reduce((n, p) => n + Math.max(0, p.value), 0);
  const down = mine.reduce((n, p) => n + Math.max(0, -p.value), 0);
  if (up === down) {
    return { nets: Object.fromEntries(mine.map((p) => [p.seat, p.value])), scaled: false };
  }

  const out: Record<SeatId, number> = {};
  const [bigger, sign, target] = up > down ? ([up, 1, down] as const) : ([down, -1, up] as const);
  const side = mine.filter((p) => Math.sign(p.value) === sign);
  const scaled = roundToTotal(
    side.map((p) => ({ seat: p.seat, value: (Math.abs(p.value) * target) / bigger })),
    target,
  );
  for (const p of mine) {
    out[p.seat] = Math.sign(p.value) === sign ? sign * (scaled.get(p.seat) ?? 0) : p.value;
  }
  return { nets: out, scaled: true };
}

/* ============================================================
   3. The fewest payments
   ============================================================ */

/**
 * The fewest payments that leave everyone square. `nets` must add up to
 * zero (cents; positive is owed, negative owes).
 *
 * Every group of people whose results sum to zero can square up among
 * themselves in one payment fewer than there are of them, and no set of
 * payments does better than that. So the fewest payments is the number of
 * people not already even, less the MOST such groups they can be split
 * into. `groups[mask]` is that most for a subset; walking back down from
 * the whole table recovers the groups, and each is paid off largest debt
 * to largest credit.
 */
export function fewestPayments(nets: Readonly<Record<SeatId, number>>): Payment[] {
  const seats = Object.keys(nets)
    .map(Number)
    .filter((seat) => (nets[seat] ?? 0) !== 0)
    .sort((a, b) => a - b);
  const amount = seats.map((seat) => nets[seat]!);
  const n = seats.length;
  if (n === 0) return [];

  // Past 16 people the search is too big to be worth it; one group, paid
  // off largest first, is never more than one payment per person.
  let parts: number[][];
  if (n > 16) {
    parts = [seats.map((_, i) => i)];
  } else {
    const full = (1 << n) - 1;
    const sum = new Array<number>(full + 1).fill(0);
    const groups = new Array<number>(full + 1).fill(0);
    for (let mask = 1; mask <= full; mask++) {
      const low = mask & -mask;
      sum[mask] = sum[mask ^ low]! + amount[31 - Math.clz32(low)]!;
      let best = 0;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) best = Math.max(best, groups[mask ^ (1 << i)]!);
      }
      groups[mask] = best + (sum[mask] === 0 ? 1 : 0);
    }

    // Back down from the whole table, one person at a time, always to a
    // subset that keeps the most groups. Every time what is left squares
    // up on its own, the people taken since the last time are a group.
    parts = [];
    let mask = full;
    let part: number[] = [];
    while (mask) {
      const here = sum[mask] === 0 ? 1 : 0;
      let pick = 0;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i) && groups[mask ^ (1 << i)]! + here === groups[mask]) {
          pick = i;
          break;
        }
      }
      part.push(pick);
      mask ^= 1 << pick;
      if (sum[mask] === 0) {
        parts.push(part);
        part = [];
      }
    }
  }

  const payments: Payment[] = [];
  for (const group of parts) {
    const order = (a: { seat: SeatId; left: number }, b: { seat: SeatId; left: number }) =>
      b.left - a.left || a.seat - b.seat;
    const owes = group.filter((i) => amount[i]! < 0).map((i) => ({ seat: seats[i]!, left: -amount[i]! })).sort(order);
    const owed = group.filter((i) => amount[i]! > 0).map((i) => ({ seat: seats[i]!, left: amount[i]! })).sort(order);
    let a = 0;
    let b = 0;
    while (a < owes.length && b < owed.length) {
      const cents = Math.min(owes[a]!.left, owed[b]!.left);
      payments.push({ from: owes[a]!.seat, to: owed[b]!.seat, cents });
      owes[a]!.left -= cents;
      owed[b]!.left -= cents;
      if (owes[a]!.left === 0) a++;
      if (owed[b]!.left === 0) b++;
    }
  }
  return payments.sort((x, y) => y.cents - x.cents || x.from - y.from || x.to - y.to);
}

/* ============================================================
   The room's stake
   ============================================================ */

/**
 * The stake a room set, from its PARSED settings, or null when the game is
 * not played for money (the stake is off, or the game has none).
 */
export function stakeOf(gameId: string, settings: Readonly<Record<string, unknown>>): { cents: number; label: string } | null {
  if (gameId === "poker") {
    const cents = Number(settings.buyIn) || 0;
    return cents > 0 ? { cents, label: `${formatMoney(cents)} buy-in` } : null;
  }
  if (gameId === "lrc") {
    const cents = Number(settings.chipValue) || 0;
    return cents > 0 ? { cents, label: `${formatMoney(cents)} a chip` } : null;
  }
  return null;
}

/**
 * What each seat is up or down this moment, in cents at the room's stake,
 * or null when the game is not played for money. Step 1 for whichever game
 * it is — and what a stint is measured with (see `Stint`).
 */
export function seatNets(
  gameId: string,
  state: unknown,
  settings: Readonly<Record<string, unknown>>,
): Record<SeatId, number> | null {
  const stake = stakeOf(gameId, settings);
  if (!stake) return null;
  return gameId === "poker"
    ? pokerNets(state as PokerState, stake.cents, Number(settings.startingStack))
    : lrcNets(state as LrcState, stake.cents);
}

/**
 * One person's time in one seat: where the seat stood (`seatNets`) when
 * they sat down, and when they got up — or null while it is still theirs.
 *
 * Money is owed by PEOPLE, not by seats (the user, 2026-09-28). Settled by
 * seat, somebody who took over a losing bot's seat halfway owed what the
 * bot had lost before they sat down, and somebody who left the room — or
 * was kicked from it — halfway dropped out of the money as if they had been
 * a bot all along. So each person answers for what their seat did while it
 * was theirs, and what a seat did under a bot is the bots' part, left out
 * like any other (see `amongPeople`).
 */
export interface Stint<Who> {
  who: Who;
  seat: SeatId;
  from: number;
  to: number | null;
}

export interface Settlement<Who> {
  /** "$20 buy-in", "25¢ a chip". */
  stake: string;
  /** Each person's result in cents, bots left out (see `amongPeople`). */
  results: Array<{ who: Who; cents: number }>;
  payments: Array<{ from: Who; to: Who; cents: number }>;
  /** Whether bots won or lost some of the money, so people's is scaled. */
  botsLeftOut: boolean;
}

/**
 * Everything above, for the people who sat at the table and the position
 * now: a person's result is what their seats did during their stints, added
 * up if they sat down more than once. Null when the game is not played for
 * money, or when nobody played it.
 */
export function settleUp<Who>(
  gameId: string,
  state: unknown,
  settings: Readonly<Record<string, unknown>>,
  stints: ReadonlyArray<Stint<Who>>,
): Settlement<Who> | null {
  const stake = stakeOf(gameId, settings);
  const now = seatNets(gameId, state, settings);
  if (!stake || !now || stints.length === 0) return null;

  // People by their first stint, so everything below can key them by index.
  const people: Who[] = [];
  const cents: Record<number, number> = {};
  for (const stint of stints) {
    let i = people.indexOf(stint.who);
    if (i === -1) i = people.push(stint.who) - 1;
    cents[i] = (cents[i] ?? 0) + (stint.to ?? now[stint.seat] ?? 0) - stint.from;
  }

  const settled = amongPeople(
    cents,
    people.map((_, i) => i),
  );
  return {
    stake: stake.label,
    results: people.map((who, i) => ({ who, cents: settled.nets[i] ?? 0 })),
    payments: fewestPayments(settled.nets).map((p) => ({
      from: people[p.from]!,
      to: people[p.to]!,
      cents: p.cents,
    })),
    botsLeftOut: settled.scaled,
  };
}

/** "$1.50", "$20", "25¢". */
export function formatMoney(cents: number): string {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "−" : "";
  if (abs < 100) return `${sign}${abs}¢`;
  return `${sign}$${abs % 100 === 0 ? abs / 100 : (abs / 100).toFixed(2)}`;
}
