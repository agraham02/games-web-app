/**
 * How much of the screen each game's table actually uses, by what.
 *
 *   npm run measure
 *
 * Plays each game a little way in with its own bots (seeded, so the numbers
 * repeat), lays every piece out through the real geometry and layout at a
 * phone, a landscape phone and a desktop, and rasterises what lands where:
 * the board, the viewer's hand, opponents' hands and piles, pods, and the
 * band above the hand. `anything` is the share of the screen that shows
 * something at all; the rest is felt.
 *
 * Written for docs/table-layout-rethink.md (2026-09-27), which argues the
 * board is drawn too small for the room it has. Rerun it on a proposal to
 * see whether it moved the numbers that matter: `board` up, `anything` up,
 * nothing overlapping. It measures the layout the code WOULD draw; chrome
 * the geometry does not know about (buttons in the band, badges) is not in
 * it, and neither is the Rummy board sheet.
 */

import { createRng } from "@/engine/rng";
import type { PieceKind, Placement, PlacementMap } from "@/engine/types";
import { GAMES, type GameId } from "@/session/registry";
import {
  cellHalfExtent,
  handHeaderHeight,
  podBox,
  resolveTable,
  type BoardView,
  type Box,
  type TableGeometry,
} from "@/table/geometry";
import { artSize, baseSize, boardCamera, layoutPiece } from "@/table/layout";

interface Scenario {
  id: GameId;
  seats: number;
  /** Bot turns to play before measuring — roughly mid-round. */
  turns: number;
  /** What the band above the hand holds on this game, beyond its row. */
  panel: (width: number) => number;
  /** What the game's page passes `GameHost`, where it differs. */
  handZone?: number;
  bottomZone?: number;
  /** Stop early once the table shows what is worth measuring. */
  ready?: (placements: PlacementMap) => boolean;
}

const SCENARIOS: Scenario[] = [
  { id: "dominoes", seats: 4, turns: 14, panel: () => 0 },
  { id: "spades", seats: 4, turns: 26, panel: () => 0 },
  // The board sheet's resting strip (`SHEET_PEEK_H`).
  { id: "rummy", seats: 4, turns: 30, panel: () => 0, bottomZone: 140 },
  {
    id: "poker",
    seats: 6,
    turns: 400,
    // The laptop's betting bar, or a phone's folded panel sizing open.
    panel: (w) => (w >= 1024 ? 80 : 150),
    ready: (p) => Object.values(p).filter((q) => q.zone === "community").length >= 4,
  },
  // No hand: just the Roll bar's strip (`LRC_HAND_ZONE`).
  { id: "lrc", seats: 5, turns: 10, panel: () => 0, handZone: 64 },
  { id: "bs", seats: 4, turns: 30, panel: () => 0 },
];

const VIEWPORTS = [
  { name: "phone 390x844", w: 390, h: 844 },
  { name: "phone landscape 844x390", w: 844, h: 390 },
  { name: "desktop 1440x900", w: 1440, h: 900 },
];

type Category = "board" | "hand" | "opponents" | "pods" | "band";

/** The subset of a definition this script drives, whatever the game. */
interface Driven {
  setup: (o: { seats: number; rng: unknown; difficulty: string[] }) => unknown;
  startRound?: (s: unknown, rng: unknown) => { state: unknown };
  currentSeat: (s: unknown) => number | null;
  isRoundOver?: (s: unknown) => boolean;
  playerView: (s: unknown, seat: number) => unknown;
  bots: Record<string, { choose: (view: unknown, seat: number, rng: unknown) => unknown }>;
  completeAction?: (s: unknown, a: unknown, seat: number, rng: unknown) => unknown;
  reduce: (s: unknown, a: unknown) => { state: unknown };
  placements: (s: unknown, seat: number) => PlacementMap;
  pieces: (s: unknown) => Record<string, { kind: PieceKind }>;
}

function play(scenario: Scenario): { placements: PlacementMap; kinds: Record<string, PieceKind> } {
  const entry = GAMES[scenario.id];
  const def = entry.create(entry.parse({})) as unknown as Driven;
  const rng = createRng(1234);
  let state = def.setup({ seats: scenario.seats, rng, difficulty: Array(scenario.seats).fill("steady") });
  if (def.startRound) state = def.startRound(state, rng).state;

  for (let turn = 0, guard = 0; turn < scenario.turns && guard < 5000; guard++) {
    if (scenario.ready?.(def.placements(state, 0))) break;
    const seat = def.currentSeat(state);
    if (seat === null || def.isRoundOver?.(state)) {
      // Poker's hands often end before a flop; deal the next one.
      if (scenario.ready && def.startRound) {
        state = def.startRound(state, rng).state;
        continue;
      }
      break;
    }
    const action = def.bots.steady!.choose(def.playerView(state, seat), seat, rng);
    const done = def.completeAction ? def.completeAction(state, action, seat, rng) : action;
    state = def.reduce(state, done).state;
    turn++;
  }

  const kinds = Object.fromEntries(Object.entries(def.pieces(state)).map(([id, m]) => [id, m.kind]));
  return { placements: def.placements(state, 0), kinds };
}

