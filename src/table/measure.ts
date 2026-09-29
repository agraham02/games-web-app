/**
 * How much of the screen each game's table uses, by what — and how big the
 * board is drawn next to the hand.
 *
 * Shared by `npm run measure` (scripts/measure-table.ts), which prints it,
 * and by the layout tests, which hold every game to the targets in
 * docs/table-layout-rethink.md. One copy, so the numbers a test asserts are
 * the numbers the doc reports.
 *
 * Plays each game a little way in with its own bots (seeded, so the numbers
 * repeat), lays every piece out through the real geometry and layout, and
 * rasterises what lands where. It sees what the geometry knows about: pieces,
 * pods and the band's reserved box. Chrome drawn outside it (buttons inside
 * the band, badges, Rummy's board sheet) is not in it.
 */

import { createRng } from "@/engine/rng";
import type { PieceKind, Placement, PlacementMap } from "@/engine/types";
import { GAMES, type GameId } from "@/session/registry";
import {
  cellHalfExtent,
  handHeaderHeight,
  podBox,
  resolveTable,
  tileShortSide,
  type BoardView,
  type Box,
  type TableGeometry,
} from "./geometry";
import { artSize, baseSize, boardCamera, layoutPiece } from "./layout";

export interface MeasureViewport {
  name: string;
  w: number;
  h: number;
}

/**
 * The screens every game is measured on. Three portrait phones (small,
 * common, large), two landscape phones, a tablet and a desktop.
 */
export const MEASURE_VIEWPORTS: readonly MeasureViewport[] = [
  { name: "phone 360x780", w: 360, h: 780 },
  { name: "phone 390x844", w: 390, h: 844 },
  { name: "phone 430x932", w: 430, h: 932 },
  { name: "landscape 844x390", w: 844, h: 390 },
  { name: "landscape 932x430", w: 932, h: 430 },
  { name: "tablet 768x1024", w: 768, h: 1024 },
  { name: "laptop 1280x800", w: 1280, h: 800 },
  { name: "desktop 1440x900", w: 1440, h: 900 },
];

export interface MeasureScenario {
  id: GameId;
  seats: number;
  /** Bot turns to play before measuring — roughly mid-round. */
  turns: number;
  /** What the game's page passes `GameHost`, where it differs. */
  handZone?: number;
  /** Poker's `usePokerPanelReserve`: its betting panel's room, reserved always. */
  panelReserve?: (width: number, height: number) => number;
  bottomZone?: number;
  /** Stop early once the table shows what is worth measuring. */
  ready?: (placements: PlacementMap) => boolean;
  /**
   * The piece that IS this game's board, as a synthetic placement: the size
   * a trick card, a flop card or a revealed card is drawn at, whether or not
   * the seeded position happens to have one on the table right now.
   * Dominoes has none — its board is measured through the camera instead.
   */
  primary?: { placement: Placement; kind: PieceKind };
  /** The viewer's hand, the same way: the size a hand piece is drawn at. */
  hand?: { placement: Placement; kind: PieceKind };
}

const card = (zone: Placement["zone"], extra: Partial<Placement> = {}): Placement => ({
  zone,
  index: 0,
  count: 1,
  faceUp: true,
  ...extra,
});

export const MEASURE_SCENARIOS: readonly MeasureScenario[] = [
  {
    id: "dominoes",
    seats: 4,
    turns: 14,
    hand: { placement: card("hand", { seat: 0, count: 7 }), kind: "tile" },
  },
  {
    id: "spades",
    seats: 4,
    turns: 26,
    primary: { placement: card("trick", { seat: 1, count: 4 }), kind: "card" },
    hand: { placement: card("hand", { seat: 0, count: 13 }), kind: "card" },
  },
  // The board sheet's resting strip (`SHEET_PEEK_H`).
  {
    id: "rummy",
    seats: 4,
    turns: 30,
    bottomZone: 140,
    primary: { placement: card("deck"), kind: "card" },
    hand: { placement: card("hand", { seat: 0, count: 10 }), kind: "card" },
  },
  {
    id: "poker",
    seats: 6,
    turns: 400,
    panelReserve: (w, h) => (w >= 1024 ? 104 : h < 560 && w >= 640 ? 84 : 114),
    ready: (p) => Object.values(p).filter((q) => q.zone === "community").length >= 4,
    primary: { placement: card("community", { count: 5 }), kind: "card" },
    hand: { placement: card("hand", { seat: 0, count: 2 }), kind: "card" },
  },
  // No hand: just the Roll bar's strip (`LRC_HAND_ZONE`).
  {
    id: "lrc",
    seats: 5,
    turns: 10,
    handZone: 16,
    primary: { placement: card("center"), kind: "chip" },
  },
  {
    id: "bs",
    seats: 4,
    turns: 30,
    primary: { placement: card("reveal", { count: 4 }), kind: "card" },
    hand: { placement: card("hand", { seat: 0, count: 13 }), kind: "card" },
  },
];

/** The subset of a definition this drives, whatever the game. */
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

