import { describe, expect, it } from "vitest";
import { MEASURE_SCENARIOS, MEASURE_VIEWPORTS, measureTable, playScenario } from "./measure";

/**
 * The board's size, held to the targets in docs/table-layout-rethink.md.
 *
 * Every other layout test asks whether things COLLIDE. None of them could
 * see the problem this exists for: a board drawn at half the size of the
 * hand, with most of a phone's screen showing nothing, collides with
 * nothing at all. So this asks how BIG the board is — through the same
 * code `npm run measure` prints, played to the same seeded mid-round.
 *
 * Baselines (2026-09-27, before the board-first layout): on a 390×844
 * phone every card game's board piece was 0.75 of a hand card or less
 * (poker's flop 0.38), Dominoes' camera ran at 22.4px a unit mid-round with
 * its opening tile capped at 33.5, and on an 844×390 landscape phone at
 * 8.2px a unit.
 */
describe("the board — at least as big as the targets say", () => {
  const played = new Map(MEASURE_SCENARIOS.map((s) => [s.id, playScenario(s)]));
  const at = (id: string, vp: string) => {
    const scenario = MEASURE_SCENARIOS.find((s) => s.id === id)!;
    const viewport = MEASURE_VIEWPORTS.find((v) => v.name === vp)!;
    return measureTable(scenario, viewport, played.get(scenario.id)!);
  };
  const PORTRAIT = ["phone 360x780", "phone 390x844", "phone 430x932"];

  it("draws every card game's board close to hand size on a phone held upright", () => {
    for (const id of ["spades", "rummy", "poker", "bs"]) {
      for (const vp of PORTRAIT) {
        expect(at(id, vp).ratio, `${id} on ${vp}`).toBeGreaterThanOrEqual(0.85);
      }
    }
  });

  it("draws the opening domino at hand size, and a mid-round chain far larger than it was", () => {
    for (const vp of PORTRAIT) {
      const d = at("dominoes", vp).domino!;
      expect(d.opening, vp).toBeCloseTo(d.handTile, 6);
    }
    expect(at("dominoes", "phone 390x844").domino!.unit).toBeGreaterThanOrEqual(22.4 * 1.25);
  });

  it("at least doubles the domino chain on a landscape phone", () => {
    expect(at("dominoes", "landscape 844x390").domino!.unit).toBeGreaterThanOrEqual(8.2 * 2);
  });

  it("never draws a board piece bigger than the base box every piece renders at", () => {
    // Past it a `will-change: transform` piece is an upscaled bitmap. On a
    // phone the base box is the hand's card; on a laptop it is bigger, and
    // the board may outgrow the hand (the user, 2026-09-28).
    for (const s of MEASURE_SCENARIOS) {
      for (const vp of MEASURE_VIEWPORTS) {
        const m = at(s.id, vp.name);
        const box = m.geometry.pieceBox;
        if (m.primary) {
          expect(Math.max(m.primary.w, m.primary.h), `${s.id} on ${vp.name}`).toBeLessThanOrEqual(
            Math.max(box.w, box.h) + 0.01,
          );
        }
        if (m.domino) {
          expect(m.domino.unit, `${s.id} on ${vp.name}`).toBeLessThanOrEqual(Math.min(box.w, box.h / 2) + 1e-6);
        }
      }
    }
  });
});
