/**
 * How much of the screen each game's table actually uses, by what — and how
 * big each game's board is drawn next to the hand.
 *
 *   npm run measure                    # two markdown tables
 *   npm run measure -- --json out.json # the same numbers, for diffing
 *
 * The measuring lives in src/table/measure.ts, shared with the layout tests
 * that hold every game to the targets in docs/table-layout-rethink.md. Rerun
 * it on any layout change: `board` and `board ÷ hand` up, `anything` up,
 * nothing overlapping.
 */

import { writeFileSync } from "node:fs";
import type { Box } from "@/table/geometry";
import {
  MEASURE_SCENARIOS,
  MEASURE_VIEWPORTS,
  measureTable,
  playScenario,
  type Measurement,
} from "@/table/measure";

const size = (b: Box | undefined) =>
  b ? `${Math.round(Math.max(b.w, b.h))}×${Math.round(Math.min(b.w, b.h))}` : "–";
const box = (b: Box) => `${Math.round(b.w)}×${Math.round(b.h)}`;

const coverage: string[] = [
  "| Game | Screen | Board | Hand | Opponents | Pods | Band | Anything |",
  "|---|---|---|---|---|---|---|---|",
];
const sizes: string[] = [
  "| Game | Screen | Density | Play box | Board piece | Hand piece | Board ÷ hand | Domino unit (opening / mid / hand tile) |",
  "|---|---|---|---|---|---|---|---|",
];
const json: Record<string, Record<string, Omit<Measurement, "geometry">>> = {};

for (const scenario of MEASURE_SCENARIOS) {
  const played = playScenario(scenario);
  json[scenario.id] = {};
  for (const vp of MEASURE_VIEWPORTS) {
    const m = measureTable(scenario, vp, played);
    const pct = (c: keyof Measurement["coverage"]) => `${m.coverage[c]}%`;
    coverage.push(
      `| ${scenario.id} | ${vp.name} | ${pct("board")} | ${pct("hand")} | ${pct("opponents")} | ${pct("pods")} | ${pct("band")} | **${m.anything}%** |`,
    );
    const board = m.domino ? `${Math.round(m.domino.unit * 2)}×${Math.round(m.domino.unit)}` : size(m.primary);
    const domino = m.domino
      ? `${m.domino.opening.toFixed(1)} / ${m.domino.unit.toFixed(1)} / ${m.domino.handTile.toFixed(1)} (line ${box(m.domino.line)})`
      : "";
    sizes.push(
      `| ${scenario.id} | ${vp.name} | ${m.geometry.density} | ${box(m.geometry.zones.play)} | ${board} | ${size(m.handPiece)} | ${m.ratio === undefined ? "–" : m.ratio.toFixed(2)} | ${domino} |`,
    );
    const { geometry: _geometry, ...numbers } = m;
    json[scenario.id]![vp.name] = numbers;
  }
}

console.log("Coverage — percent of the screen each thing covers (overlaps counted once in Anything)\n");
console.log(coverage.join("\n"));
console.log("\nSizes — how big the board is drawn next to the hand\n");
console.log(sizes.join("\n"));

const at = process.argv.indexOf("--json");
if (at >= 0 && process.argv[at + 1]) {
  writeFileSync(process.argv[at + 1]!, JSON.stringify(json, null, 2));
  console.log(`\nWrote ${process.argv[at + 1]}`);
}
