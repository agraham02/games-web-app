/**
 * Placement -> screen transform.
 *
 * The one rule this file exists to enforce: **a piece is always rendered
 * at one fixed base size, and every visual difference is a transform.**
 *
 * A card in the hero's hand and the same card in a trick are different
 * sizes on screen, but animating width/height between them would hit
 * layout on every frame. Instead the DOM box never changes and `scale`
 * does the work, so the whole table animates on the compositor.
 *
 * Pure and O(1) per piece: layout never inspects sibling pieces, which
 * is what lets each <Piece> subscribe to only its own placement.
 */

import type { Placement, PieceKind, SeatId } from "@/engine/types";
import { HERO } from "@/engine/types";
import {
  axisReach,
  fanSlot,
  heroFan,
  pileAssembly,
  pileAssemblyHorizontal,
  pileCard,
  potChip,
  radialFanSlot,
  slotForSeat,
  tileShortSide,
  podBox,
  topHandDrop,
  HAND_FAN_BOW,
  HAND_FAN_TILT,
  TOP_HAND_LEAN,
  HAND_LIFT_ROOM,
  MAX_DISCARD_STEP_FRACTION,
  MIN_HAND_GAP_FRACTION,
  POD_SIZE,
  TILE_HAND_GAP,
  type BoardView,
  type Box,
  type PieceSize,
  type SeatSlot,
  type TableGeometry,
  type ZoneName,
} from "./geometry";

type BoardCell = NonNullable<Placement["cell"]>;

export interface PieceTransform {
  /** Top-left of the base-size box, in container px. */
  x: number;
  y: number;
  rotate: number;
  scale: number;
  z: number;
  opacity: number;
}

/**
 * Stacking order per zone. Selection lifts a piece above everything.
 *
 * `collected`, `hand` (opponent) and `center` all sit at z >= 850,
 * ABOVE SeatRing's z-800: every one of them is positioned "near a pod"
 * or "near table centre" by design, and a piece that loses a
 * z-index fight with a nameplate reads as broken — a real bug in LRC's
 * chip piles, which sit right outside each pod and were rendering
 * partly hidden behind it before this ordering was fixed.
 */
const Z: Record<string, number> = {
  offscreen: 0,
  deck: 100,
  boneyard: 150,
  board: 200,
  line: 250,
  discard: 300,
  trick: 400,
  collected: 850,
  hand: 900,
  community: 940,
  pot: 945,
  center: 950,
  stub: 120,
  burnt: 320,
  // BS's pile sits where a discard would; `reveal` must clear it, because
  // a challenged play reaches the row by flying off the top of the stack
  // and has to be above it the whole way.
  pile: 300,
  reveal: 420,
};
const Z_HERO_HAND = 1000;
const Z_SELECTED = 5000;
/**
 * A tucked hand draws BEHIND its pod (SeatRing is z-800 and the piece layer
 * makes no stacking context of its own, so the two compete directly), and a
 * face-down won pile behind that. A shown hand — face up, at a showdown —
 * draws over the pod, where it can be read.
 */
const Z_TUCKED = 700;
const Z_TUCKED_WON = 600;
const Z_SHOWN = 960;

/**
 * Where chip `index` of a `count`-chip pile sits on the felt beside its pod —
 * every seat's pile but a rim side seat's (`rimPileSpot`), the viewer's own
 * included.
 */
function groundPileSpot(g: TableGeometry, seat: SeatSlot, index: number, count: number, shift = 0, narrow = false) {
  // A real grid, not a stack: a 0.6px-per-card offset (the old
  // value) is imperceptible on a ~30px chip, so two or three chips
  // rendered as one indistinguishable blob — exactly the "why does
  // it look like I only have one chip" bug this replaces. Fanning
  // outward from the pod in rows of 3 keeps the count legible at a
  // glance, which is the entire point of a chip pile in LRC.
  const { cx: pcx, cy: pcy } = boxCentre(g.zones.play);
  // Where seats are a rim (phones), toward the board from the pod's own
  // EDGE (see `rimVectors`): two seats stack high down a side there, and
  // the line from the upper one to the board's centre runs straight down
  // through the pod below it — LRC dealt Sam's chips onto Mia's avatar.
  const rim = g.tuck ? rimVectors(seat.anchor).inward : null;
  const dx = rim ? -rim.x : seat.x - pcx;
  const dy = rim ? -rim.y : seat.y - pcy;
  const len = Math.hypot(dx, dy) || 1;
  // Every seat's pile points TOWARD table centre, never away from
  // it. An earlier version sent opponent piles outward, past the
  // pod, toward the nearest screen edge — reasoning that the space
  // out there was "empty." It isn't safe: a pod near an edge has
  // almost no room behind it, so the outward point regularly landed
  // off-screen and clampToBox dragged it straight back on top of
  // the pod it was trying to clear (the actual cause of chips
  // covering names/avatars/chip counts). Toward centre always has
  // room — the play area is large and, in LRC, otherwise empty — so
  // the clamp is a rare safety net again instead of the thing doing
  // the real positioning.
  const ux = -dx / len;
  const uy = -dy / len;
  // Perpendicular unit vector — spreads chips sideways to the pod
  // rather than radially, so a growing pile doesn't drift table-ward.
  const px = -uy;
  const py = ux;

  const chipSize = g.miniCard.w;
  // Two abreast on the rim (phones), like a side seat's pile above: three
  // under a top pod reached into the side pod beside it on a small phone.
  const cols = narrow ? 1 : g.tuck ? 2 : 3;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const colSpacing = chipSize * 0.85;
  const rowSpacing = chipSize * 0.9;
  // Clears the pod by its own real footprint along the push
  // direction (ux, uy) — the same `axisReach` helper this file's
  // opponent-hand placement already uses for exactly this question
  // ("how far past this pod does something reaching outward from it
  // need to start"), plus a little breathing room so the pile
  // visibly separates rather than grazing the pod's edge.
  //
  // Deliberately NOT derived from `len` (the seat's distance to
  // table centre) — an earlier version scaled clearance with `len`,
  // reasoning that on a wide table a TOP/BOTTOM seat's span to
  // centre is longer than a LEFT/RIGHT seat's. That's backwards: a
  // wide table's real horizontal room means LEFT/RIGHT seats are
  // the ones far from centre (large `len`), while a top seat, pinned
  // close to the short vertical edge, sits near it (small `len`).
  // Scaling by `len` therefore pushed LEFT/RIGHT piles further from
  // their own pod, toward centre — the seats nobody complained about
  // — while TOP/BOTTOM (the actual "too far from the pod" report)
  // stayed essentially at the old flat value, since its small `len`
  // rarely cleared that floor. The pod's own footprint has no such
  // backwards relationship: `POD_SIZE` is close to square at every
  // density, so every anchor clears by roughly the same amount
  // regardless of how far that seat happens to sit from centre.
  const pod = POD_SIZE[g.density];
  // The viewer's own pile has no pod to clear — it starts from the top
  // of the band above their hand (`TableGeometry.band`), which is where
  // their controls are. Measured from the seat like everybody else's,
  // it landed under the band: LRC's Roll button sat on the chips it
  // was about to roll for.
  const fromBand = seat.isHero && g.band.h > 0;
  const originY = fromBand ? g.band.y : seat.y;
  const clearance = fromBand ? g.miniCard.h * 0.55 : axisReach(ux, uy, pod) + g.miniCard.h * 0.55;

  const rowOriginX = seat.x + ux * (clearance + row * rowSpacing);
  const rowOriginY = originY + uy * (clearance + row * rowSpacing);
  // Centred on how many chips are actually IN this row, not on the
  // grid's max width. `cols` is a wrap limit, not every row's real
  // count — centring against it left every row short of a full 3
  // (which, for LRC's 3-chips-per-player start, is nearly all of
  // them) visibly shifted toward the pod-outward edge instead of
  // sitting under the pod. A 1-chip pile centred against a
  // 3-wide grid, for instance, always landed at that grid's
  // leftmost slot rather than its middle.
  const rowCount = Math.min(cols, count - row * cols);
  const colOffset = (col - (rowCount - 1) / 2) * colSpacing;

  // Margins are the piece's real scaled half-extents, not a rough
  // guess: the underlying box is card-shaped (taller than wide), so
  // a width-based margin used for BOTH axes undershoots vertically
  // by exactly enough to let a chip's top edge clip off-screen —
  // confirmed once already at exactly this gap (~2-3px) in
  // /play/lrc before this was axis-correct.
  const clamped = clampToBox(
    rowOriginX + px * (colOffset + shift),
    rowOriginY + py * (colOffset + shift),
    g.box,
    g.miniCard.w / 2,
    g.miniCard.h / 2,
  );
  return clamped;
}

/** A face-up pile beside a SIDE pod on the rim — LRC's chips on a phone. */
function isRimSidePile(g: TableGeometry, seat: SeatSlot): boolean {
  return g.tuck && !seat.isHero && (seat.anchor === "left" || seat.anchor === "right");
}

/**
 * Where chip `index` of a rim side pile sits: `cols` abreast from the pod's
 * edge, the rows stacking toward the board's middle, never starting above
 * the top seats' pods. At most two, not three or four: a wider pile beside
 * a corner seat ran into the top seat's own pile, and six chips in one row
 * said nothing about whose they were. Aimed at the board's centre instead,
 * a pile from a seat in the top corner ran up into the top seat's pod or
 * down into the pod stacked below it — `layout.test.ts` found both.
 */
function rimPileSpot(g: TableGeometry, seat: SeatSlot, index: number, shape: RimPileShape, shift = 0) {
  const pod = POD_SIZE[g.density];
  const d = g.miniCard.w;
  if (shape.kind === "hang") {
    // Two abreast, centred under the pod, rows running down its column.
    const col = index % 2;
    const row = Math.floor(index / 2);
    return clampToBox(
      seat.x + (col - 0.5) * d * 0.86,
      seat.y + pod.h / 2 + 4 + d / 2 + row * shape.step + shift,
      g.box,
      g.miniCard.w / 2,
      g.miniCard.h / 2,
    );
  }
  const step = d * 0.86;
  const cols = shape.cols;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const inward = seat.anchor === "left" ? 1 : -1;
  const topRim = Math.max(
    -Infinity,
    ...g.seats.filter((s) => s.anchor === "top").map((s) => s.y + pod.h / 2),
  );
  const toward = Math.sign(g.zones.play.y + g.zones.play.h / 2 - seat.y) || 1;
  const firstY = toward > 0 ? Math.max(seat.y, topRim + 4 + d / 2) : seat.y;
  // A tall pile stacks tighter rather than climbing into the top pods or
  // sinking under the band (a ninth chip on a landscape phone did).
  const rowY = Math.min(
    Math.max(firstY + toward * row * step, topRim + 4 + d / 2),
    g.band.y - 4 - d / 2,
  );
  return clampToBox(
    seat.x + inward * (pod.w / 2 + 6 + d / 2 + col * step),
    rowY + shift,
    g.box,
    g.miniCard.w / 2,
    g.miniCard.h / 2,
  );
}