function boardOf(placements: PlacementMap): BoardView | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of Object.values(placements)) {
    if (!p.cell) continue;
    const { hw, hh } = cellHalfExtent(p.cell.rot);
    minX = Math.min(minX, p.cell.x - hw);
    minY = Math.min(minY, p.cell.y - hh);
    maxX = Math.max(maxX, p.cell.x + hw);
    maxY = Math.max(maxY, p.cell.y + hh);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** A piece's drawn box on screen: its art, scaled, turned. */
function drawnBox(g: TableGeometry, p: Placement, kind: PieceKind, board: BoardView | null): Box {
  const t = layoutPiece(p, g, { kind, board });
  const base = baseSize(g);
  const art = artSize(g, kind);
  const w = art.w * t.scale;
  const h = art.h * t.scale;
  const cx = t.x + base.w / 2;
  const cy = t.y + base.h / 2;
  const turned = Math.round((((t.rotate % 180) + 180) % 180) / 90) === 1;
  const [bw, bh] = turned ? [h, w] : [w, h];
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}

function categoryOf(p: Placement, kind: PieceKind): Category {
  if (p.zone === "hand") return p.seat === 0 ? "hand" : "opponents";
  // Dominoes' boneyard lives in the hand strip, beside the Draw button.
  if (p.zone === "boneyard" && kind === "tile") return "hand";
  // A seat's won tricks or chips sit by its pod.
  if (p.zone === "collected") return p.seat === 0 ? "hand" : "opponents";
  return "board";
}

/** Coverage on a 2px grid, so overlapping pieces are not counted twice. */
class Raster {
  private static readonly CELL = 2;
  private readonly cols: number;
  private readonly cells: Uint8Array;

  constructor(
    private readonly w: number,
    private readonly h: number,
  ) {
    this.cols = Math.ceil(w / Raster.CELL);
    this.cells = new Uint8Array(this.cols * Math.ceil(h / Raster.CELL));
  }

  add(b: Box): void {
    const c = Raster.CELL;
    const x0 = Math.max(0, Math.floor(b.x / c));
    const x1 = Math.min(this.cols, Math.ceil((b.x + b.w) / c));
    const y0 = Math.max(0, Math.floor(b.y / c));
    const y1 = Math.min(Math.ceil(this.h / c), Math.ceil((b.y + b.h) / c));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.cells[y * this.cols + x] = 1;
  }

  /** Share of the screen covered, in percent. */
  percent(): number {
    let n = 0;
    for (const v of this.cells) n += v;
    return Math.round((1000 * n * Raster.CELL * Raster.CELL) / (this.w * this.h)) / 10;
  }
}

const size = (b: Box | undefined) => (b ? `${Math.round(Math.max(b.w, b.h))}×${Math.round(Math.min(b.w, b.h))}` : "–");

const rows: string[] = [
  "| Game | Screen | Board | Hand | Opponents | Pods | Band | Anything | Largest board piece | Hand piece | Opponent piece |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
];

for (const scenario of SCENARIOS) {
  const { placements, kinds } = play(scenario);
  const board = boardOf(placements);
  for (const vp of VIEWPORTS) {
    const g = resolveTable({
      seats: scenario.seats,
      width: vp.w,
      height: vp.h,
      bandZone: handHeaderHeight(vp.h) + scenario.panel(vp.w),
      handZone: scenario.handZone,
      bottomZone: scenario.bottomZone,
    });
    const layers = Object.fromEntries(
      (["board", "hand", "opponents", "pods", "band"] as Category[]).map((c) => [c, new Raster(vp.w, vp.h)]),
    ) as Record<Category, Raster>;
    const anything = new Raster(vp.w, vp.h);
    const sample: Partial<Record<Category, Box>> = {};

    for (const [id, p] of Object.entries(placements)) {
      const kind = kinds[id] ?? "card";
      const box = drawnBox(g, p, kind, board);
      const category = categoryOf(p, kind);
      layers[category].add(box);
      anything.add(box);
      const seen = sample[category];
      if (!seen || box.w * box.h > seen.w * seen.h) sample[category] = box;
    }
    for (const slot of g.seats) {
      if (slot.isHero) continue;
      const pod = podBox(slot, g.density);
      layers.pods.add(pod);
      anything.add(pod);
    }
    layers.band.add(g.band);
    anything.add(g.band);

    const pct = (c: Category) => `${layers[c].percent()}%`;
    rows.push(
      `| ${scenario.id} | ${vp.name} | ${pct("board")} | ${pct("hand")} | ${pct("opponents")} | ${pct("pods")} | ${pct("band")} | **${anything.percent()}%** | ${size(sample.board)} | ${size(sample.hand)} | ${size(sample.opponents)} |`,
    );

    if (scenario.id === "dominoes") {
      const cam = boardCamera(g, board);
      rows.push(
        `| | | camera unit ${cam.unit.toFixed(1)}px (cap ${(g.card.w < g.card.h / 2 ? g.card.w : g.card.h / 2).toFixed(1)}), line zone ${Math.round(g.zones.line.w)}×${Math.round(g.zones.line.h)} | | | | | | | | |`,
      );
    }
  }
}

console.log(rows.join("\n"));
