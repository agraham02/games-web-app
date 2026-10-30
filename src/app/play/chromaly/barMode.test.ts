import { createRng } from "@/engine/rng";
import type { SeatId } from "@/engine/types";
import { describe, expect, it } from "vitest";
import { createChromaly } from "@/games/chromaly/rules";
import { act, position, type Scenario } from "@/games/chromaly/testkit";
import type { ChromalyAction, ChromalyState } from "@/games/chromaly/types";
import type { GameRuntime } from "@/table/useGameRuntime";
import {
  OFFLINE_VIEW,
  barMode,
  canAct,
  canCall,
  canJump,
  needsChoice,
  togglePlayCard,
  type ChromalyView,
} from "./table";

type Live = GameRuntime<ChromalyState, ChromalyAction>;

/**
 * A runtime that is just enough for the band's questions: what the viewer is
 * shown, and what the game has really got to. Both are the same position here,
 * which is the settled case; the difference between them (a window answered
 * but still being animated) is covered by `latest` below.
 */
function live(
  state: ChromalyState,
  viewer: SeatId,
  over: Partial<Live> = {},
): Live {
  const def = createChromaly(state.rules);
  const shown = def.playerView(state, viewer);
  return {
    state: shown,
    rawState: state,
    latest: shown,
    animating: false,
    sending: false,
    isOver: false,
    ...over,
  } as unknown as Live;
}

const view = (seat: SeatId): ChromalyView => ({ ...OFFLINE_VIEW, viewerSeat: seat });

const BASE: Scenario = {
  hands: { 0: ["R3.1", "B1.1", "G2.1", "Y4.1"], 1: ["R4.1", "R6.1", "B2.1"], 2: ["Y2.1", "Y3.1", "Y5.1"], 3: ["G1.1", "G4.1", "B4.1"] },
  top: "R5.1",
};

describe("which bar the band shows", () => {
  it("is your turn's bar on your turn, and nothing on somebody else's", () => {
    const { state } = position({ ...BASE, turn: 0 });
    expect(barMode(view(0), live(state, 0))).toBe("turn");
    expect(barMode(view(1), live(state, 1))).toBeNull();
    expect(canAct(view(0), live(state, 0))).toBe(true);
    expect(canAct(view(1), live(state, 1))).toBe(false);
  });

  it("is nothing while the table is still showing the last move", () => {
    const { state } = position({ ...BASE, turn: 0 });
    expect(barMode(view(0), live(state, 0, { animating: true }))).toBeNull();
  });

  it("is a spectator's nothing at all", () => {
    const { state } = position({ ...BASE, turn: 0 });
    const spectator = view(-1 as SeatId);
    expect(barMode(spectator, live(state, -1 as SeatId))).toBeNull();
  });

  it("offers the drawn card's play-or-keep after a draw that can be played", () => {
    const { def, state } = position({ ...BASE, hands: { ...BASE.hands, 0: ["B1.1", "B2.1", "G3.1"] }, draw: ["R9.1"], turn: 0 });
    const drew = act(def, state, 0, { t: "draw" }).state;
    expect(barMode(view(0), live(drew, 0))).toBe("drawn");
  });

  it("is the penalty bar when a +4 or a stack is on the table", () => {
    const { def, state } = position({ ...BASE, hands: { ...BASE.hands, 0: ["F.1", "R2.1", "B1.1"] }, turn: 0 });
    const played = act(def, state, 0, { t: "play", cards: ["F.1"], color: "G" }).state;
    expect(barMode(view(1), live(played, 1))).toBe("penalty");
    expect(barMode(view(2), live(played, 2))).toBeNull();
  });

  describe("a seat on its last card", () => {
    const { def, state } = position({
      hands: { 0: ["B1.1", "G2.1", "Y4.1"], 1: ["R3.1", "R4.1"], 2: ["Y2.1", "Y3.1", "Y5.1"], 3: ["G1.1", "G4.1", "B4.1"] },
      top: "R5.1",
      turn: 1,
    });
    const opened = act(def, state, 1, { t: "play", cards: ["R3.1"] }).state;

    it("puts the button in front of EVERYONE, the seat itself and a bystander alike", () => {
      for (const seat of [0, 1, 2, 3] as SeatId[]) {
        expect(barMode(view(seat), live(opened, seat)), `seat ${seat}`).toBe("call");
        expect(canCall(view(seat), live(opened, seat))).toBe(true);
      }
    });

    it("takes it away from a seat whose answer is already in", () => {
      const answered = act(def, opened, 0, { t: "declineWindow", seat: 0 }).state;
      expect(barMode(view(0), live(answered, 0))).toBeNull();
      expect(barMode(view(2), live(answered, 2))).toBe("call");
    });

    it("keeps it off while the game has already moved past the window (it is only animating)", () => {
      const closed = act(def, opened, 0, { t: "callLast", seat: 0 }).state;
      const shown = def.playerView(opened, 0);
      // The table still shows the window; the game has closed it.
      const l = live(closed, 0, { state: shown });
      expect(canCall(view(0), l)).toBe(false);
    });

    it("never lets the seat on turn play into the window", () => {
      expect(canAct(view(2), live(opened, 2))).toBe(false);
    });
  });

  describe("a jump-in window", () => {
    const { def, state } = position({
      rules: { jumpIn: true },
      hands: { 0: ["R7.2", "G2.1", "Y3.1", "B4.1"], 1: ["R7.1", "B1.1", "B2.1"], 2: ["Y2.1", "Y3.1", "Y5.1"], 3: ["G1.1", "G4.1", "B4.1"] },
      top: "R5.1",
      turn: 1,
    });
    const opened = act(def, state, 1, { t: "play", cards: ["R7.1"] }).state;

    it("is open to the twin's holder only, who is told there is a chance but not which card", () => {
      expect(canJump(view(0), live(opened, 0))).toBe(true);
      expect(canJump(view(2), live(opened, 2))).toBe(false);
      // The band says "Jump in!" with its clock (the user, 2026-10-30: there
      // was no sign a chance existed). It has no button and lights no card.
      expect(barMode(view(0), live(opened, 0))).toBe("jump");
      expect(barMode(view(2), live(opened, 2))).toBeNull();
    });
  });
});