/**
 * How a rim side pile is laid out. Beside its pod two abreast, as a rule.
 * With many seats a side seat sits level with the middle of the table, and
 * its pile's second column covered the left die (9 seats on a 390px phone);
 * on a 360px phone the dice fill the stage between the side pods, and even
 * one column did. Such a pile hangs in the seat's own column below its pod
 * instead, in the gap before the next pod down, which nothing else uses;
 * one chip wide beside the pod only where that gap is too short too.
 */
type RimPileShape = { kind: "beside"; cols: 1 | 2 } | { kind: "hang"; step: number };

/**
 * What a seat's pile must keep off: the dice, and the pot at the most it is
 * ever drawn loose — its full stack on a phone, two rows of five elsewhere.
 */
function centreKeepOut(g: TableGeometry): Box[] {
  const base = baseSize(g);
  const most = g.profile === "roomy" ? POT_GRID_MAX : CHIP_STACK_LIFT_MAX + 1;
  const pot: Box[] = [];
  for (let index = 0; index < most; index++) {
    const t = layoutPiece({ zone: "center", index, count: most, faceUp: true }, g, { kind: "chip" });
    const d = t.scale * base.w;
    pot.push({ x: t.x + base.w / 2 - d / 2, y: t.y + base.h / 2 - d / 2, w: d, h: d });
  }
  return [g.zones.dice, ...pot];
}

/**
 * How many of a pile's three rows keep off the dice and the pot. The pile
 * shows that many rows of chips one by one, and stacks past them.
 */
function rowsClear(g: TableGeometry, cols: number, spot: (index: number) => { cx: number; cy: number }): number {
  const d = g.miniCard.w;
  const keep = centreKeepOut(g);
  const hits = (at: { cx: number; cy: number }) =>
    keep.some(
      (k) =>
        at.cx + d / 2 + 4 > k.x &&
        at.cx - d / 2 - 4 < k.x + k.w &&
        at.cy + d / 2 + 4 > k.y &&
        at.cy - d / 2 - 4 < k.y + k.h,
    );
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < cols; col++) if (hits(spot(row * cols + col))) return row;
  }
  return 3;
}

/**
 * A seat's pile, decided once per table: its shape if it is a rim side
 * pile, and how many chips it shows before it becomes a stack. From the
 * viewport alone, never today's count, so a pile never changes shape as
 * chips come and go.
 */
interface PilePlan {
  shape: RimPileShape | null;
  cap: number;
  /** How far the whole pile slid along its row (or a rim side pile's column) to keep off another seat. */
  shift: number;
  /** One chip wide, where two or three abreast left a neighbour no room. */
  narrow?: boolean;
}

const pilePlans = new WeakMap<TableGeometry, Map<SeatId, PilePlan>>();

function pilePlan(g: TableGeometry, seat: SeatSlot): PilePlan {
  let plans = pilePlans.get(g);
  if (!plans) pilePlans.set(g, (plans = planPiles(g)));
  return plans.get(seat.seat) ?? { ...planPile(g, seat), shift: 0 };
}

/** Where chip `index` of a seat's pile goes, as planned. */
function pileSpot(
  g: TableGeometry,
  seat: SeatSlot,
  index: number,
  count: number,
  plan: Pick<PilePlan, "shape" | "shift" | "narrow">,
) {
  return isRimSidePile(g, seat)
    ? rimPileSpot(g, seat, index, plan.shape!, plan.shift)
    : groundPileSpot(g, seat, index, count, plan.shift, plan.narrow);
}

/**
 * Every seat's pile at once, so that none lands on another's (the user,
 * 2026-10-31: no overlaps, LRC included). Seat by seat - the viewer's, then
 * the side seats', then the top seats' - each pile keeps off every pod, the
 * dice and pot, and the piles already placed: where its first chip would not,
 * it slides a little along its row; past the last chip that keeps clear, it
 * becomes a stack. In a phone's top corner the side seat's pile and the
 * top seat's used to share the same few pixels.
 */
function planPiles(g: TableGeometry): Map<SeatId, PilePlan> {
  // Narrower piles only where they leave fewer piles unplaced: first the
  // side seats' piles one chip wide, then the top seats' too. A pile that
  // cannot be placed at any width (a top seat over the dice on a landscape
  // phone) is no reason to narrow everybody else's.
  let best: { plans: Map<SeatId, PilePlan>; unplaced: number } | null = null;
  for (const narrow of [0, 1, 2] as const) {
    const tried = tryPiles(g, narrow);
    if (!best || tried.unplaced < best.unplaced) best = tried;
    if (tried.unplaced === 0) break;
  }
  // Every opponent's pile stacks at the same count, so the table reads
  // alike: some seats' chips loose and others' a numbered stack looked
  // like two different states (the user, 2026-10-31, of hands; the same
  // holds for chips). The tightest seat sets it. The viewer's own is apart.
  const plans = best!.plans;
  const opponents = g.seats.filter((s) => !s.isHero).map((s) => plans.get(s.seat)!);
  const cap = Math.min(...opponents.map((plan) => plan.cap));
  for (const plan of opponents) plan.cap = cap;
  return plans;
}

function tryPiles(g: TableGeometry, narrow: 0 | 1 | 2): { plans: Map<SeatId, PilePlan>; unplaced: number } {
  const plans = new Map<SeatId, PilePlan>();
  let unplaced = 0;
  const d = g.miniCard.w;
  const disc = (at: { cx: number; cy: number }, pad = 0): Box => ({
    x: at.cx - d / 2 - pad,
    y: at.cy - d / 2 - pad,
    w: d + 2 * pad,
    h: d + 2 * pad,
  });
  const meets = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const keep = centreKeepOut(g);
  // How far a stack reaches from its pile's first spot (see `layoutPiece`).
  const stackHeight = d * CHIP_STACK_STEP * CHIP_STACK_LIFT_MAX;
  const placed: Box[] = [];
  const rank = (s: SeatSlot) => (s.isHero ? 0 : s.anchor === "left" || s.anchor === "right" ? 1 : 2);
  // Nearest the middle of the board first, so where two piles want the same
  // stretch it is the seat further out whose pile stacks: a side pile grows
  // toward the middle, and placed first, the upper of two side seats ran its
  // column down through the lower one's.
  const { cx: midX, cy: midY } = boxCentre(g.zones.play);
  const off = (s: SeatSlot) => Math.hypot(s.x - midX, s.y - midY);
  const order = [...g.seats].sort((a, b) => rank(a) - rank(b) || off(a) - off(b) || a.seat - b.seat);
  const pieces = order.map((seat) => {
    const planned = planPile(g, seat);
    const side = isRimSidePile(g, seat);
    const base = {
      ...planned,
      // A side pile two abreast becomes one; a pile on the felt, one chip wide.
      shape: side && narrow >= 1 && planned.shape?.kind === "beside" ? ({ kind: "beside", cols: 1 } as const) : planned.shape,
      narrow: !side && !seat.isHero && narrow >= 2,
    };
    const pods = g.seats.filter((s) => !s.isHero && s.seat !== seat.seat).map((s) => podBox(s, g.density));
    const spot = (index: number, count: number, shift: number) =>
      pileSpot(g, seat, index, count, { shape: base.shape, shift, narrow: base.narrow });
    // Every chip of a pile of `count`: a short row is centred, so a pile of
    // one does not sit where the first of a pile of three does. A pile of one
    // is also where a stack stands, reaching a few px the way the pile grows.
    const discs = (count: number, shift: number) => {
      const out = Array.from({ length: count }, (_, index) => disc(spot(index, count, shift), 2));
      if (count === 1) {
        const first = spot(0, 1, shift);
        const down = spot(base.cap, base.cap + 1, shift).cy > first.cy + 0.5;
        out.push(disc({ cx: first.cx, cy: first.cy + (down ? stackHeight : -stackHeight) }, 2));
      }
      return out;
    };
    return { seat, base, pods, discs, shift: 0 };
  });
  const clear = (boxes: Box[], blockers: Box[]) => boxes.every((c) => !blockers.some((b) => meets(c, b)));

  // First every seat's first spot - the one its stack stands on - so each has
  // at least that, wherever the piles nearer the middle would have grown.
  const firsts = new Map<SeatId, Box[]>();
  for (const piece of pieces) {
    const blockers = [...keep, ...piece.pods, ...[...firsts.values()].flat()];
    let shift: number | null = null;
    for (let k = 0; k <= d * 3 && shift === null; k += 2) {
      if (clear(piece.discs(1, k), blockers)) shift = k;
      else if (k > 0 && clear(piece.discs(1, -k), blockers)) shift = -k;
    }
    if (shift === null) unplaced++;
    piece.shift = shift ?? 0;
    firsts.set(piece.seat.seat, piece.discs(1, piece.shift));
  }

  // Then each pile grows, one chip at a time, while it keeps clear of the
  // others' first spots and of the piles already grown.
  for (const piece of pieces) {
    const others = [...firsts.entries()].filter(([seat]) => seat !== piece.seat.seat).flatMap(([, boxes]) => boxes);
    const blockers = [...placed, ...keep, ...piece.pods, ...others];
    let cap = 1;
    while (cap < piece.base.cap && clear(piece.discs(cap + 1, piece.shift), blockers)) cap++;
    plans.set(piece.seat.seat, { shape: piece.base.shape, cap, shift: piece.shift, narrow: piece.base.narrow });
    for (let count = 1; count <= cap; count++) placed.push(...piece.discs(count, piece.shift));
  }
  return { plans, unplaced };
}

function planPile(g: TableGeometry, seat: SeatSlot): Omit<PilePlan, "shift"> {
  if (!isRimSidePile(g, seat)) {
    const cols = g.tuck ? 2 : 3;
    const rows = rowsClear(g, cols, (i) => groundPileSpot(g, seat, i, cols * 3));
    return { shape: null, cap: Math.max(1, rows * cols) };
  }
  const two: RimPileShape = { kind: "beside", cols: 2 };
  if (rowsClear(g, 2, (i) => rimPileSpot(g, seat, i, two)) === 3) return { shape: two, cap: 6 };

  // The gap below the pod: to the next pod down this side, or the band.
  const d = g.miniCard.w;
  const pod = POD_SIZE[g.density];
  const below = g.seats
    .filter((s) => s.anchor === seat.anchor && s.y > seat.y)
    .map((s) => s.y - pod.h / 2);
  const room = Math.min(g.band.y, ...below) - (seat.y + pod.h / 2) - 8;
  // Three rows, overlapping more where the gap is short, but never so much
  // that a row stops showing.
  const step = Math.min(d * 0.86, (room - d) / 2);
  if (step >= d * 0.55) return { shape: { kind: "hang", step }, cap: 6 };

  const one: RimPileShape = { kind: "beside", cols: 1 };
  return { shape: one, cap: Math.max(1, rowsClear(g, 1, (i) => rimPileSpot(g, seat, i, one))) };
}