export interface PlayedTable {
  placements: PlacementMap;
  kinds: Record<string, PieceKind>;
}

/** Plays `scenario` to roughly mid-round with seeded bots. */
export function playScenario(scenario: MeasureScenario): PlayedTable {
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

/** The table a scenario's page would ask for on this screen. */
export function resolveScenario(scenario: MeasureScenario, vp: { w: number; h: number }): TableGeometry {
  return resolveTable({
    seats: scenario.seats,
    width: vp.w,
    height: vp.h,
    // The band's one row: a decision panel is drawn over the felt, never
    // reserved (TableSurface).
    bandZone: handHeaderHeight(vp.h) + (scenario.panelReserve?.(vp.w, vp.h) ?? 0),
    handZone: scenario.handZone,
    bottomZone: scenario.bottomZone,
    // As GameHost decides it: a card hand may bleed, a tile hand may not.
    handBleed: scenario.hand?.kind === "card",
  });
}

export function boardOf(placements: PlacementMap): BoardView | null {
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

/** The extent of one double laid alone — the opening tile of a round. */
export const OPENING_BOARD: BoardView = { minX: -0.5, minY: -1, maxX: 0.5, maxY: 1 };

/** A piece's drawn box on screen: its art, scaled, turned. */
export function drawnBox(
  g: TableGeometry,
  p: Placement,
  kind: PieceKind,
  board: BoardView | null = null,
): Box {
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

export type Category = "board" | "hand" | "opponents" | "pods" | "band";
export const CATEGORIES: readonly Category[] = ["board", "hand", "opponents", "pods", "band"];

function categoryOf(p: Placement, kind: PieceKind, viewer: number): Category {
  if (p.zone === "hand") return p.seat === viewer ? "hand" : "opponents";
  // Dominoes' boneyard lives in the hand strip, beside the Draw button.
  if (p.zone === "boneyard" && kind === "tile") return "hand";
  // A seat's won tricks or chips sit by its pod.
  if (p.zone === "collected") return p.seat === viewer ? "hand" : "opponents";
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

export interface Measurement {
  geometry: TableGeometry;
  /** Percent of the screen each category covers. */
  coverage: Record<Category, number>;
  /** Percent of the screen that shows anything at all. */
  anything: number;
  /** The biggest piece drawn in each category, as played. */
  largest: Partial<Record<Category, Box>>;
  /** The game's own board piece, drawn at its zone's size (see `primary`). */
  primary?: Box;
  /** A piece of the viewer's hand, drawn at its zone's size. */
  handPiece?: Box;
  /**
   * `primary`'s long side over `handPiece`'s: 1 means the board is drawn as
   * big as the hand, 0.5 half as big. Dominoes compares its camera's tile.
   */
  ratio?: number;
  /** Dominoes only: the camera, mid-round and for the opening tile. */
  domino?: { unit: number; opening: number; handTile: number; line: Box };
}

const long = (b: Box) => Math.max(b.w, b.h);

export function measureTable(
  scenario: MeasureScenario,
  vp: MeasureViewport,
  played: PlayedTable,
): Measurement {
  const g = resolveScenario(scenario, vp);
  const board = boardOf(played.placements);
  const layers = Object.fromEntries(CATEGORIES.map((c) => [c, new Raster(vp.w, vp.h)])) as Record<
    Category,
    Raster
  >;
  const all = new Raster(vp.w, vp.h);
  const largest: Partial<Record<Category, Box>> = {};

  for (const [id, p] of Object.entries(played.placements)) {
    const kind = played.kinds[id] ?? "card";
    const box = drawnBox(g, p, kind, board);
    const category = categoryOf(p, kind, 0);
    layers[category].add(box);
    all.add(box);
    const seen = largest[category];
    if (!seen || box.w * box.h > seen.w * seen.h) largest[category] = box;
  }
  for (const slot of g.seats) {
    if (slot.isHero) continue;
    const pod = podBox(slot, g.density);
    layers.pods.add(pod);
    all.add(pod);
  }
  layers.band.add(g.band);
  all.add(g.band);

  const coverage = Object.fromEntries(CATEGORIES.map((c) => [c, layers[c].percent()])) as Record<
    Category,
    number
  >;
  const handPiece = scenario.hand ? drawnBox(g, scenario.hand.placement, scenario.hand.kind) : undefined;
  const primary = scenario.primary ? drawnBox(g, scenario.primary.placement, scenario.primary.kind) : undefined;

  let domino: Measurement["domino"];
  let ratio: number | undefined;
  if (scenario.id === "dominoes") {
    const handTile = tileShortSide(g.handCard);
    domino = {
      unit: boardCamera(g, board).unit,
      opening: boardCamera(g, OPENING_BOARD).unit,
      handTile,
      line: g.zones.line,
    };
    ratio = domino.unit / handTile;
  } else if (primary && handPiece) {
    ratio = long(primary) / long(handPiece);
  }

  return { geometry: g, coverage, anything: all.percent(), largest, primary, handPiece, ratio, domino };
}
