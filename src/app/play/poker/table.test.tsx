// @vitest-environment jsdom

/**
 * The betting panel, read the way a player reads it.
 *
 * Reported: after a raise to $100 with $50 already in, the panel said only
 * "Call 50" — which reads as "the bet is $50". Nothing on it said what the
 * current bet was, or what this player had already put in. And the raise
 * was a big gold button over three small grey ones, which is steering, not
 * a choice.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRng } from "@/engine/rng";
import { createPoker } from "@/games/poker/rules";
import type { PokerAction, PokerState } from "@/games/poker/types";
import type { GameRuntime } from "@/table/useGameRuntime";
import { PokerControls, playerViews, roundSummary, type PokerView } from "./table";

const view: PokerView = {
  viewerSeat: 0,
  nameFor: (seat) => `Seat ${seat}`,
  colourFor: () => "var(--color-brass-300)",
} as PokerView;

/** Seat 0 on turn, facing a raise to $100 with $50 of its own already in. */
function facingARaise(): PokerState {
  const poker = createPoker();
  const rng = createRng(3);
  const dealt = poker.startRound!(poker.setup({ seats: 3, rng }), rng).state;
  return {
    ...dealt,
    folded: { 0: false, 1: false, 2: false },
    streetCommitted: { 0: 50, 1: 100, 2: 100 },
    totalCommitted: { 0: 50, 1: 100, 2: 100 },
    lastRaiseSize: 50,
    toAct: [0],
    pendingShowdown: null,
  };
}

function runtime(state: PokerState, submitAction = vi.fn()) {
  return {
    state,
    isHeroTurn: true,
    submitAction,
  } as unknown as GameRuntime<PokerState, PokerAction>;
}

describe("the betting panel", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("says what the bet is and what you have in, not only the difference", () => {
    render(<PokerControls view={view} live={runtime(facingARaise())} />);
    const figure = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(figure("Current bet")).toBe("$100");
    expect(figure("Your bet")).toBe("$50");
    const call = screen.getByRole("button", { name: /Call \$50/ });
    expect(call.textContent).toContain("matches $100");
  });

  it("offers every choice at the same weight", () => {
    render(<PokerControls view={view} live={runtime(facingARaise())} />);
    const choices = ["Fold", "Call", "Raise to"].map(
      (name) => screen.getByRole("button", { name: new RegExp(`^${name}`) }).className,
    );
    expect(new Set(choices).size).toBe(1);
  });

  it("sizes a raise with a stepper, not a slider, and raises to what it shows", () => {
    const submit = vi.fn();
    render(<PokerControls view={view} live={runtime(facingARaise(), submit)} />);
    expect(document.querySelector('input[type="range"]')).toBeNull();
    // The minimum raise is to $150: the $100 bet plus the last raise's $50.
    screen.getByRole("button", { name: /^Raise to \$150/ });
    fireEvent.click(screen.getByRole("button", { name: "More chips" }));
    fireEvent.click(screen.getByRole("button", { name: /^Raise to/ }));
    const sent = submit.mock.calls.at(-1)?.[0] as PokerAction;
    expect(sent.t).toBe("raise");
    expect((sent as { to: number }).to).toBeGreaterThan(150);
  });

  it("keeps what you put in on earlier streets in view, under this round's bet", () => {
    // Reported on the flop: "Your bet $0" after calling $50 preflop read as
    // though the $50 had vanished. This round's bet is still what a call is
    // measured against; the hand's total sits underneath it.
    const flop: PokerState = {
      ...facingARaise(),
      streetCommitted: { 0: 0, 1: 362, 2: 0 },
      totalCommitted: { 0: 50, 1: 412, 2: 50 },
    };
    render(<PokerControls view={view} live={runtime(flop)} />);
    const yours = screen.getByText("Your bet").parentElement!;
    expect(yours.textContent).toContain("$0");
    expect(yours.textContent).toContain("Total bet $50");
    // With nothing in yet this round the call IS the bet, so the button
    // does not repeat it back ("Call $362 · matches $362").
    expect(screen.getByRole("button", { name: /Call \$362/ }).textContent).not.toContain("matches");
  });
});

describe("an opponent's pod", () => {
  it("puts the stack and the bet on lines of their own", () => {
    // "$4837 · bet $362" on one line is wider than a pod, and the bet was
    // the part cut off.
    const views = playerViews(view, facingARaise(), runtime(facingARaise()));
    const betting = views.find((v) => v.seat === 1)!;
    expect(betting.meta).toEqual([`$${facingARaise().stacks[1]}`, "bet $100"]);
  });
});