/**
 * When LRC's chips stop being laid out one by one and become one stack with
 * its count on it (the user's call, 2026-09-28). On a phone the pot always
 * stacks: its grid sat on the dice, and four chips at the pot's size already
 * crowded the middle of a small screen. A seat's pile stacks past its third
 * row, where fifteen chips beside a pod stopped reading as a count at all —
 * or sooner, past the last row that keeps off the dice and the pot (see
 * `planPile`). A larger screen's pot keeps two rows of five.
 */
const POT_GRID_MAX = 10;
/** Each chip up a stack sits this share of a chip higher, up to this many. */
const CHIP_STACK_STEP = 0.04;
const CHIP_STACK_LIFT_MAX = 6;

/**
 * How far apart a gathered hand's cards sit (see `layoutPiece`), and the most
 * the whole stack may spread, so a 25-card hand stays a stack and not a fan.
 */
const GATHERED_STEP_PX = 3;
const GATHERED_SPREAD_MAX_PX = 36;

export function chipPileStacks(g: TableGeometry, p: Pick<Placement, "zone" | "seat" | "count">): boolean {
  if (p.count < 2) return false;
  if (p.zone === "center") return g.profile !== "roomy" || p.count > POT_GRID_MAX;
  if (p.zone !== "collected") return false;
  const seat = p.seat !== undefined ? slotForSeat(g, p.seat) : undefined;
  if (!seat) return false;
  return p.count > pilePlan(g, seat).cap;
}

/**
 * Where to write each stacked chip pile's count: the centre and drawn
 * diameter of the TOP chip of every pile `chipPileStacks` collapses. Read
 * from the placements the pieces are drawn from, so the number changes as a
 * chip sets off for the pile rather than when the turn's state settles.
 */
export function chipStackBadges(
  g: TableGeometry,
  placements: Record<string, Placement>,
): Array<{ key: string; count: number; cx: number; cy: number; diameter: number }> {
  const base = baseSize(g);
  const out: Array<{ key: string; count: number; cx: number; cy: number; diameter: number }> = [];
  for (const p of Object.values(placements)) {
    if (p.index !== p.count - 1 || !chipPileStacks(g, p)) continue;
    const t = layoutPiece(p, g, { kind: "chip" });
    out.push({
      key: `${p.zone}:${p.seat ?? ""}`,
      count: p.count,
      cx: t.x + base.w / 2,
      cy: t.y + base.h / 2,
      diameter: t.scale * base.w,
    });
  }
  return out;
}


/**
 * Directions for a seat on the rim: `along` runs parallel to its edge,
 * `inward` points at the board. By the edge the seat is on, not by the line
 * to the board's centre — a high side seat sits in the top corner, and the
 * line from there points mostly DOWN, which would put the left player's
 * trick card where the partner's goes.
 */
function rimVectors(anchor: SeatSlot["anchor"]) {
  switch (anchor) {
    case "top":
      return { along: { x: 1, y: 0 }, inward: { x: 0, y: 1 } };
    case "left":
      return { along: { x: 0, y: 1 }, inward: { x: 1, y: 0 } };
    case "right":
      return { along: { x: 0, y: 1 }, inward: { x: -1, y: 0 } };
    default:
      return { along: { x: 1, y: 0 }, inward: { x: 0, y: -1 } };
  }
}

/**
 * The base box every piece is rendered at, before scaling — the largest any
 * piece is drawn (`TableGeometry.pieceBox`). The viewer's own hand used to BE
 * this box; on a laptop it is now drawn smaller than it (`handArt`), so the
 * board may grow past the hand without a piece ever scaling above 1.
 */
export function baseSize(g: TableGeometry) {
  return g.pieceBox;
}

/**
 * What the viewer's own hand DRAWS, card or tile — `artSize`'s counterpart
 * for the hand. Everything sized as a fraction of "a card in your hand" (the
 * fan's spacing, a lift, a hover spread) measures this, not the base box.
 */
export function handArt(g: TableGeometry, kind: PieceKind | undefined): PieceSize {
  if (kind !== "tile") return g.handCard;
  const w = tileShortSide(g.handCard);
  return { w, h: w * 2 };
}

/**
 * What a piece actually DRAWS inside that base box. A card fills it; a
 * domino is 1:2 and inscribes itself (see TileFace), so every scale in
 * this file has to be computed against the art, not the box, or a tile
 * comes out a third too small everywhere.
 *
 * Exported because the same distinction matters OUTSIDE layout: any
 * effect sized as a fraction of "the piece" has to mean the drawn art or
 * it lands differently on a tile than on a card. See `handHoverLift` in
 * PieceLayer, where measuring the hover spread against the box made a
 * domino rack fan roughly 45% wider than a card hand for the same
 * constant.
 */
export function artSize(g: TableGeometry, kind: PieceKind | undefined): PieceSize {
  const base = baseSize(g);
  if (kind !== "tile") return base;
  const w = Math.min(base.w, base.h / 2);
  return { w, h: w * 2 };
}

/** The same piece's size when it is lying on the table / in a pod. */
function tableArt(g: TableGeometry, kind: PieceKind | undefined): number {
  return kind === "tile" ? tileShortSide(g.card) : g.card.w;
}

function miniArt(g: TableGeometry, kind: PieceKind | undefined): number {
  return kind === "tile" ? tileShortSide(g.miniCard) : g.miniCard.w;
}

function centred(cx: number, cy: number, g: TableGeometry) {
  const base = baseSize(g);
  return { x: cx - base.w / 2, y: cy - base.h / 2 };
}

/** `boxCentre` in the `{x, y}` shape `radialFanSlot`'s anchor wants. */
function boxCentreXY(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function boxCentre(b: Box) {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

/**
 * A small, capped, diagonally-lifted face-down stack — the low-emphasis
 * look poker's `stub` and `burnt` zones both want (see their own
 * `ZoneName` docs): neither pile is something a player reads card by
 * card, so a stack reading as "a few cards set aside" is more honest
 * than spreading them into a fan for no reason. Shared by both cases
 * below rather than duplicated, since they differ only in which zone
 * box they read.
 */
/**
 * How long a side seat's fan may run, centred on `anchorY`, before its
 * lower end passes the ring's bottom edge — below which is the band above
 * the viewer's hand. `tilt` pays for a tilted piece's corners reaching a
 * little further than its own width.
 */
function sideFanRoom(g: TableGeometry, anchorY: number, tilt: number): number {
  const bottom = g.zones.play.y + g.zones.play.h;
  return Math.max(0, 2 * (bottom - anchorY) - tilt * 0.3);
}

function miniStackSlot(zone: Box, index: number) {
  const { cx, cy } = boxCentre(zone);
  const lift = Math.min(index, 6) * 0.6;
  const tilt = ((index * 37) % 9) - 4;
  return { cx: cx + lift, cy: cy - lift, tilt };
}

/**
 * Keeps a piece's centre point on screen. Needed specifically for chip
 * piles: they fan outward from a seat that itself sits near a screen
 * edge, and a pod on the left/right edge is rarely exactly opposite
 * table centre — the perpendicular spread that fans a growing pile
 * sideways then has a component pointing straight off the edge the pod
 * is already hugging. A clamp is simpler and more robust than trying to
 * out-guess every seat's geometry with fan-direction special cases.
 */
function clampToBox(cx: number, cy: number, box: Box, marginW: number, marginH: number) {
  return {
    cx: Math.min(Math.max(cx, box.x + marginW), box.x + box.w - marginW),
    cy: Math.min(Math.max(cy, box.y + marginH), box.y + box.h - marginH),
  };
}

/* ============================================================
   Opponent hand lanes — no hand ever on another seat.
   ============================================================ */

type Vec = { x: number; y: number };

/**
 * How one opponent's face-down hand is laid, before its card count is known:
 * the point it fans about, the way it runs, and how its cards stand.
 */
interface HandFrame {
  seat: SeatSlot;
  anchor: Vec;
  /** Unit vector the fan runs along. */
  spread: Vec;
  /** Unit vector away from the board: the way the fan's ends bow. */
  away: Vec;
  /** Base rotation of every card, in degrees. */
  rotation: number;
  /** The most a card at either end tilts past `rotation`, in degrees. */
  tilt: number;
  /** How far the ends bow along `away`, in px. */
  bow: number;
  /** A card's size, unturned: `w` runs along the fan. */
  size: PieceSize;
  /** The longest the fan would run if nothing were in its way, centre to centre. */
  span: (count: number) => number;
  maxGap: number;
  /** Its own pod is in its way too (a fanned hand), or not (a tucked one, which sits behind it). */
  clearsOwnPod: boolean;
  /** The lowest any of its cards may reach on screen, when that is less than the board's own edge. */
  floor?: number;
  /** How far from its anchor a card centre may go at most, either way (a tucked hand stays at its pod). */
  reach?: number;
}

/** Air kept between a hand and anything else on the rim. */
const LANE_GAP = 4;

/** How far a card of this frame reaches along `a`, at any tilt its fan gives it. */
function frameReach(f: HandFrame, a: Vec): number {
  let most = 0;
  for (const deg of [f.rotation - f.tilt, f.rotation, f.rotation + f.tilt]) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const reach = (f.size.w / 2) * Math.abs(c * a.x + s * a.y) + (f.size.h / 2) * Math.abs(-s * a.x + c * a.y);
    most = Math.max(most, reach);
  }
  return most + f.bow * Math.abs(f.away.x * a.x + f.away.y * a.y);
}

/**
 * Where along a frame's line a card's CENTRE may go without touching `box`,
 * as the stretch it may NOT go (empty when the box is never in the way).
 * Separating axes: the card and the box are apart if any of the four edge
 * normals parts them, so the card overlaps only where all four overlap.
 */
function blockedBy(f: HandFrame, box: Box): [number, number] | null {
  const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const r = (f.rotation * Math.PI) / 180;
  const axes: Vec[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: Math.cos(r), y: Math.sin(r) },
    { x: -Math.sin(r), y: Math.cos(r) },
  ];
  let lo = -Infinity;
  let hi = Infinity;
  for (const a of axes) {
    const k = f.spread.x * a.x + f.spread.y * a.y;
    const c = (centre.x - f.anchor.x) * a.x + (centre.y - f.anchor.y) * a.y;
    const reach = frameReach(f, a) + axisReach(a.x, a.y, box) + LANE_GAP;
    if (Math.abs(k) < 1e-9) {
      // Moving along the fan never changes this axis: apart on it is apart everywhere.
      if (Math.abs(c) >= reach) return null;
      continue;
    }
    const t1 = (c - reach) / k;
    const t2 = (c + reach) / k;
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
    if (lo >= hi) return null;
  }
  return [lo, hi];
}

