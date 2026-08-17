"use client";

/**
 * Table state that the piece layer reads.
 *
 * Why a store rather than React context: a 52-card deal touches one
 * placement at a time, and with context every card re-renders on every
 * change — 52 x 52 renders for one deal. Here each <Piece> subscribes to
 * `placements[id]` alone, so moving one card re-renders exactly one
 * component.
 *
 * That only holds if updates preserve the object identity of untouched
 * placements, which every setter below is careful to do.
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Placement, PlacementMap, PieceId, PieceMeta } from "@/engine/types";
import { cellHalfExtent, type BoardView, type TableGeometry } from "./geometry";

// Re-exported for existing call sites — the types themselves live in
// engine/types.ts now, since every GameDefinition needs to describe its
// pieces regardless of the React layer's own caching.
export type { PieceKind, PieceMeta } from "@/engine/types";
export type { BoardView } from "./geometry";

export type BoardCell = NonNullable<Placement["cell"]>;

interface TableState {
  geometry: TableGeometry | null;
  placements: PlacementMap;
  meta: Record<PieceId, PieceMeta>;
  /**
   * Bounding box of every piece with a `cell`, plus any preview ghosts.
   * Derived, not authored — it is what the board camera fits to the
   * screen (see `boardCamera` in layout.ts).
   *
   * It has to be derived HERE rather than inside `layoutPiece` because
   * a camera is inherently a fact about the whole chain, and layout is
   * deliberately O(1) per piece with no sibling access. Recomputing it
   * on each write is O(pieces) — irrelevant next to the React work this
   * store exists to avoid, and it keeps the camera exactly in step with
   * the placements it is fitting, including mid-animation.
   */
  board: BoardView | null;
  /**
   * Where a piece the player is currently holding WOULD land. Folded
   * into `board` so picking up a tile eases the camera out just enough
   * to make room for it, and the real piece then lands precisely on its
   * own ghost instead of shunting the view a second time.
   */
  ghosts: readonly BoardCell[];
  /**
   * Index within the hero's own hand currently under the pointer, or
   * `null`. Lives here rather than as component-local state because the
   * lift effect (PieceLayer's `Piece`) needs to react to a NEIGHBOR
   * being hovered, not just itself — a shared, narrowly-subscribed value
   * is what lets "the hovered card and its 1-2 neighbours lift" work
   * without every hand piece re-rendering on every pointer move (only
   * the hero's own ~13 hand pieces subscribe to this at all; see
   * `useHeroHoverIndex`).
   */
  heroHoverIndex: number | null;
  /**
   * Mirrors `GameRuntime.isHeroTurn` — GameHost syncs it in on every
   * change. Lives here, not as a prop threaded through PieceLayer,
   * because the piece that needs it (a hero-hand card, in ANY game) is
   * several component layers below where the runtime lives, and a
   * shared store is what the hover-index work above already established
   * as this app's answer to "ambient table-wide fact every hand piece
   * needs, cheaply." Defaults true so a game with no turn concept yet
   * wired up (nothing currently) never dims anything by omission.
   */
  heroTurnActive: boolean;
  /**
   * Pan offset, in px, of the discard pile's own fan — how far it has
   * been dragged past what fits. See geometry.ts's compress-then-pan
   * note: a fan compresses only down to a floor, and everything past
   * that floor becomes a pannable range rather than ever-thinner
   * slivers. Lives here, not on the pile's component, for exactly the
   * reason `heroHoverIndex` does — the things that need it are
   * individual `<Piece>`s several layers down, and only they subscribe
   * (see `useDiscardScroll`).
   */
  /**
   * `null` means THIS GAME DOES NOT PAN ITS DISCARD PILE, which is not
   * the same as "pans, currently at 0". Every game but Rummy leaves it
   * null and keeps the plain fan it always had; the distinction is what
   * makes compress-then-pan strictly opt-in rather than something every
   * existing pile silently inherits.
   */
  discardScroll: number | null;
  /**
   * How many pieces are currently in the discard zone. Derived on every
   * placements commit, exactly like `board` — never authored.
   *
   * It exists because the DECK piece needs it and has no other way to
   * see it: layout is deliberately O(1) per piece with no sibling
   * access, and in LANDSCAPE the deck slides aside as the discard fan
   * grows into the space it shares (see layout.ts's "deck" case). That
   * is one specific, narrow cross-zone fact, so it gets one narrow
   * field rather than a general "broadcast every zone's count".
   */
  discardCount: number;
  /** The hero hand's own pan offset. Same null convention as above. */
  handScroll: number | null;
  /**
   * Display order override for the hero's hand: piece id -> position.
   * `null` means "use the placement's own index", which is every game
   * but Rummy.
   *
   * A view concern, deliberately NOT engine state: how you like your
   * cards arranged has no bearing on the rules, replays should not
   * depend on it, and a player must be able to re-sort while a bot is
   * thinking — which an action routed through the turn loop could not
   * allow.
   */
  handOrder: Record<PieceId, number> | null;

  setGeometry(g: TableGeometry): void;
  /** Replaces the whole board — used on setup and on reconciliation. */
  reset(placements: PlacementMap, meta: Record<PieceId, PieceMeta>): void;
  setPlacement(id: PieceId, p: Placement): void;
  patch(id: PieceId, partial: Partial<Placement>): void;
  patchMany(ids: readonly PieceId[], partial: Partial<Placement>): void;
  setGhosts(cells: readonly BoardCell[]): void;
  /** Drops every transient visual flag. Cheap way to exit a mode. */
  clearFlags(): void;
  setHeroHoverIndex(index: number | null): void;
  setHeroTurnActive(active: boolean): void;
  setDiscardScroll(px: number | null): void;
  setHandScroll(px: number | null): void;
  setHandOrder(order: Record<PieceId, number> | null): void;
}

