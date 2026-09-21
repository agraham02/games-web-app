// @vitest-environment jsdom

/**
 * `learnMeta`, which exists for one situation and is easy to get wrong.
 *
 * `PieceLayer` draws nothing for a piece it cannot describe. That is
 * deliberate, and it has bitten twice: once when frames carried meta for
 * stand-ins only and a player's own hand went missing, and once when an
 * opponent's play arrived as an `unmask` for a piece whose description
 * did not reach the store until the batch settled — after the move it was
 * supposed to give an origin to. The card materialised on the table
 * instead of leaving a hand.
 *
 * So a frame teaches the store what it may now name BEFORE its events
 * play. Two properties matter: what is already known wins, and the map's
 * identity only changes when something was genuinely learned — every
 * `<Piece>` subscribes to it, so a fresh object per frame would re-render
 * the whole table for nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useTableStore } from "./store";

describe("learnMeta", () => {
  beforeEach(() => {
    useTableStore.getState().reset({}, {});
  });

  it("teaches the store a piece it could not previously describe", () => {
    useTableStore.getState().learnMeta({ "H-7": { kind: "card", face: "H-7" } });
    expect(useTableStore.getState().meta["H-7"]).toEqual({ kind: "card", face: "H-7" });
  });

  it("touches no placement", () => {
    useTableStore
      .getState()
      .reset({ "S-A": { zone: "hand", seat: 0, index: 0, count: 1, faceUp: true } }, {});
    const before = useTableStore.getState().placements;
    useTableStore.getState().learnMeta({ "H-7": { kind: "card", face: "H-7" } });
    expect(useTableStore.getState().placements).toBe(before);
  });

  it("keeps what it already knew", () => {
    useTableStore.getState().reset({}, { "S-A": { kind: "card", face: "S-A" } });
    useTableStore.getState().learnMeta({ "S-A": { kind: "card", face: "WRONG" } });
    expect(useTableStore.getState().meta["S-A"]!.face).toBe("S-A");
  });

  it("only changes identity when something was actually learned", () => {
    useTableStore.getState().reset({}, { "S-A": { kind: "card", face: "S-A" } });
    const before = useTableStore.getState().meta;

    useTableStore.getState().learnMeta({ "S-A": { kind: "card", face: "S-A" } });
    expect(useTableStore.getState().meta, "nothing new — the map must not churn").toBe(before);

    useTableStore.getState().learnMeta({ "D-2": { kind: "card", face: "D-2" } });
    expect(useTableStore.getState().meta).not.toBe(before);
  });
});