/**
 * The stretch two neighbouring hands each keep to, as a cap on how far along
 * its own line `f` may run toward `other`: the two are split halfway along
 * whichever axis leaves the more room to the tighter of them. Both seats
 * work it out the same way, so they agree on the split.
 */
function splitWith(f: HandFrame, other: HandFrame): { k: number; room: number } {
  const dx = other.anchor.x - f.anchor.x;
  const dy = other.anchor.y - f.anchor.y;
  const len = Math.hypot(dx, dy) || 1;
  let best: { k: number; room: number; score: number } | null = null;
  for (const a of [{ x: dx / len, y: dy / len }, { x: 1, y: 0 }, { x: 0, y: 1 }]) {
    const apart = dx * a.x + dy * a.y;
    const sign = apart >= 0 ? 1 : -1;
    const half = Math.abs(apart) / 2 - LANE_GAP / 2;
    const mine = half - frameReach(f, a);
    const theirs = half - frameReach(other, a);
    const score = Math.min(mine, theirs);
    if (!best || score > best.score) {
      best = { k: sign * (f.spread.x * a.x + f.spread.y * a.y), room: mine, score };
    }
  }
  return best!;
}

/** The stretch of its own line, about its anchor, where a frame's card centres may go. */
interface Lane {
  frame: HandFrame;
  lo: number;
  hi: number;
  /** The longest any hand at this table may run, where they are all to look alike. */
  most?: number;
}

function laneFor(g: TableGeometry, f: HandFrame, frames: readonly HandFrame[]): Lane {
  // What only ever limits one end: the neighbouring hands, and (a side
  // seat's) the bottom of the ring, below which is the viewer's own band.
  let lo = -(f.reach ?? 1e6);
  let hi = f.reach ?? 1e6;
  const cap = (k: number, room: number) => {
    if (Math.abs(k) < 1e-9) return;
    if (k > 0) hi = Math.min(hi, room / k);
    else lo = Math.max(lo, room / k);
  };
  for (const other of frames) {
    if (other.seat.seat === f.seat.seat) continue;
    const { k, room } = splitWith(f, other);
    cap(k, room);
  }
  const bottom = Math.min(g.zones.play.y + g.zones.play.h, f.floor ?? Infinity);
  cap(f.spread.y, bottom - frameReach(f, { x: 0, y: 1 }) - f.anchor.y);

  // What can sit in the middle of it: every pod but the viewer's.
  const blocked: Array<[number, number]> = [];
  for (const slot of g.seats) {
    if (slot.isHero || (slot.seat === f.seat.seat && !f.clearsOwnPod)) continue;
    const b = blockedBy(f, podBox(slot, g.density));
    if (b) blocked.push(b);
  }
  blocked.sort((a, b) => a[0] - b[0]);
  // The free stretches left, and of them the one nearest the anchor.
  const free: Array<[number, number]> = [];
  let from = lo;
  for (const [a, b] of blocked) {
    if (a > from) free.push([from, Math.min(a, hi)]);
    from = Math.max(from, b);
  }
  if (from < hi) free.push([from, hi]);
  const usable = free.filter(([a, b]) => b > a);
  if (usable.length === 0) return { frame: f, lo: 0, hi: 0 };
  const distance = ([a, b]: [number, number]) => (a > 0 ? a : b < 0 ? -b : 0);
  const [nearLo, nearHi] = usable.reduce((best, s) => (distance(s) < distance(best) ? s : best));
  return { frame: f, lo: nearLo, hi: nearHi };
}

const laneCache = new WeakMap<TableGeometry, Map<string, Map<SeatId, Lane>>>();

/** Every opponent's lane at this table, worked out once per geometry. */
function lanesFor(
  g: TableGeometry,
  key: string,
  frameOf: (seat: SeatSlot) => HandFrame,
  uniform = false,
): Map<SeatId, Lane> {
  let byKey = laneCache.get(g);
  if (!byKey) laneCache.set(g, (byKey = new Map()));
  let lanes = byKey.get(key);
  if (lanes) return lanes;
  const frames = g.seats.filter((s) => !s.isHero).map(frameOf);
  lanes = new Map(frames.map((f) => [f.seat.seat, laneFor(g, f, frames)]));
  if (uniform) {
    // Hands tucked behind their pods all spread alike: a side seat pinched
    // under a top corner pod showed a sliver beside everyone else's fan
    // (the user, 2026-10-31). The tightest lane sets it for every seat.
    const most = Math.min(...[...lanes.values()].map((l) => Math.max(0, l.hi - l.lo)));
    for (const lane of lanes.values()) lane.most = most;
  }
  byKey.set(key, lanes);
  return lanes;
}

/**
 * One card of a hand laid in its lane: the fan runs as long as it would, or
 * as long as the lane allows, and sits as near its anchor as the lane lets it.
 */
function laneSlot(lane: Lane, index: number, count: number) {
  const f = lane.frame;
  const room = Math.max(0, lane.hi - lane.lo);
  const span = Math.min(f.span(count), room, lane.most ?? Infinity);
  const centre =
    lane.hi < lane.lo ? (lane.lo + lane.hi) / 2 : Math.min(Math.max(0, lane.lo + span / 2), lane.hi - span / 2);
  return radialFanSlot({
    anchor: { x: f.anchor.x + f.spread.x * centre, y: f.anchor.y + f.spread.y * centre },
    spread: f.spread,
    away: f.away,
    index,
    count,
    spreadWidth: span + f.size.w,
    size: f.size,
    baseRotation: f.rotation,
    maxTilt: f.tilt,
    arcLift: f.bow,
    maxGap: f.maxGap,
  });
}

/* ============================================================
   Tucked and shown hands — an opponent's hand on a phone.
   ============================================================ */

/**
 * A face-down opponent hand where hands are tucked (`TableGeometry.tuck`):
 * a tight fan of backs behind the pod, running along its edge, with its
 * inner part (`TUCK_PEEK_FRACTION` of a card) showing past the pod's inner edge.
 *
 * Costs the board nothing, which is the point: on a phone the fanned hands
 * used to reach further into the table than the board itself got. The count
 * they stood for is in the pod's own text. Every card still has a place, so
 * a deal flies to its player and a play flies from them.
 */
/**
 * A face-down opponent hand fanned on the felt, beside its pod.
 *
 * A top seat off to one side holds its cards facing the board: the fan leans
 * toward the board's centre (up to `TOP_HAND_LEAN`), each card turned with
 * it, and the hand sits below its pod rather than off to the side of it (the
 * user, 2026-10-31). Its inner end dips as it leans, as far as geometry's
 * `topHandDrop` allows, and no further. A top seat over the centre, and a
 * side seat, sit as they always did: pushed straight out toward the centre,
 * a side seat's cards a quarter turn round and running down its edge.
 */
function fannedFrame(g: TableGeometry, seat: SeatSlot, kind: PieceKind | undefined): HandFrame {
  const miniW = miniArt(g, kind);
  const miniH = g.miniCard.h;
  const pod = POD_SIZE[g.density];
  const { cx, cy } = boxCentre(g.zones.play);
  const len = Math.hypot(cx - seat.x, cy - seat.y) || 1;
  const u = { x: (cx - seat.x) / len, y: (cy - seat.y) / len };
  const maxGap = miniW * 0.42;
  const frame: HandFrame = {
    seat,
    anchor: { x: seat.x, y: seat.y },
    spread: { x: -u.y, y: u.x },
    away: { x: -u.x, y: -u.y },
    rotation: seat.rotation,
    tilt: HAND_FAN_TILT,
    bow: HAND_FAN_BOW,
    size: { w: miniW, h: miniH },
    // A domino hand's 2.4x floor, scaled with the count so a big hand gets
    // room before the fan has to compress.
    span: (count) => Math.min(maxGap * Math.max(0, count - 1), miniW * Math.max(2.4, count * 0.9) - miniW),
    maxGap,
    // Pushed straight out, a fan running square to that push never comes back to its pod.
    clearsOwnPod: false,
  };

  const leaning = seat.anchor === "top" && g.seats.filter((s) => s.anchor === "top").length >= 2;
  if (leaning) {
    const limit = (TOP_HAND_LEAN * Math.PI) / 180;
    const lean = Math.max(-limit, Math.min(limit, Math.atan2(u.x, u.y)));
    // Toward the board, leaning: the way the cards point and the fan bows from.
    const v = { x: Math.sin(lean), y: Math.cos(lean) };
    const turned = (miniW / 2) * Math.abs(v.x) + (miniH / 2) * v.y;
    const leant: HandFrame = {
      ...frame,
      // Tucked up under the pod's inner corner: the inner end rises beside
      // the pod, the outer end under it. Hung lower, or further out, the
      // hand left an empty wedge of felt between itself and the pod (the
      // user, 2026-10-31).
      anchor: {
        x: seat.x + Math.sign(v.x) * (pod.w / 2),
        y: seat.y + pod.h / 2 + TILE_HAND_GAP + turned,
      },
      spread: { x: -v.y, y: v.x },
      away: { x: -v.x, y: -v.y },
      rotation: 180 - (lean * 180) / Math.PI,
    };
    return {
      ...leant,
      // Its upper end rises back toward its own pod as it leans.
      clearsOwnPod: true,
      floor: seat.y + pod.h / 2 + TILE_HAND_GAP + topHandDrop(g.miniCard, true),
    };
  }

  // A side seat's card is turned a quarter, so its reach toward the board is
  // its height.
  const quarter = seat.anchor === "left" || seat.anchor === "right";
  const footprint: PieceSize = quarter ? { w: miniH, h: miniW } : { w: miniW, h: miniH };
  const inset = axisReach(u.x, u.y, pod) + axisReach(u.x, u.y, footprint) + TILE_HAND_GAP;
  return { ...frame, anchor: { x: seat.x + u.x * inset, y: seat.y + u.y * inset } };
}