function countInZone(placements: PlacementMap, zone: Placement["zone"]): number {
  let n = 0;
  for (const p of Object.values(placements)) if (p.zone === zone) n += 1;
  return n;
}

function boundsOf(
  placements: PlacementMap,
  ghosts: readonly BoardCell[],
  prev: BoardView | null,
): BoardView | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const extend = (cell: BoardCell) => {
    const { hw, hh } = cellHalfExtent(cell.rot);
    if (cell.x - hw < minX) minX = cell.x - hw;
    if (cell.y - hh < minY) minY = cell.y - hh;
    if (cell.x + hw > maxX) maxX = cell.x + hw;
    if (cell.y + hh > maxY) maxY = cell.y + hh;
  };

  for (const p of Object.values(placements)) if (p.cell) extend(p.cell);
  for (const cell of ghosts) extend(cell);

  if (minX === Infinity) return null;
  // Identity is preserved when nothing actually moved, so a piece that
  // subscribes to the camera does not re-render on an unrelated change.
  if (
    prev &&
    prev.minX === minX &&
    prev.minY === minY &&
    prev.maxX === maxX &&
    prev.maxY === maxY
  ) {
    return prev;
  }
  return { minX, minY, maxX, maxY };
}

export const useTableStore = create<TableState>((set) => {
  /** Every placement write goes through this so `board` can never drift
   * out of step with what is actually on the table. */
  const commit = (s: TableState, placements: PlacementMap) => ({
    placements,
    board: boundsOf(placements, s.ghosts, s.board),
    discardCount: countInZone(placements, "discard"),
  });

  return {
    geometry: null,
    placements: {},
    meta: {},
    board: null,
    ghosts: [],
    heroHoverIndex: null,
    heroTurnActive: true,
    discardScroll: null,
    discardCount: 0,
    handScroll: null,
    handOrder: null,

    setGeometry: (geometry) => set({ geometry }),

    reset: (placements, meta) =>
      set((s) => ({ meta, ...commit(s, placements) })),

    setPlacement: (id, p) =>
      set((s) => commit(s, { ...s.placements, [id]: p })),

    patch: (id, partial) =>
      set((s) => {
        const prev = s.placements[id];
        if (!prev) return s;
        return commit(s, { ...s.placements, [id]: { ...prev, ...partial } });
      }),

    patchMany: (ids, partial) =>
      set((s) => {
        if (ids.length === 0) return s;
        const next = { ...s.placements };
        for (const id of ids) {
          const prev = next[id];
          if (prev) next[id] = { ...prev, ...partial };
        }
        return commit(s, next);
      }),

    setGhosts: (cells) =>
      set((s) => {
        if (s.ghosts.length === 0 && cells.length === 0) return s;
        return {
          ghosts: cells,
          board: boundsOf(s.placements, cells, s.board),
        };
      }),

    clearFlags: () =>
      set((s) => {
        const next: PlacementMap = {};
        let changed = false;
        for (const [id, p] of Object.entries(s.placements)) {
          if (
            p.selected ||
            p.highlighted ||
            p.tappable ||
            p.dimmed ||
            p.fanned ||
            p.hidden ||
            p.motionDelayMs
          ) {
            const {
              selected,
              highlighted,
              tappable,
              dimmed,
              fanned,
              hidden,
              motionDelayMs,
              ...rest
            } = p;
            void selected;
            void highlighted;
            void tappable;
            void dimmed;
            void fanned;
            void hidden;
            void motionDelayMs;
            next[id] = rest;
            changed = true;
          } else {
            // Preserve identity so untouched pieces do not re-render.
            next[id] = p;
          }
        }
        // `cell` is structural, not a per-interaction flag, so it
        // survives this and the camera does not move.
        return changed ? { placements: next } : s;
      }),

    setHeroHoverIndex: (index) =>
      set((s) => (s.heroHoverIndex === index ? s : { heroHoverIndex: index })),

    setHeroTurnActive: (active) =>
      set((s) => (s.heroTurnActive === active ? s : { heroTurnActive: active })),

    setDiscardScroll: (px) =>
      set((s) => (s.discardScroll === px ? s : { discardScroll: px })),

    setHandScroll: (px) => set((s) => (s.handScroll === px ? s : { handScroll: px })),

    setHandOrder: (order) => set({ handOrder: order }),
  };
});

