"use client";

/**
 * GameEvent -> placement store.
 *
 * The one subtlety here is reindexing. A placement carries `index` and
 * `count` because the fan maths needs them, which means moving one card
 * out of a 13-card hand changes the other twelve. `reindex` recomputes
 * those — but returns the SAME object for any piece whose numbers did
 * not actually change, so the narrow per-piece subscriptions in the
 * store still hold and only genuinely affected cards re-render.
 */

import type {
  GameEvent,
  Placement,
  PlacementMap,
  PieceId,
  SeatId,
  ZoneId,
} from "@/engine/types";
import { useTableStore } from "./store";

/** Pieces sharing a bucket are indexed and fanned together. */
function bucketKey(p: Placement): string {
  return `${p.zone}|${p.seat ?? "-"}|${p.group ?? "-"}`;
}

/** Sentinel that sorts a newly-added piece to the end of its bucket. */
const APPEND = Number.MAX_SAFE_INTEGER;

export function reindex(map: PlacementMap): PlacementMap {
  const buckets = new Map<string, PieceId[]>();

  for (const [id, p] of Object.entries(map)) {
    const key = bucketKey(p);
    const list = buckets.get(key);
    if (list) list.push(id);
    else buckets.set(key, [id]);
  }

  const next: PlacementMap = {};
  let changed = false;

  for (const ids of buckets.values()) {
    ids.sort((a, b) => map[a]!.index - map[b]!.index);
    const count = ids.length;

    ids.forEach((id, index) => {
      const prev = map[id]!;
      if (prev.index === index && prev.count === count) {
        next[id] = prev; // identity preserved -> no re-render
      } else {
        next[id] = { ...prev, index, count };
        changed = true;
      }
    });
  }

  return changed ? next : map;
}

function moveTo(
  map: PlacementMap,
  id: PieceId,
  target: { zone: ZoneId; seat?: SeatId; group?: number; faceUp?: boolean },
): void {
  const prev = map[id];
  if (!prev) return;
  map[id] = {
    ...prev,
    zone: target.zone,
    seat: target.seat,
    group: target.group,
    faceUp: target.faceUp ?? prev.faceUp,
    index: APPEND,
    // Flags are per-interaction; a piece that moves has left its mode.
    selected: false,
    highlighted: false,
    dimmed: false,
    fanned: false,
  };
}

/**
 * Applies one event. Visual-only events (announce, phase, score) are
 * ignored here — they are handled by the phase/toast layers.
 */
export function applyEventToTable(event: GameEvent): void {
  const { placements, reset, meta } = useTableStore.getState();
  const map: PlacementMap = { ...placements };
  let touched = false;

  switch (event.t) {
    case "deal":
      moveTo(map, event.piece, {
        zone: "hand",
        seat: event.to,
        faceUp: event.faceUp,
      });
      touched = true;
      break;

    case "draw":
      moveTo(map, event.piece, {
        zone: "hand",
        seat: event.to,
        faceUp: event.faceUp,
      });
      touched = true;
      break;

    case "play":
      moveTo(map, event.piece, {
        zone: event.to,
        // Kept so the trick can offset each card toward whoever played it.
        seat: event.from,
        group: event.group,
        faceUp: true,
      });
      touched = true;
      break;

    case "collect":
      for (const piece of event.pieces) {
        moveTo(map, piece, { zone: "collected", seat: event.to, faceUp: false });
      }
      touched = true;
      break;

    case "sweep":
      for (const piece of event.pieces) {
        moveTo(map, piece, { zone: event.to, faceUp: false });
      }
      touched = true;
      break;

    case "move":
      if (map[event.piece]) {
        map[event.piece] = { ...map[event.piece]!, ...event.to };
        touched = true;
      }
      break;

    case "flip":
      if (map[event.piece]) {
        map[event.piece] = { ...map[event.piece]!, faceUp: event.faceUp };
        touched = true;
      }
      break;

    default:
      return;
  }

  if (touched) reset(reindex(map), meta);
}
