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
import type { Placement, PlacementMap, PieceId } from "@/engine/types";
import type { TableGeometry } from "./geometry";

export type PieceKind = "card" | "tile" | "chip";

export interface PieceMeta {
  kind: PieceKind;
  /** Face identity: card id, "6-3" for a tile, a colour for a chip. */
  face: string;
}

interface TableState {
  geometry: TableGeometry | null;
  placements: PlacementMap;
  meta: Record<PieceId, PieceMeta>;

  setGeometry(g: TableGeometry): void;
  /** Replaces the whole board — used on setup and on reconciliation. */
  reset(placements: PlacementMap, meta: Record<PieceId, PieceMeta>): void;
  setPlacement(id: PieceId, p: Placement): void;
  patch(id: PieceId, partial: Partial<Placement>): void;
  patchMany(ids: readonly PieceId[], partial: Partial<Placement>): void;
  /** Drops every transient visual flag. Cheap way to exit a mode. */
  clearFlags(): void;
}

export const useTableStore = create<TableState>((set) => ({
  geometry: null,
  placements: {},
  meta: {},

  setGeometry: (geometry) => set({ geometry }),

  reset: (placements, meta) => set({ placements, meta }),

  setPlacement: (id, p) =>
    set((s) => ({ placements: { ...s.placements, [id]: p } })),

  patch: (id, partial) =>
    set((s) => {
      const prev = s.placements[id];
      if (!prev) return s;
      return { placements: { ...s.placements, [id]: { ...prev, ...partial } } };
    }),

  patchMany: (ids, partial) =>
    set((s) => {
      if (ids.length === 0) return s;
      const next = { ...s.placements };
      for (const id of ids) {
        const prev = next[id];
        if (prev) next[id] = { ...prev, ...partial };
      }
      return { placements: next };
    }),

  clearFlags: () =>
    set((s) => {
      const next: PlacementMap = {};
      let changed = false;
      for (const [id, p] of Object.entries(s.placements)) {
        if (p.selected || p.highlighted || p.dimmed || p.fanned) {
          const { selected, highlighted, dimmed, fanned, ...rest } = p;
          void selected;
          void highlighted;
          void dimmed;
          void fanned;
          next[id] = rest;
          changed = true;
        } else {
          // Preserve identity so untouched pieces do not re-render.
          next[id] = p;
        }
      }
      return changed ? { placements: next } : s;
    }),
}));

/* ============================================================
   Selectors — keep these narrow.
   ============================================================ */

export const useGeometry = () => useTableStore((s) => s.geometry);

/** The only subscription a <Piece> makes. */
export const usePlacement = (id: PieceId) =>
  useTableStore((s) => s.placements[id]);

export const usePieceMeta = (id: PieceId) => useTableStore((s) => s.meta[id]);

/**
 * Piece ids change only when the board is reset, but `Object.keys`
 * allocates a fresh array every call — without a shallow comparator
 * that is an infinite render loop.
 */
export const usePieceIds = () =>
  useTableStore(useShallow((s) => Object.keys(s.placements)));