describe("what a card asks for", () => {
  it("a wild asks for its colour", () => {
    const { state } = position({ ...BASE, hands: { ...BASE.hands, 0: ["W.1", "F.1", "B1.1"] } });
    expect(needsChoice(state, 0, "W.1")).toBe("colour");
    expect(needsChoice(state, 0, "F.1")).toBe("colour");
    expect(needsChoice(state, 0, "B1.1")).toBeNull();
  });

  it("a 7 asks for a seat, but only with the rule on and more than one card", () => {
    const withRule = position({ ...BASE, rules: { sevenZero: true }, hands: { ...BASE.hands, 0: ["R7.1", "B1.1"] } });
    expect(needsChoice(withRule.state, 0, "R7.1")).toBe("swap");
    const without = position({ ...BASE, hands: { ...BASE.hands, 0: ["R7.1", "B1.1"] } });
    expect(needsChoice(without.state, 0, "R7.1")).toBeNull();
    const last = position({ ...BASE, rules: { sevenZero: true }, hands: { ...BASE.hands, 0: ["R7.1"] } });
    expect(needsChoice(last.state, 0, "R7.1")).toBeNull();
  });
});

describe("picking cards up", () => {
  const { state } = position({
    ...BASE,
    rules: { doubles: true, sevenZero: true },
    hands: { ...BASE.hands, 0: ["R3.1", "R3.2", "B3.1", "G4.1", "W.1", "R7.1"] },
  });

  it("builds a pair of one number, a card at a time", () => {
    let held = togglePlayCard([], "R3.1", state, 0);
    held = togglePlayCard(held, "B3.1", state, 0);
    expect(held).toEqual(["R3.1", "B3.1"]);
    expect(togglePlayCard(held, "B3.1", state, 0)).toEqual(["R3.1"]);
  });

  it("starts afresh on a card of another number", () => {
    expect(togglePlayCard(["R3.1"], "G4.1", state, 0)).toEqual(["G4.1"]);
  });

  it("picks a wild or a 7 alone, because each has a choice to make", () => {
    expect(togglePlayCard(["R3.1", "B3.1"], "W.1", state, 0)).toEqual(["W.1"]);
    expect(togglePlayCard(["R3.1"], "R7.1", state, 0)).toEqual(["R7.1"]);
    expect(togglePlayCard(["W.1"], "R3.1", state, 0)).toEqual(["R3.1"]);
  });

  it("does not need a state to put a card down", () => {
    expect(togglePlayCard(["R3.1"], "R3.1")).toEqual([]);
  });
});

// Keeps the rng import honest for the shared helper above.
void createRng;
