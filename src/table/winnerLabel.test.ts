// @vitest-environment node
//
// Pure functions about who "You" is. No DOM needed, and deliberately
// none used: the bug these cover is arithmetic about seat numbers, and a
// rendered test would have buried it under a table.

import { describe, expect, it } from "vitest";
import type { SeatId } from "@/engine/types";
import type { SeatView } from "./SeatRing";
import type { GameRuntime } from "./useGameRuntime";
import { winLoseStandings, winnerLabel } from "./GameHost";

/** Only the two fields these functions read. */
function runtimeWinning(seat: SeatId | null) {
  return { winner: seat } as unknown as GameRuntime<unknown, unknown>;
}

/**
 * The seats OTHER than the viewer, which is what `players()` returns —
 * every game's `playerViews` skips the viewer's own seat, because the
 * viewer is the hand at the bottom of the screen rather than a pod.
 */
function others(viewer: SeatId | null, count = 4): SeatView[] {
  const out: SeatView[] = [];
  for (let seat = 0; seat < count; seat++) {
    if (seat === viewer) continue;
    out.push({ seat: seat as SeatId, name: `Player ${seat}`, colour: "#fff" } as SeatView);
  }
  return out;
}

describe("who the winner is called", () => {
  it("says You to the viewer who won, wherever they sit", () => {
    // Seat 0 was hardcoded as "You". Online the viewer may be any seat,
    // and `seatViews` has no entry for their own — so a viewer winning
    // from seat 2 fell through to the literal word "Winner".
    for (const seat of [0, 1, 2, 3] as SeatId[]) {
      expect(winnerLabel(runtimeWinning(seat), others(seat), seat)).toBe("You");
    }
  });

  it("names the winner to everybody else", () => {
    // The other half of the same bug, and the louder one: whoever
    // happened to sit at seat 0 winning told EVERY player "You won".
    expect(winnerLabel(runtimeWinning(0), others(2), 2)).toBe("Player 0");
    expect(winnerLabel(runtimeWinning(3), others(1), 1)).toBe("Player 3");
  });

  it("never says You to a spectator", () => {
    // `viewerSeat: null` is watching. Nobody at the table is them.
    for (const seat of [0, 1, 2, 3] as SeatId[]) {
      expect(winnerLabel(runtimeWinning(seat), others(null), null)).toBe(`Player ${seat}`);
    }
  });

  it("still defaults to seat 0 offline, where the hero is seat 0", () => {
    // `undefined` means "no opinion" and must keep the old behaviour.
    expect(winnerLabel(runtimeWinning(0), others(0), undefined)).toBe("You");
    expect(winnerLabel(runtimeWinning(1), others(0), undefined)).toBe("Player 1");
  });
});

describe("the win/lose standings", () => {
  it("gives the viewer their own row, at their own seat", () => {
    const board = winLoseStandings(null, runtimeWinning(2), others(2), 2);
    const mine = board.find((row) => row.name === "You");
    expect(mine).toBeDefined();
    expect(mine!.seat, "the row must carry the viewer's real seat").toBe(2);
    expect(mine!.total, "and they won").toBe(1);
  });

  it("lists every seat exactly once", () => {
    const board = winLoseStandings(null, runtimeWinning(1), others(3), 3);
    expect(board).toHaveLength(4);
    expect(new Set(board.map((r) => r.seat)).size).toBe(4);
  });

  it("gives a spectator no row of their own", () => {
    const board = winLoseStandings(null, runtimeWinning(0), others(null), null);
    expect(board).toHaveLength(4);
    expect(board.some((r) => r.name === "You")).toBe(false);
  });
});
