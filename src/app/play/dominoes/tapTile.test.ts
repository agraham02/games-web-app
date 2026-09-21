// @vitest-environment jsdom

/**
 * What a tap on one of your own tiles means.
 *
 * This is a rules question — how many ends will this tile legally go on —
 * and for a while the two screens answered it differently. The offline
 * page played a tile immediately when only one end could take it; the
 * online table put ghosts up on every tap and asked the player to confirm
 * a choice that did not exist. Same game, same tile, two behaviours,
 * because the answer was written twice.
 *
 * So the rule moved into `tapTile` and both screens call it. These tests
 * are on the rule rather than on either screen: what the two genuinely
 * differ by is where the held tile is kept, which is the three callbacks,
 * and none of that is what went wrong.
 */

import { describe, expect, it, vi } from "vitest";
import type { PieceId } from "@/engine/types";
import type { ChainEnd, DomAction, DomState } from "@/games/dominoes/types";
import type { GameRuntime } from "@/table/useGameRuntime";
import { tapTile } from "./table";

/**
 * A chain with a 3 open on the left and a 5 on the right.
 *
 * `playableEnds` reads `state.chain` and nothing else, so this is the
 * whole of what the rule needs — a dealt game would add sixty fields none
 * of which are consulted.
 */
function board(chain: Array<{ a: number; b: number }> = [{ a: 3, b: 5 }]): DomState {
  return { chain } as unknown as DomState;
}

function live(state: DomState, isHeroTurn = true): GameRuntime<DomState, DomAction> {
  return { state, isHeroTurn } as unknown as GameRuntime<DomState, DomAction>;
}

function handlers() {
  return {
    select: vi.fn<(tile: PieceId) => void>(),
    release: vi.fn<() => void>(),
    play: vi.fn<(tile: PieceId, end: ChainEnd) => void>(),
  };
}

describe("tapTile", () => {
  it("plays a tile outright when only one end can take it", () => {
    // The bug, stated: `3-1` fits the open 3 and nothing else. There is
    // no decision to make, so being asked to make one is the game
    // getting in the way.
    const on = handlers();
    tapTile("3-1", live(board()), null, on);

    expect(on.play).toHaveBeenCalledWith("3-1", "left");
    expect(on.select).not.toHaveBeenCalled();
  });

  it("picks a tile up when either end would take it", () => {
    // `3-5` fits both open ends, which is a real choice and gets ghosts.
    const on = handlers();
    tapTile("3-5", live(board()), null, on);

    expect(on.select).toHaveBeenCalledWith("3-5");
    expect(on.play).not.toHaveBeenCalled();
  });

  it("names the end that actually fits, not just the first one", () => {
    // The failure a `ends[0]` shortcut would hide: with a 5 open on the
    // right and nothing else, `5-1` has to go RIGHT. Playing it left is a
    // rejected action and a turn the player appears to have lost.
    const on = handlers();
    tapTile("5-1", live(board([{ a: 3, b: 5 }])), null, on);

    expect(on.play).toHaveBeenCalledWith("5-1", "right");
  });

  it("ignores a tile that cannot go anywhere", () => {
    const on = handlers();
    tapTile("2-4", live(board()), null, on);

    expect(on.play).not.toHaveBeenCalled();
    expect(on.select).not.toHaveBeenCalled();
    expect(on.release).not.toHaveBeenCalled();
  });

  it("ignores every tap when it is not your turn", () => {
    // Tapping ahead of your turn must not queue anything up — the seat
    // has no legal action, and a held tile would outlive the position it
    // was legal in.
    const on = handlers();
    tapTile("3-1", live(board(), false), null, on);

    expect(on.play).not.toHaveBeenCalled();
    expect(on.select).not.toHaveBeenCalled();
  });

  it("puts the held tile back down when it is tapped again", () => {
    const on = handlers();
    tapTile("3-5", live(board()), "3-5", on);

    expect(on.release).toHaveBeenCalled();
    expect(on.play).not.toHaveBeenCalled();
    expect(on.select).not.toHaveBeenCalled();
  });

  it("drops the tile it was holding before picking up a different one", () => {
    // Otherwise the first tile stays lifted out of the fan and its ghosts
    // stay on the board, and two tiles look held at once.
    const on = handlers();
    tapTile("3-5", live(board([{ a: 3, b: 3 }, { a: 3, b: 5 }])), "5-5", on);

    expect(on.release).toHaveBeenCalled();
    expect(on.select).toHaveBeenCalledWith("3-5");
  });

  it("releases the old tile even when the new one plays immediately", () => {
    // The case the ordering matters for: holding `3-5` (two ends), then
    // tapping `5-1` (one end). Without the release the played tile lands
    // while the previous one is still lifted and still casting ghosts.
    const on = handlers();
    tapTile("5-1", live(board()), "3-5", on);

    expect(on.release).toHaveBeenCalled();
    expect(on.play).toHaveBeenCalledWith("5-1", "right");
  });

  it("plays the opening tile of an empty board without asking", () => {
    // An empty chain has no ends at all, and `playableEnds` answers
    // `["right"]` — one option, so the same rule covers the first tile of
    // a round rather than needing a case of its own.
    const on = handlers();
    tapTile("6-6", live(board([])), null, on);

    expect(on.play).toHaveBeenCalledWith("6-6", "right");
  });
});