/* ============================================================
   Selectors — keep these narrow.
   ============================================================ */

export const useGeometry = () => useTableStore((s) => s.geometry);

/** The only subscription a <Piece> makes. */
export const usePlacement = (id: PieceId) =>
  useTableStore((s) => s.placements[id]);

export const usePieceMeta = (id: PieceId) => useTableStore((s) => s.meta[id]);

/**
 * The board camera's extent. Takes `enabled` rather than being read
 * unconditionally because this value changes every time the chain grows:
 * a piece that is not laid in board space must not re-render for it, and
 * passing `false` gives it a stable `null` instead.
 */
export const useBoardView = (enabled: boolean): BoardView | null =>
  useTableStore((s) => (enabled ? s.board : null));

/**
 * Piece ids change only when the board is reset, but `Object.keys`
 * allocates a fresh array every call — without a shallow comparator
 * that is an infinite render loop.
 */
export const usePieceIds = () =>
  useTableStore(useShallow((s) => Object.keys(s.placements)));

/**
 * See `TableState.heroHoverIndex`'s doc. Takes `enabled` for the same
 * reason `useBoardView` does: a piece that isn't in the hero's own hand
 * has no use for this value, and always selecting `null` for it means
 * the selector's RESULT never changes for that piece regardless of how
 * often the real hover index does — so it never re-renders for it. Only
 * the hero's own ~13 hand pieces ever actually subscribe.
 */
export const useHeroHoverIndex = (enabled: boolean) =>
  useTableStore((s) => (enabled ? s.heroHoverIndex : null));
export const useSetHeroHoverIndex = () => useTableStore((s) => s.setHeroHoverIndex);

/**
 * See `TableState.heroTurnActive`'s doc. Same enabled-gated-selector
 * trick as `useHeroHoverIndex` — a piece that isn't in the hero's own
 * hand selects a constant `true` (never dims/shrinks it, never
 * re-renders it when the real value changes).
 */
export const useHeroTurnActive = (enabled: boolean) =>
  useTableStore((s) => (enabled ? s.heroTurnActive : true));

/**
 * Pan/count slices, all on the same enabled-gated pattern as the two
 * above — a piece that isn't in the relevant zone selects a constant and
 * therefore never re-renders when the real value changes. That matters
 * more here than anywhere else in this file: a pan updates on every
 * pointermove, so an ungated subscription would re-render all 52 pieces
 * per frame of a drag, which is precisely what this store exists to
 * prevent.
 */
export const useDiscardScroll = (enabled: boolean) =>
  useTableStore((s) => (enabled ? s.discardScroll : null));
export const useSetDiscardScroll = () => useTableStore((s) => s.setDiscardScroll);

/**
 * Whether this game pans its discard pile at all — a BOOLEAN derived
 * from the pan value rather than the value itself, which is the whole
 * point: the deck piece needs to know that panning is in play, but must
 * not re-render on every frame of an actual pan. Selecting `!== null`
 * gives a result that only ever changes when a game opts in or out.
 */
export const useDiscardPanEnabled = () =>
  useTableStore((s) => s.discardScroll !== null);

/** Only the DECK piece needs this — see `TableState.discardCount`. */
export const useDiscardCount = (enabled: boolean) =>
  useTableStore((s) => (enabled ? s.discardCount : 0));

export const useHandScroll = (enabled: boolean) =>
  useTableStore((s) => (enabled ? s.handScroll : null));
export const useSetHandScroll = () => useTableStore((s) => s.setHandScroll);

export const useHandOrder = (enabled: boolean) =>
  useTableStore((s) => (enabled ? s.handOrder : null));
export const useSetHandOrder = () => useTableStore((s) => s.setHandOrder);