function tuckedFrame(g: TableGeometry, seat: SeatSlot, kind: PieceKind | undefined): HandFrame {
  const pod = POD_SIZE[g.density];
  const { along, inward } = rimVectors(seat.anchor);
  const miniW = miniArt(g, kind);
  // Turned with its seat, a piece's long side points at the board on every
  // edge, so its reach INWARD is its height and its run ALONG is its width.
  const miniH = kind === "tile" ? miniW * 2 : g.miniCard.h;
  const podDepth = along.x !== 0 ? pod.h : pod.w;
  const podAlong = along.x !== 0 ? pod.w : pod.h;
  // How far it shows past the pod's inner edge — the board keeps clear of
  // exactly this. A top seat's may be 0 (a landscape phone, where height is
  // scarce): its hand then fans wider along the pod and shows at its sides.
  const peek = seat.anchor === "left" || seat.anchor === "right" ? g.tuckPeek.side : g.tuckPeek.top;
  const offset = podDepth / 2 + peek - miniH / 2;
  const tile = kind === "tile";
  const maxGap = miniW * (tile ? 0.55 : 0.3);
  // A little wider than the pod, so the backs show at its sides too —
  // much wider where they do not peek past it at all.
  const width = podAlong * (peek > 0 ? 1.25 : 1.9);
  return {
    seat,
    anchor: { x: seat.x + inward.x * offset, y: seat.y + inward.y * offset },
    spread: along,
    away: { x: -inward.x, y: -inward.y },
    rotation: seat.rotation,
    tilt: tile ? 0 : 5,
    bow: tile ? 0 : 2,
    size: { w: miniW, h: miniH },
    span: (count) => Math.min(maxGap * Math.max(0, count - 1), Math.max(0, width - miniW)),
    maxGap,
    clearsOwnPod: false,
    // Squeezed rather than slid away from its own pod: it stands for that seat.
    reach: Math.max(0, width - miniW) / 2,
  };
}

function tuckedHand(
  g: TableGeometry,
  seat: SeatSlot,
  p: Placement,
  kind: PieceKind | undefined,
  opacity: number,
): PieceTransform {
  const base = baseSize(g);
  const miniW = miniArt(g, kind);
  // Kept to its own stretch of the rim: spread wider than its pod, a hand
  // ran under the next pod along and its peek showed from beneath it, or
  // from under a top-corner pod (the user, 2026-10-31: no overlaps).
  const lane = lanesFor(g, `tuck|${kind}`, (s) => tuckedFrame(g, s, kind), true).get(seat.seat)!;
  const slot = laneSlot(lane, p.index, p.count);
  return {
    x: slot.x - base.w / 2,
    y: slot.y - base.h / 2,
    rotate: slot.rotation,
    scale: miniW / artSize(g, kind).w,
    z: Z_TUCKED + p.index,
    opacity,
  };
}

/**
 * A face-UP opponent hand where hands are tucked — a showdown. Drawn over
 * the pod, upright whatever edge the seat is on (a quarter-turned card is
 * not read, and reading it is the whole reason it was turned over), a
 * little larger than a tucked back, and shifted toward the board so the
 * player's name stays in view above it.
 */
const SHOWN_SCALE = 1.25;

function shownHand(
  g: TableGeometry,
  seat: SeatSlot,
  p: Placement,
  kind: PieceKind | undefined,
  opacity: number,
): PieceTransform {
  const base = baseSize(g);
  const pod = POD_SIZE[g.density];
  const { along, inward } = rimVectors(seat.anchor);
  const podDepth = along.x !== 0 ? pod.h : pod.w;
  const w = miniArt(g, kind) * SHOWN_SCALE;
  const h = (kind === "tile" ? miniArt(g, kind) * 2 : g.miniCard.h) * SHOWN_SCALE;
  const cx = seat.x + inward.x * podDepth * 0.3;
  const cy = seat.y + inward.y * podDepth * 0.3;
  const slot = fanSlot({
    index: p.index,
    count: p.count,
    within: { x: cx - pod.w / 2 - w * 0.3, y: cy, w: pod.w + w * 0.6, h: 0 },
    size: { w, h },
    maxRotation: 6,
    arcLift: 2,
    maxGap: w * 0.62,
  });
  return {
    x: slot.x - base.w / 2,
    y: slot.y - base.h / 2,
    rotate: slot.rotation,
    scale: w / artSize(g, kind).w,
    z: Z_SHOWN + p.index,
    opacity,
  };
}

/* ============================================================
   The board camera — dominoes' line of play.
   ============================================================ */

/**
 * A domino chain cannot be laid out from (index, count) the way every
 * other zone is: a double advances the line by one unit where everything
 * else advances it by two, so a tile's spot depends on the entire run
 * before it. The game therefore computes each tile's board-space cell
 * ONCE, when it is played, and that cell is then immutable for the rest
 * of the round — a played tile never moves relative to its neighbours,
 * which is the whole point.
 *
 * What moves instead is this camera. It fits the chain's bounding box
 * into the line zone, so the board is viewed from further back as it
 * grows rather than being re-laid-out. Every relative position and every
 * pip contact is preserved exactly, because a fit is one scale and one
 * translation applied to the whole space.
 *
 * Two properties keep it calm:
 *
 *  - `unit` is CLAMPED at the hand's own tile, so for the opening tiles
 *    the camera is completely still — it only starts easing out once the
 *    chain genuinely no longer fits.
 *  - the bounding box only ever grows (tiles are never removed), so the
 *    scale is monotonically non-increasing. It cannot oscillate.
 */
export interface BoardCamera {
  /** Screen px per board unit. */
  unit: number;
  /** Rotation applied to the whole board space, in degrees. */
  rot: number;
  /** Board-space point that sits at the screen centre of the zone. */
  bx: number;
  by: number;
  /** That screen centre. */
  cx: number;
  cy: number;
}

/** Blank space kept around the chain, in board units. */
const BOARD_PAD = 0.6;

/**
 * A tile renders at slightly under its exact unit footprint, so every
 * joint gets a uniform hairline. Real dominoes on a table have that gap;
 * without it two doubles in adjacent rows read as one solid block.
 */
const CONTACT_GAP = 0.955;

export function boardCamera(g: TableGeometry, board: BoardView | null): BoardCamera {
  const zone = g.zones.line;
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;
  // The hand's own tile, not the table card: a short chain is the whole
  // board, and it used to be drawn smaller than the tiles in your hand
  // however much felt it had (docs/table-layout-rethink.md). The hand's
  // tile is also the base box every piece renders at, so this is the
  // largest a tile can be drawn without blurring (see `stageCeiling`).
  const maxUnit = tileShortSide(g.pieceBox);

  // Turning the whole board a quarter turn on a portrait zone is not a
  // gimmick: domino pips are rotation-invariant, so it costs nothing to
  // read, and it roughly DOUBLES the usable tile size on a phone (a
  // ~14x8-unit board fits a 270x620 zone at ~19px/unit upright, ~34
  // rotated). Derived from the zone alone, never from the chain, so it
  // is stable for a whole round and only changes on a real resize.
  const rot = zone.h > zone.w ? 90 : 0;

  if (!board) return { unit: maxUnit, rot, bx: 0, by: 0, cx, cy };

  const bw = board.maxX - board.minX + BOARD_PAD * 2;
  const bh = board.maxY - board.minY + BOARD_PAD * 2;
  const fitW = rot === 90 ? bh : bw;
  const fitH = rot === 90 ? bw : bh;

  const unit = Math.min(zone.w / fitW, zone.h / fitH, maxUnit);

  return {
    unit,
    rot,
    bx: (board.minX + board.maxX) / 2,
    by: (board.minY + board.maxY) / 2,
    cx,
    cy,
  };
}

/** Board-space cell -> screen centre and final rotation. */
export function projectCell(cell: BoardCell, cam: BoardCamera) {
  const dx = cell.x - cam.bx;
  const dy = cell.y - cam.by;
  // Screen y runs downward, so a quarter turn clockwise takes
  // (x, y) -> (-y, x). The piece's own rotation gets the same turn, which
  // is what keeps the tile square to the run it was laid along.
  const rx = cam.rot === 90 ? -dy : dx;
  const ry = cam.rot === 90 ? dx : dy;
  return {
    cx: cam.cx + rx * cam.unit,
    cy: cam.cy + ry * cam.unit,
    rotate: cell.rot + cam.rot,
  };
}

/** On-screen size of one board-space piece, for ghosts and markers. */
export function boardPieceSize(cam: BoardCamera) {
  return { short: cam.unit * CONTACT_GAP, long: cam.unit * 2 * CONTACT_GAP };
}

export interface LayoutContext {
  /** What the piece physically is — a tile draws 1:2 inside the base box. */
  kind?: PieceKind;
  /** Extent of everything in board space; drives the camera. */
  board?: BoardView | null;
  /**
   * Pan offsets for the two compress-then-pan zones, and the discard
   * pile's live depth.
   *
   * Each is threaded in only for the pieces that actually need it (see
   * PieceLayer's gated subscriptions): a pan updates on every
   * pointermove, and an ungated subscription would re-render all 52
   * pieces per frame of a drag. `discardCount` is the deck's own — in
   * landscape the deck slides aside as the fan beside it grows, and
   * layout is otherwise deliberately blind to a piece's siblings.
   */
  discardScroll?: number;
  discardCount?: number;
  handScroll?: number;
  /**
   * The player's Card spacing for a hand that pans, as a fraction of a
   * card (see `HAND_FLOORS`). Absent, `MIN_HAND_GAP_FRACTION`.
   */
  handFloor?: number;
  /**
   * Where this piece sits in the hero's hand, overriding the
   * placement's own index — a player-chosen sort. Resolved by
   * PieceLayer, which is the layer that knows a piece's id; layout only
   * ever sees one anonymous placement at a time.
   */
  handIndex?: number;
}

export function layoutPiece(
  p: Placement,
  g: TableGeometry,
  ctx?: LayoutContext,
): PieceTransform {
  // A chip pile past what its room shows one by one is ONE stack: every chip
  // on the pile's first spot, lifted a hair each so it reads as a stack, and
  // the count said on top (`chipStackBadges`).
  if (ctx?.kind === "chip" && chipPileStacks(g, p)) {
    const first = layoutLoose({ ...p, index: 0, count: 1 }, g, ctx);
    const diameter = first.scale * artSize(g, ctx.kind).w;
    const step = diameter * CHIP_STACK_STEP;
    const height = Math.min(p.count - 1, CHIP_STACK_LIFT_MAX) * step;
    // Inside the room the pile would have grown into, never past its first
    // spot the other way: a stack lifted UP from a pile that grows down (a
    // side seat's, the pot) climbed into the top seat's pod. Such a stack
    // starts its own height lower, so its top chip is where the first was.
    const last = layoutLoose({ ...p, index: p.count - 1 }, g, ctx);
    const settle = last.y > first.y + 0.5 ? height : 0;
    const lift = Math.min(p.index, CHIP_STACK_LIFT_MAX) * step;
    return { ...first, y: first.y + settle - lift, z: first.z + p.index };
  }
  // A hand picked up to be handed over (`gather`): every card closed in on
  // the fan's middle slot, still fanned a few pixels apart. Squared up a hair
  // apart it read as ONE card (the user, 2026-10-31); this way it still reads
  // as a hand of so many, travelling together.
  if (p.gathered && p.zone === "hand") {
    const mid = Math.floor((p.count - 1) / 2);
    const at = layoutLoose({ ...p, gathered: false, index: mid }, g, { ...ctx, handIndex: mid });
    const order = ctx?.handIndex ?? p.index;
    const step = p.count > 1 ? Math.min(GATHERED_STEP_PX, GATHERED_SPREAD_MAX_PX / (p.count - 1)) : 0;
    const off = (order - (p.count - 1) / 2) * step;
    return { ...at, x: at.x + off, y: at.y - order * 0.4, z: at.z - mid + order };
  }
  return layoutLoose(p, g, ctx);
}