describe("the end-of-hand summary", () => {
  /** Plays bot hands until one ends the requested way. */
  function handThatEnded(showdown: boolean): PokerState {
    const poker = createPoker();
    const rng = createRng(showdown ? 5 : 8);
    let state = poker.startRound!(poker.setup({ seats: 4, rng }), rng).state;
    for (let i = 0; i < 5000; i++) {
      if (state.result) {
        if (state.result.showdown === showdown) return state;
        state = poker.startRound!(state, rng).state;
        continue;
      }
      const seat = poker.currentSeat(state)!;
      state = poker.reduce(state, poker.bots.steady.choose(poker.playerView(state, seat), seat, rng)).state;
    }
    throw new Error("no such hand");
  }

  it("shows what each seat actually won or lost, which adds up to nothing", () => {
    // It showed the PAYOUT: +50 to a winner who had put in 20, and +0 to
    // players who were down.
    for (const showdown of [true, false]) {
      const card = roundSummary(view, handThatEnded(showdown))!;
      expect(card.rows.reduce((n, r) => n + r.delta, 0)).toBe(0);
      expect(card.rows.some((r) => r.delta < 0)).toBe(true);
    }
  });

  it("names the winning hand, and calls a beaten hand lost rather than folded", () => {
    const state = handThatEnded(true);
    const card = roundSummary(view, state)!;
    expect(card.title).toMatch(/ with | split /);
    for (const seat of state.result!.showdownSeats) {
      const row = card.rows.find((r) => r.seat === seat)!;
      expect(row.detail).toMatch(/^(won|lost)/);
    }
  });

  it("says why a hand ended without a showdown", () => {
    const card = roundSummary(view, handThatEnded(false))!;
    expect(card.note?.body).toMatch(/Everyone else folded/);
  });
});

describe("hints, and what is always shown", () => {
  it("explains each choice only with Hints on", () => {
    const { unmount } = render(<PokerControls view={view} live={runtime(facingARaise())} hints />);
    expect(screen.getByRole("button", { name: /^Fold/ }).textContent).toContain("give up this hand");
    expect(screen.getByRole("button", { name: /^Call/ }).textContent).toContain("to stay in");
    unmount();

    render(<PokerControls view={view} live={runtime(facingARaise())} hints={false} />);
    expect(screen.getByRole("button", { name: /^Fold/ }).textContent).toBe("Fold");
    // The call still says what it matches when that differs — not a hint.
    expect(screen.getByRole("button", { name: /^Call/ }).textContent).toContain("matches $100");
  });

  it("always names the hand you hold", () => {
    const state = facingARaise();
    render(<PokerControls view={view} live={runtime(state)} hints={false} />);
    const yours = screen.getByText("Your hand").parentElement!;
    expect(yours.textContent).not.toContain("—");
    expect(yours.textContent).toMatch(/high|Pair of/);
  });

  it("does not repeat your bet as a total when the two are the same", () => {
    const first: PokerState = {
      ...facingARaise(),
      streetCommitted: { 0: 50, 1: 100, 2: 100 },
      totalCommitted: { 0: 50, 1: 100, 2: 100 },
    };
    render(<PokerControls view={view} live={runtime(first)} />);
    expect(screen.getByText("Your bet").parentElement!.textContent).not.toContain("Total bet");
  });
});

describe("the summary, read from a player's own view", () => {
  it("never names a hand it cannot see — a mucked loser is just 'lost'", () => {
    // Reported: "lost · Full house, Jacks and NaNs". A view does not drop
    // a masked hand; it keeps it under placeholder ids, and the summary
    // parsed those as cards.
    const poker = createPoker();
    let checked = 0;
    for (let seed = 1; seed < 400 && checked < 5; seed++) {
      const rng = createRng(seed);
      let state = poker.startRound!(poker.setup({ seats: 4, rng }), rng).state;
      for (let i = 0; i < 400 && !state.result; i++) {
        const seat = poker.currentSeat(state)!;
        state = poker.reduce(state, poker.bots.steady.choose(poker.playerView(state, seat), seat, rng)).state;
      }
      const result = state.result;
      if (!result) continue;
      // A loser at the showdown whose cards seat 0 never saw.
      const mucker = result.showdownSeats.find(
        (s) => s !== 0 && !result.winningSeats.includes(s) && state.folded[s],
      );
      if (mucker === undefined) continue;
      checked++;
      const card = roundSummary(view, poker.playerView(state, 0))!;
      expect(JSON.stringify(card)).not.toContain("NaN");
      expect(card.rows.find((r) => r.seat === mucker)!.detail).toBe("lost");
      // And it says WHY, rather than leaving a win against hidden cards
      // unexplained — the second report.
      expect(card.note?.title).toMatch(/^Why /);
      expect(card.note?.body).toContain(`Seat ${mucker} didn't show their cards`);

      // Where the losing hand IS visible (the whole truth, here), the note
      // compares the two hands instead.
      const told = roundSummary(view, state)!;
      expect(told.note?.body).toMatch(/ beats /);
    }
    expect(checked, "should have found hands with a mucked loser").toBeGreaterThan(0);
  });
});
