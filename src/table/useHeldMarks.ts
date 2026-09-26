"use client";

import { useEffect, useRef } from "react";
import type { PieceId, Placement } from "@/engine/types";
import { useTableStore } from "./store";

/** The flags a held piece can carry. */
type Marks = Partial<Pick<Placement, "selected" | "highlighted">>;

/**
 * Keeps the store's marks on held pieces in step with a list of held ids.
 *
 * The list is React state and the marks are store state, and the second
 * used to be written from inside the first's updater: `setHeld(prev =>
 * toggle(prev, id))` with the toggle patching the store. React may run an
 * updater while it renders, so that was a store write during somebody
 * else's render — React's "Cannot update a component (`Piece`) while
 * rendering a different component" — and in development an updater runs
 * twice. So the toggles are pure now, and this effect does the writing.
 *
 * It also puts the marks back after every batch (`resync`), because the
 * store is replaced wholesale when a batch settles and anything a game's
 * own `placements` does not re-derive is erased there. In BS a player can
 * be picking cards while an opponent's answers to a window arrive, and each
 * of those used to wipe the selection.
 */
export function useHeldMarks(held: readonly PieceId[], marks: Marks, resync: unknown): void {
  const shown = useRef<PieceId[]>([]);
  const key = held.join(",");
  const markKey = JSON.stringify(marks);

  useEffect(() => {
    const store = useTableStore.getState();
    const ids = key ? key.split(",") : [];
    const wanted: Marks = JSON.parse(markKey);
    const now = new Set(ids);

    const dropped = shown.current.filter((id) => !now.has(id) && store.placements[id]);
    if (dropped.length) {
      const off: Marks = {};
      for (const flag of Object.keys(wanted) as Array<keyof Marks>) off[flag] = false;
      store.patchMany(dropped, off);
    }

    const missing = ids.filter((id) => {
      const p = store.placements[id];
      return p && (Object.keys(wanted) as Array<keyof Marks>).some((f) => p[f] !== wanted[f]);
    });
    if (missing.length) store.patchMany(missing, wanted);

    shown.current = ids;
  }, [key, markKey, resync]);
}