/** Every piece laid out on its own, with no pile collapsed to a stack. */
function layoutLoose(p: Placement, g: TableGeometry, ctx?: LayoutContext): PieceTransform {
  const base = baseSize(g);
  const art = artSize(g, ctx?.kind);
  const tableScale = tableArt(g, ctx?.kind) / art.w;
  const miniScale = miniArt(g, ctx?.kind) / art.w;

  // Where a chain of centre zones had to shrink to fit (see
  // `TableGeometry.zoneScale`); 1 everywhere else.
  const zs = g.zoneScale[p.zone as ZoneName] ?? 1;
  const zBase = Z[p.zone] ?? 0;
  const z = p.selected ? Z_SELECTED + p.index : zBase + p.index;
  // `dimmed` no longer touches opacity — POLICY.md's "invalid options
  // drop to ~0.3 opacity" was replaced by a grayscale/darken filter
  // (see PieceLayer.tsx) so a dimmed card stays fully legible instead of
  // washing out toward the felt. `hidden` is the one thing that still
  // animates opacity here, since fading a piece out in place (Spades'
  // won tricks) is exactly the case opacity-as-a-transform-safe-property
  // exists for.
  const opacity = p.hidden ? 0 : 1;

  switch (p.zone) {
    /* -------------------------------------------------- deck */
    case "deck": {
      // A game whose discard pile fans (Rummy) passes its live depth,
      // and in LANDSCAPE — where the fan grows along the same axis the
      // two piles are offset on — the deck gives ground to it, keeping
      // the pair centred as one unit. In PORTRAIT the fan grows
      // perpendicular to that offset, so there is no reason for the deck
      // to move and it does not. See geometry's `isPortraitTable`.
      //
      // Every other game passes nothing and gets `g.zones.deck` exactly
      // as before.
      const anchor =
        ctx?.discardCount === undefined
          ? boxCentre(g.zones.deck)
          : (() => {
              const { deckX, deckY } = pileAssemblyHorizontal(g, ctx.discardCount!);
              return { cx: deckX, cy: deckY };
            })();
      // A tall stack reads as depth, not as 52 offset cards — cap it.
      const lift = Math.min(p.index, 10) * 0.4;
      const { x, y } = centred(anchor.cx + lift, anchor.cy - lift, g);
      return { x, y, rotate: 0, scale: tableScale * zs, z, opacity };
    }

    /* ----------------------------------------------- discard */
    case "discard": {
      // Compress-then-pan is strictly opt-in: only a game that has
      // published a pan value (Rummy) gets the floored, pannable,
      // orientation-aware fan. Spades' two-card Blind Nil exchange, and
      // anything else that merely sets `fanned`, keeps the simple
      // centred fan below exactly as it was.
      if (p.fanned && ctx?.discardScroll !== undefined) {
        // Fanned so the player can see how deep the eligible run goes —
        // and floored, so a 20+ card pile stops shrinking into slivers
        // and becomes pannable instead (see MIN_DISCARD_STEP_FRACTION).
        //
        // Both orientations run through `radialFanSlot` rather than
        // `fanSlot` because portrait fans DOWN the screen and landscape
        // ACROSS it, and one parameterised path is the only way the two
        // stay in step. `size.w` is the piece's extent along the spread
        // axis by that function's own convention, hence the swap.
        const a = pileAssembly(g, p.count);
        const pc = pileCard(g);
        const along = a.portrait ? pc.h : pc.w;
        const slot = radialFanSlot({
          anchor: boxCentreXY(a.fan),
          spread: a.portrait ? { x: 0, y: 1 } : { x: 1, y: 0 },
          away: { x: 0, y: 0 },
          index: p.index,
          count: p.count,
          spreadWidth: a.portrait ? a.fan.h : a.fan.w,
          size: { w: along, h: along },
          baseRotation: 0,
          maxTilt: 0,
          arcLift: 0,
          // Must match `pileAssembly`'s own maxGap exactly — see
          // MAX_DISCARD_STEP_FRACTION for why the two share a constant.
          maxGap: along * MAX_DISCARD_STEP_FRACTION,
          minGap: a.minStep,
          pan: ctx?.discardScroll ?? 0,
          within: a.fan,
        });
        const { x, y } = centred(slot.x, slot.y, g);
        // A panned fan always draws cards outside the box it was given
        // — the compression floor is what makes it pannable, and the
        // excess has to be SOMEWHERE. `pileRegion` is only clear of the
        // seat pods and the sheet INSIDE its own bounds, so a card
        // carried past them lands under a pod, under the board sheet, or
        // off the screen entirely, and reads as broken.
        //
        // It cannot be clipped: the piece layer is one flat canvas of
        // independent absolutely positioned nodes with no wrapper to put
        // `overflow: hidden` on (CLAUDE.md). So the card fades out as it
        // crosses the boundary instead — which is what a masked scroller
        // looks like anyway, and stays on the compositor.
        return { x, y, rotate: 0, scale: tableScale * zs, z, opacity: opacity * slot.visible };
      }
      const { cx, cy } = boxCentre(g.zones.discard);
      if (p.fanned) {
        // Fanned so the player can see how deep the eligible run goes.
        const step = pileCard(g).w * 0.38;
        const spread = step * (p.count - 1);
        const { x, y } = centred(cx - spread / 2 + p.index * step, cy, g);
        return { x, y, rotate: 0, scale: tableScale * zs, z, opacity };
      }
      const lift = Math.min(p.index, 6) * 0.5;
      const { x, y } = centred(cx + lift, cy - lift, g);
      // A small deterministic tilt per card makes a real discard pile.
      const tilt = ((p.index * 37) % 9) - 4;
      return { x, y, rotate: tilt, scale: tableScale * zs, z, opacity };
    }

    /* ------------------------------------------------- trick */
    case "trick": {
      const trick = g.zones.trick;
      const { cx, cy } = boxCentre(trick);
      const seat = p.seat !== undefined ? slotForSeat(g, p.seat) : undefined;

      if (!seat) {
        const { x, y } = centred(cx, cy, g);
        return { x, y, rotate: 0, scale: tableScale * zs, z, opacity };
      }

      // Each played card sits offset from the centre toward whoever
      // played it, so a glance at the trick tells you who is winning.
      // Toward the EDGE they sit on where seats are a rim (see
      // `rimVectors`): a high side seat is up in the corner, and the true
      // line to it would stack the left player's card on the partner's.
      const compass = g.tuck ? rimVectors(seat.anchor).inward : null;
      const dx = compass ? -compass.x : seat.x - cx;
      const dy = compass ? -compass.y : seat.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const radius = Math.min(trick.w, trick.h) * 0.26;
      // ...but never so far that the card leaves the trick box. On a short
      // screen the box is squeezed between the top seat's hand and the
      // hero's, and a full offset would carry a card back out into one of
      // them; the cards overlapping each other a little more is the
      // better trade.
      const reachX = Math.max(0, trick.w / 2 - (art.w * tableScale * zs) / 2);
      const reachY = Math.max(0, trick.h / 2 - (art.h * tableScale * zs) / 2);
      const clamp = (v: number, reach: number) => Math.max(-reach, Math.min(reach, v));
      const { x, y } = centred(
        cx + clamp((dx / len) * radius, reachX),
        cy + clamp((dy / len) * radius, reachY),
        g,
      );
      return {
        x,
        y,
        rotate: ((p.index * 53) % 13) - 6,
        scale: tableScale * zs,
        z,
        opacity,
      };
    }

    /* ------------------------------------------------- board */
    case "board": {
      // A meld LANDING spot, not a permanent board layout.
      //
      // This used to be a full-width wrapping grid, and carried a known
      // bug with it: the grid had no idea where seat pods sat, so at 6+
      // seats a middle row rendered underneath a side pod and got
      // clipped. `podInset` only reserves clearance at the top and
      // bottom of the ring, never down the sides a multi-row grid
      // reaches.
      //
      // The fix is not a cleverer grid. With six players there can be
      // eighteen melds on the table, and no amount of grid maths makes
      // eighteen melds legible on a phone's felt — that is exactly the
      // problem the board sheet exists to solve (POLICY.md's three-tier
      // pattern: ambient pod strips, a peek rail, then targeted
      // filtering). So a laid meld flies to the felt, is visible for the
      // beat its own animation takes, and then fades in place, leaving
      // the felt to the piles. The game marks board pieces `hidden` for
      // that; `applyEvent`'s `moveTo` clears the flag on the way in so
      // the flight always plays.
      //
      // Which means all this has to do is put a landing spot somewhere
      // legible and pod-safe. `pileRegion` is already clear of both pods
      // and fanned opponent hands, so the meld lands BELOW it — on the
      // open felt between the piles and the hand.
      //
      // Below, specifically, and not on the region itself: landing a
      // meld on top of the discard pile makes the lay read as a discard,
      // which is the one other thing cards fly to from your hand. Two
      // different actions have to end in two different places or the
      // animation stops carrying information.
      const region = g.pileRegion;
      const play = g.zones.play;
      const pc = pileCard(g);
      const overlap = pc.w * 0.44;
      const meldW = pc.w + overlap * Math.max(0, p.count - 1);

      const below = region.y + region.h;
      const room = Math.max(0, play.y + play.h - below);
      // A small per-meld stagger so a meld landing while the previous
      // one is still fading doesn't sit exactly on top of it.
      const lane = (p.group ?? 0) % 3;
      const originX = region.x + region.w / 2 - meldW / 2 + pc.w / 2;
      const originY = below + Math.min(room / 2, pc.h * 0.7) + (lane - 1) * (pc.h * 0.16);

      const { x, y } = centred(originX + p.index * overlap, originY, g);
      return { x, y, rotate: 0, scale: tableScale * zs, z, opacity };
    }

    /* -------------------------------------------------- line */
    case "line": {
      // Position comes from the game, not from index/count — see
      // `boardCamera` above for why, and `Placement.cell` for the
      // contract. All this does is project it.
      if (!p.cell) {
        const { cx, cy } = boxCentre(g.zones.line);
        const { x, y } = centred(cx, cy, g);
        return { x, y, rotate: 0, scale: tableScale, z, opacity };
      }
      const cam = boardCamera(g, ctx?.board ?? null);
      const { cx, cy, rotate } = projectCell(p.cell, cam);
      const { x, y } = centred(cx, cy, g);
      return {
        x,
        y,
        rotate,
        // The drawn art's short side becomes exactly one board unit
        // (less the hairline), which is what makes contact exact.
        scale: (cam.unit * CONTACT_GAP) / art.w,
        z,
        opacity,
      };
    }

    /* ---------------------------------------------- boneyard */
    case "boneyard": {
      const zone = g.zones.boneyard;
      const { cx, cy } = boxCentre(zone);
      // Same capped stack as the deck: depth, not a fan of 14 tiles.
      const lift = Math.min(p.index, 8) * 0.45;
      const { x, y } = centred(cx + lift, cy - lift, g);
      return { x, y, rotate: 0, scale: zone.w / art.w, z, opacity };
    }

    /* -------------------------------------------------- hand */
    case "hand": {
      const seatId: SeatId = p.seat ?? HERO;
      // Whose hand gets the big bottom strip. Online this is not seat 0,
      // and for a spectator it is nobody — every hand is an opponent's.
      const viewerSeat = g.viewerSeat;
      // Cards overlap in a fanned arc, which is how you hold cards.
      // Dominoes do not fan — you stand them in a rack, edge to edge and
      // upright — so a tile hand is a flat, evenly spaced row.
      const isTile = ctx?.kind === "tile";

      if (viewerSeat !== null && seatId === viewerSeat) {
        // The boneyard shares this strip (see geometry's `boneyard`), so
        // a tile hand keeps clear of it. Card games have no such pile
        // and keep the full width.
        //
        // The reserved space comes off BOTH sides, not just the left
        // where the boneyard actually sits — shifting `within.x` alone
        // (the first version of this) shrank the box from one edge
        // only, which drags its centre off the true hand-zone centre by
        // half the reservation. The hand has to stay centred on the
        // zone regardless of what's parked beside it; a matching phantom
        // margin on the right is the price of that, and it's cheap.
        // `heroFan` is that answer, shared with the pan's range.
        const fan = heroFan(g, isTile);
        // The hand as DRAWN — smaller than the base box on a laptop, where the
        // board may outgrow it (see `baseSize`).
        const ha = handArt(g, ctx?.kind);
        // A bleeding hand (short screens — see `TableGeometry.handBleed`)
        // hangs from the strip's TOP edge, below the room a picked-up card
        // lifts into, and runs off the bottom of the screen: the strip is
        // shorter than a card on purpose, and centring the card in it would
        // push its index up under the band instead.
        const within: Box = {
          ...fan.within,
          ...(g.handBleed ? { y: g.zones.hand.y + HAND_LIFT_ROOM, h: ha.h } : {}),
        };
        // A hand that has just swallowed six cards off the discard pile
        // needs the same compress-then-pan treatment the pile itself
        // does, and for the same reason — past a point, tighter is not
        // more readable, it is less. Opt-in: a game that never threads
        // `handScroll` in gets no floor and behaves exactly as before.
        // A domino rack too, since the draw game's hand can outgrow a phone.
        const panned = ctx?.handScroll !== undefined;
        // ONE index drives both the fan position and the stacking order.
        //
        // Splitting them is what produced a card sitting visually
        // between its neighbours while painting behind both of them: a
        // fan overlaps, so which card is on top has to follow the order
        // the eye reads left to right. Taking the sorted index for
        // position and the placement's own for `z` guarantees they
        // disagree the moment a sort is anything but the deal order.
        const handIndex = ctx?.handIndex ?? p.index;
        const slot = fanSlot({
          index: handIndex,
          count: p.count,
          within,
          size: ha,
          maxRotation: isTile ? 0 : undefined,
          arcLift: isTile ? 0 : undefined,
          maxGap: fan.maxGap,
          minGap: panned ? ha.w * (ctx!.handFloor ?? MIN_HAND_GAP_FRACTION) : undefined,
          pan: panned ? ctx!.handScroll : undefined,
        });
        // Lifted within the hand's own strip, never out of it: a tile stands
        // taller in the strip than a card, and a full 18px carried a picked-up
        // domino over the band above the hand — over "Tap where it goes".
        const room = Math.max(0, slot.y - ha.h / 2 - g.zones.hand.y);
        const lift = p.selected ? -Math.min(18, room) : 0;
        return {
          x: slot.x - base.w / 2,
          y: slot.y - base.h / 2 + lift,
          rotate: slot.rotation,
          scale: ha.w / art.w,
          // Selection does NOT change the stacking order. A fan overlaps,
          // so which card paints over which has to follow the order the
          // eye reads along the fan — full stop, in every state. Lifting a
          // selected card to `Z_SELECTED` made it jump in front of its
          // right-hand neighbours, so picking cards for a meld visibly
          // reshuffled the hand's depth as you went. The -18px lift and
          // the ring already say "selected" without touching z.
          z: Z_HERO_HAND + handIndex,
          // Same edge fade the discard fan uses, for the same reason —
          // a panned hand overruns its zone too, and the cards it pushes
          // out slide off the screen edges. Gated on `panned` so an
          // unfloored fan (every other game) is untouched, including by
          // float residue at the exact boundary.
          opacity: panned ? opacity * slot.visible : opacity,
        };
      }

      // Opponent hands sit just inside their pod, pulled toward the
      // centre of the table so they never hang off the edge.
      const seat = slotForSeat(g, seatId);
      if (!seat) return { x: 0, y: 0, rotate: 0, scale: miniScale, z, opacity };

      // On a phone an opponent's hand is texture behind their pod, or — face
      // up at a showdown — something to read over it. See `tuckedHand`.
      if (g.tuck) {
        return p.faceUp
          ? shownHand(g, seat, p, ctx?.kind, opacity)
          : tuckedHand(g, seat, p, ctx?.kind, opacity);
      }

      const miniW = miniArt(g, ctx?.kind);
      const miniH = isTile ? miniW * 2 : g.miniCard.h;

      const { cx: pcx, cy: pcy } = boxCentre(g.zones.play);
      const dx = pcx - seat.x;
      const dy = pcy - seat.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;

      // A fixed 2.4x width reads fine for LRC's mini hands (2-4 cards)
      // but a domino hand runs up to 7 tiles, and a FIXED box just
      // packed them tighter as the hand grew — `fanSlot`'s own gap
      // formula (`usable / (count - 1)`) has no choice but to compress
      // once the box can't grow with the count, and `maxGap` below never
      // gets a chance to matter. Scaling with `p.count` gives a big hand
      // the room a fixed box can't, while the floor keeps a small hand
      // (LRC, or dominoes early in a round) exactly as it was.
      const fanW = miniW * Math.max(2.4, p.count * 0.9);
      const pod = POD_SIZE[g.density];

      if (isTile) {
        // TOP stands its rack upright, unrotated, fanned along screen-x
        // — a plain, AXIS-ALIGNED clearance derived straight from the
        // seat's own `anchor`, deliberately never a scalar projected
        // through (ux, uy): that projection is exactly what caused two
        // bugs history (see the old note this replaced) — a seat's small
        // horizontal push component let the hand-width term leak into
        // the VERTICAL anchor too, so a fuller hand visibly sank lower.
        if (seat.anchor === "top") {
          const anchorX = seat.x;
          const anchorY = seat.y + (pod.h / 2 + miniH / 2 + TILE_HAND_GAP);
          const slot = fanSlot({
            index: p.index,
            count: p.count,
            within: { x: anchorX - fanW / 2, y: anchorY, w: fanW, h: 0 },
            size: { w: miniW, h: miniH },
            maxRotation: 0,
            arcLift: 0,
            maxGap: miniW * 0.7,
          });
          return {
            x: slot.x - base.w / 2,
            y: slot.y - base.h / 2,
            rotate: slot.rotation,
            scale: miniScale,
            z,
            opacity,
          };
        }

        // LEFT/RIGHT: stood on its SHORT side and stacked in a column
        // along the pod's own edge, rather than reaching straight out
        // from it — the redesign [[domino-side-seat-hand-overlap]]
        // tracked. `seat.rotation` (±90°) turns each tile so its long
        // side runs horizontal, sticking out from the pod by a FIXED
        // amount (one tile's own length) regardless of how many are in
        // the rack — exactly the "stop paying for the whole hand's
        // width, pay for one tile" fix TOP already got, applied to the
        // other axis. This is also why a long chain got so cramped on a
        // phone: `line`'s own clearance (geometry.ts's `sideReach`) used
        // to reserve room for the OLD reaching-outward rack and gave
        // most of the felt's width to two empty margins.
        //
        // Reused wholesale from the card branch below rather than
        // re-derived: a rotated piece's on-screen footprint swaps w/h
        // (`tileFootprint`), and `axisReach` is the same "how far does
        // this box reach along the push direction" helper the pod and a
        // card hand both already use.
        const tileFootprint: PieceSize = { w: miniH, h: miniW };
        const podReach = axisReach(ux, uy, pod);
        const tileReach = axisReach(ux, uy, tileFootprint);
        const inset = podReach + tileReach + TILE_HAND_GAP;
        const anchorX = seat.x + ux * inset;
        const anchorY = seat.y + uy * inset;

        const slot = radialFanSlot({
          anchor: { x: anchorX, y: anchorY },
          // Perpendicular to the push direction — a column, not a row.
          spread: { x: -uy, y: ux },
          away: { x: -ux, y: -uy },
          index: p.index,
          count: p.count,
          spreadWidth: Math.min(fanW, sideFanRoom(g, anchorY, miniH)),
          // Unrotated dimensions: `radialFanSlot` measures spacing along
          // `spread` from `size.w`, which for an upright tile is its
          // SHORT side — exactly "pack by the short side," the same
          // packing TOP's own horizontal row already does.
          size: { w: miniW, h: miniH },
          baseRotation: seat.rotation,
          maxTilt: 0,
          arcLift: 0,
          maxGap: miniW * 0.7,
        });

        return {
          x: slot.x - base.w / 2,
          y: slot.y - base.h / 2,
          rotate: slot.rotation,
          scale: miniScale,
          z,
          opacity,
        };
      }

      // Card hands fan PERPENDICULAR to this seat's own line to table
      // centre, not always along screen-x: a side seat's hand runs
      // top-to-bottom, the way a fan of cards looks held by someone sitting
      // to your left or right. Each one keeps to its own lane (`laneFor`),
      // so no hand ever runs onto another seat's cards or pod: three side
      // seats down a laptop's edge used to run into each other as their
      // hands grew (the user, 2026-10-31). See `fannedFrame` for where it
      // sits and how its cards stand.
      const lane = lanesFor(g, `fan|${ctx?.kind}`, (s) => fannedFrame(g, s, ctx?.kind)).get(seat.seat)!;
      const slot = laneSlot(lane, p.index, p.count);

      return {
        x: slot.x - base.w / 2,
        y: slot.y - base.h / 2,
        rotate: slot.rotation,
        scale: miniScale,
        z,
        opacity,
      };
    }

    /* --------------------------------------------- collected */
    case "collected": {
      const seat = p.seat !== undefined ? slotForSeat(g, p.seat) : undefined;
      if (!seat) return { x: 0, y: 0, rotate: 0, scale: miniScale, z, opacity };

      // A face-down won pile (Spades' tricks) says one number, and the pod
      // says it too ("Won 3"). Where hands are tucked it goes behind the pod
      // with them: the trick flies to its winner and settles out of sight.
      // A face-up pile — LRC's chips, which ARE that game's information —
      // stays on the felt below.
      if (g.tuck && !p.faceUp && !seat.isHero) {
        const { x, y } = centred(seat.x, seat.y, g);
        return { x, y, rotate: seat.rotation, scale: miniScale, z: Z_TUCKED_WON + p.index, opacity };
      }

      // A face-up pile: beside a SIDE pod on the rim (`rimPileSpot`), on the
      // felt toward the board everywhere else (`groundPileSpot`), as planned
      // for the whole table so no two meet (`planPiles`).
      const spot = pileSpot(g, seat, p.index, p.count, pilePlan(g, seat));
      const { x, y } = centred(spot.cx, spot.cy, g);
      return { x, y, rotate: 0, scale: miniScale, z, opacity };
    }

    /* --------------------------------------------- community */
    case "community": {
      // A fixed row of 5 slots — poker's community cards never overlap
      // and stay wherever they land once revealed, unlike every fanned
      // pile in this file. Laid left-to-right across the geometry box
      // `resolveTable` already sized to fit the play area.
      const zone = g.zones.community;
      const gap = g.card.w * 0.15 * zs;
      const minGap = g.card.w * 0.04 * zs;
      // When the box is narrower than 5 cards and their gaps — it is
      // bounded by the space between the seats' hands, which a phone or a
      // laptop can make tight — compress the GAP first, and only then
      // shrink the cards. Five cards that do not fit spill into a hand.
      let cardW = g.card.w * zs;
      let effGap = Math.max(minGap, Math.min(gap, (zone.w - cardW * 5) / 4));
      if (cardW * 5 + effGap * 4 > zone.w) {
        cardW = Math.max(0, (zone.w - minGap * 4) / 5);
        effGap = minGap;
      }
      const shrink = cardW / g.card.w;
      const rowW = cardW * 5 + effGap * 4;
      const originX = zone.x + zone.w / 2 - rowW / 2 + cardW / 2;
      const ccx = originX + p.index * (cardW + effGap);
      const ccy = zone.y + zone.h / 2;
      const { x, y } = centred(ccx, ccy, g);
      return { x, y, rotate: 0, scale: tableScale * shrink, z, opacity };
    }

    /* --------------------------------------------------- pot */
    case "pot": {
      // Poker's own decorative pot pile — see engine/types.ts's `ZoneId`
      // doc for why this is a separate zone from `center` rather than a
      // retune of it. Drawn at MINI scale (the same size `collected`'s
      // per-seat piles already use) so a growing pot never competes with
      // the community row for the same footprint a table-scaled chip
      // would.
      //
      // Grows DOWN from the zone's own top edge, not its centre — a
      // shallow pot (a chip or two) then sits flush against the gap
      // below the community row instead of floating mid-box, sized as if
      // for the deepest pot the table will ever show. Clamped to the
      // ZONE itself, not the whole play area: `geometry.ts` already sized
      // that zone to never overlap `community`, so keeping the pile
      // inside it is what keeps that guarantee true on screen too.
      const zone = g.zones.pot;
      const chipSize = g.miniCard.w * zs;
      const cols = 5;
      const col = p.index % cols;
      const row = Math.floor(p.index / cols);
      const colSpacing = chipSize * 0.8;
      const rowSpacing = chipSize * 0.85;
      const rowCount = Math.min(cols, p.count - row * cols);

      const cx = zone.x + zone.w / 2;
      const px = cx + (col - (rowCount - 1) / 2) * colSpacing;
      const py = zone.y + chipSize / 2 + row * rowSpacing;

      const clamped = clampToBox(px, py, zone, (g.miniCard.w * zs) / 2, (g.miniCard.h * zs) / 2);
      const { x, y } = centred(clamped.cx, clamped.cy, g);
      return { x, y, rotate: 0, scale: miniScale * zs, z, opacity };
    }

    /* --------------------------------------------------- stub */
    case "stub": {
      // Poker's own remaining-deck stub — see engine/types.ts's `ZoneId`
      // doc for why this is a separate zone from Rummy's `"deck"` rather
      // than a repositioning of it.
      const { cx, cy, tilt } = miniStackSlot(g.zones.stub, p.index);
      const { x, y } = centred(cx, cy, g);
      return { x, y, rotate: tilt, scale: miniScale * zs, z, opacity };
    }

    /* -------------------------------------------------- burnt */
    case "burnt": {
      // Poker's own burn-card pile — see engine/types.ts's `ZoneId` doc
      // for why this is a separate zone from Rummy's `"discard"`.
      const { cx, cy, tilt } = miniStackSlot(g.zones.burnt, p.index);
      const { x, y } = centred(cx, cy, g);
      return { x, y, rotate: tilt, scale: miniScale * zs, z, opacity };
    }

    /* -------------------------------------------------- pile */
    case "pile": {
      // BS's one central stack of played-but-unverified cards — see
      // engine/types.ts's `ZoneId` doc for why this is neither `"deck"`,
      // `"discard"` nor `"trick"`.
      const zone = g.zones.pile;
      const { cx, cy } = boxCentre(zone);
      // A deep stack reads as depth, not as 52 individually offset cards
      // — capped, the same way `deck` caps its own lift.
      const lift = Math.min(p.index, 12) * 0.45;
      // A small deterministic tilt makes a pile somebody threw cards at
      // rather than a machine-stacked block. Same recipe as `discard`.
      const tilt = ((p.index * 37) % 9) - 4;
      // The play that just landed is the only thing on this pile anyone
      // can act on, so it steps clear of the stack instead of
      // disappearing into it. Counted from the TOP rather than from a
      // group index, because the pile is deliberately ONE bucket: making
      // the live play its own `group` would restart `index`/`count`
      // inside it and take the stack's whole depth with it.
      const fromTop = p.count - 1 - p.index;
      const step = p.highlighted === true ? g.card.w * 0.17 * zs : 0;
      const { x, y } = centred(
        cx + lift + fromTop * step,
        cy - lift - fromTop * step * 0.4,
        g,
      );
      return { x, y, rotate: tilt, scale: tableScale * zs, z, opacity };
    }

    /* ------------------------------------------------ reveal */
    case "reveal": {
      // A ROW, not a stack: the entire point of a reveal is that every
      // challenged card is legible at once. Compresses the gap before the
      // cards, exactly as `community` does, and for the same reason —
      // `resolveTable` already clamped the box to the play area, so the
      // only thing left to give on a narrow phone is the spacing.
      const zone = g.zones.reveal;
      const cardW = g.card.w * zs;
      const gap = cardW * 0.16;
      const gaps = Math.max(0, p.count - 1);
      const totalW = cardW * p.count + gap * gaps;
      const effGap = gap * Math.min(1, zone.w / Math.max(1, totalW));
      const rowW = cardW * p.count + effGap * gaps;
      const originX = zone.x + zone.w / 2 - rowW / 2 + cardW / 2;
      const rcx = originX + p.index * (cardW + effGap);
      const rcy = zone.y + zone.h / 2;
      const { x, y } = centred(rcx, rcy, g);
      return { x, y, rotate: 0, scale: tableScale * zs, z, opacity };
    }

    /* ------------------------------------------------ centre */
    case "center": {
      // Same fanning problem and fix as `collected` above — every pot
      // chip used to render at the exact same point (not even a token
      // offset), so the whole pot looked like a single coin sitting on
      // top of wherever the dice overlay happened to be. Fans in a grid
      // that grows DOWN from the play area's centre, leaving the space
      // above center clear for a game's own centre-table overlay (LRC's
      // dice) to live without the two visually colliding.
      const { cx, cy } = boxCentre(g.zones.play);
      // Drawn at `potChip`, and piled at the overlap they always had.
      const chipSize = potChip(g);
      const cols = 5;
      const col = p.index % cols;
      const row = Math.floor(p.index / cols);
      const colSpacing = chipSize * 0.53;
      const rowSpacing = chipSize * 0.56;
      // Same partial-row centring as `collected` above — a pot of 2 or 3
      // chips (i.e. most of the game, until several rolls land on "C")
      // was centring against a 5-wide grid and landing skewed toward the
      // left columns instead of under the dice.
      const rowCount = Math.min(cols, p.count - row * cols);

      const x = cx + (col - (rowCount - 1) / 2) * colSpacing;
      const y = cy + chipSize * 0.6 + row * rowSpacing;

      // `collected` has always clamped to the viewport; this never did,
      // on the assumption the play area is large enough that a pot of
      // up to 3 chips per seat never reaches its edge. That held for the
      // sizes this shipped with, but is a real gap, not a rule — a
      // bigger `card` size (a wide-density bump) or a high seat count on
      // a short viewport can grow the grid past the box before the
      // count that would trigger it ever gets exercised by eye. Same
      // fix, same reasoning: real margins from the piece's own scaled
      // half-extents, not a guess — and `card`, not `miniCard`, because
      // this piece renders at `tableScale` (see the return below), the
      // one difference from `collected`'s otherwise identical clamp.
      // Margins from the chip's drawn box, which is card-shaped (taller than
      // the disc inside it).
      const clamped = clampToBox(x, y, g.box, chipSize / 2, (chipSize * art.h) / art.w / 2);
      const { x: fx, y: fy } = centred(clamped.cx, clamped.cy, g);
      return { x: fx, y: fy, rotate: 0, scale: chipSize / art.w, z, opacity };
    }

    /* --------------------------------------------- offscreen */
    default: {
      const { cx } = boxCentre(g.zones.play);
      const { x, y } = centred(cx, -g.handCard.h, g);
      return { x, y, rotate: 0, scale: tableScale, z, opacity: 0 };
    }
  }
}
