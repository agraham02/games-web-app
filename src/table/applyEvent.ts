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
import { STAGGER } from "@/motion/presets";
import { useTableStore } from "./store";

/**
 * Pieces sharing a bucket are indexed and fanned together — EXCEPT a
 * `hidden` one, which gets its own solo bucket instead. A hidden piece
 * is functionally gone (faded to invisible), so it must not keep
 * inflating the count/index its still-visible zone-mates lay themselves
 * out from. Without this, a zone nothing ever clears mid-round (Spades'
 * `collected`: every trick a seat has ever won stays tracked there,
 * fading to `hidden` but never leaving the bucket until the round's own
 * end-of-round sweep) keeps growing all round long — so `layoutPiece`'s
 * "collected" grid packed each new trick's cards a little further out
 * than the last, even though every earlier trick was already invisible.
 * A solo, id-keyed bucket removes it from that shared math without
 * moving it to a different zone or dropping it from the map outright
 * (which would skip its own fade — see `moveTo`'s doc below).
 */
function bucketKey(p: Placement, id: PieceId): string {
  if (p.hidden) return `hidden|${id}`;
  return `${p.zone}|${p.seat ?? "-"}|${p.group ?? "-"}`;
}

/** Sentinel that sorts a newly-added piece to the end of its bucket. */
const APPEND = Number.MAX_SAFE_INTEGER;

export function reindex(map: PlacementMap): PlacementMap {
  const buckets = new Map<string, PieceId[]>();

  for (const [id, p] of Object.entries(map)) {
    const key = bucketKey(p, id);
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
  target: {
    zone: ZoneId;
    seat?: SeatId;
    group?: number;
    faceUp?: boolean;
    /** See Placement.motionDelayMs. Omitted (0) by every caller except
     * collect/sweep below — that omission is what makes it "consumed
     * once": an ordinary deal/draw/play/flip on this same piece next
     * resets it to undefined. */
    motionDelayMs?: number;
  },
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
    motionDelayMs: target.motionDelayMs,
    // Flags are per-interaction; a piece that moves has left its mode.
    selected: false,
    highlighted: false,
    tappable: false,
    dimmed: false,
    fanned: false,
    hidden: false,
    // Ownership marks belong to the piece's PLACE, not the piece. A card
    // swept off a board meld back into the deck is nobody's any more,
    // and carrying its old owner chip through the shuffle is a visible
    // leftover from a round that has ended.
    ownerTag: undefined,
    accentColour: undefined,
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
      // Staggers inward: each card in the batch gets a slightly later
      // delay than the last, capped at 10 — matching `choreograph`'s own
      // `Math.min(pieces.length, 10)` duration cap exactly, so the
      // visual stagger and the queue-duration budget it reserves agree.
      event.pieces.forEach((piece, i) => {
        moveTo(map, piece, {
          zone: "collected",
          seat: event.to,
          faceUp: false,
          motionDelayMs: Math.min(i, 10) * STAGGER.collect * 1000,
        });
      });
      touched = true;
      break;

    case "sweep":
      event.pieces.forEach((piece, i) => {
        moveTo(map, piece, {
          zone: event.to,
          faceUp: false,
          motionDelayMs: Math.min(i, 10) * STAGGER.sweep * 1000,
        });
      });
      touched = true;
      break;

    case "move":
      if (map[event.piece]) {
        // `event.to` is a caller-built Placement (see Dominoes'
        // `linePlacement`) that generally won't think to mention
        // `motionDelayMs` at all — spreading it over the previous
        // placement would otherwise leave a stale delay from an earlier
        // collect/sweep batch on this same piece id. Cleared explicitly
        // unless the caller deliberately wants one.
        map[event.piece] = { ...map[event.piece]!, motionDelayMs: undefined, ...event.to };
        touched = true;
      }
      break;

    case "flip":
      if (map[event.piece]) {
        // Same reasoning as `move` above — a flip is not a fresh
        // staggered arrival, so any leftover delay from a prior
        // collect/sweep on this piece must not carry over.
        map[event.piece] = { ...map[event.piece]!, faceUp: event.faceUp, motionDelayMs: undefined };
        touched = true;
      }
      break;

    case "highlight":
      if (map[event.piece]) {
        map[event.piece] = { ...map[event.piece]!, highlighted: event.on };
        touched = true;
      }
      break;

    default:
      return;
  }

  if (touched) reset(reindex(map), meta);
}
