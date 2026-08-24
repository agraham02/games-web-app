/**
 * Per-viewer redaction — what a given seat is allowed to be TOLD, as
 * opposed to what they are shown.
 *
 * Offline this layer would be pointless: one human, one screen, and the
 * placement store holding every opponent's real cards face-down is
 * harmless because nothing can read it but the person it belongs to.
 * Online it is the whole ballgame. `placements(state, viewer)` already
 * decides correctly that seat 3's hand renders face-DOWN for seat 0 — but
 * it still keys those placements by their real ids, so shipping that map
 * over a socket hands seat 0 every card at the table. The requirement is
 * that hidden information is filtered before it is sent, not hidden in
 * the UI, and "rendered face-down" is exactly hiding it in the UI.
 *
 * The rule this module applies is deliberately blunt, because a subtle
 * one would eventually be got wrong: **a piece drawn face-down is a piece
 * whose identity the viewer does not get.** No exceptions, no per-game
 * opt-outs. That covers opponents' hands, the stock, the boneyard, burnt
 * cards and collected tricks in one stroke, and it covers Spades' blind
 * nil — where the viewer's OWN hand is face-down and must stay unreadable
 * to the person holding it — without knowing anything about Spades.
 *
 * It works because the per-viewer decision has already been made upstream.
 * `placements(state, viewer)` is the game saying "this is what seat N may
 * SEE"; this module only enforces "…and may therefore identify". That is
 * why nothing here takes a `viewer` argument.
 */

import type {
  GameEvent,
  PieceId,
  PieceMeta,
  Placement,
  PlacementMap,
} from "@/engine/types";

/**
 * Marks an id as standing in for something the viewer cannot resolve.
 *
 * `#` because no real piece id in this app contains one — cards are
 * `"S-A"`, tiles `"6-3"`, chips `"C-red"` — so a sentinel can never
 * collide with a genuine piece, and a stray one showing up somewhere it
 * should not is obvious on sight rather than silently plausible.
 */
const SENTINEL_PREFIX = "#";

export function isSentinel(id: PieceId): boolean {
  return id.startsWith(SENTINEL_PREFIX);
}

/**
 * A hidden piece's stand-in id, derived from the slot it occupies rather
 * than from the piece itself — which is the only option available, since
 * the whole point is that the viewer has no idea which piece that is.
 *
 * The consequence is that these ids are stable per SLOT, not per card: if
 * seat 3 plays their fifth tile, the sixth slides into slot five and
 * `#hand:3:-:5` now denotes a different physical tile. That is invisible
 * and therefore fine — every one of them is the same card back, and a fan
 * closing up by one is exactly what the real animation does anyway. What
 * matters is that the count and the positions stay right, and they do.
 */
function sentinelFor(p: Placement): PieceId {
  return `${SENTINEL_PREFIX}${p.zone}:${p.seat ?? "-"}:${p.group ?? "-"}:${p.index}`;
}

export interface RedactedPlacements {
  placements: PlacementMap;
  /**
   * Meta for the sentinels that appear in `placements`, to be merged over
   * the real piece meta on the client. `kind` is carried across from the
   * real piece because the piece layer picks its renderer from it — a
   * hidden domino must still be domino-shaped. `face` is deliberately
   * empty: a face-down piece renders its back and never reads it.
   */
  meta: Record<PieceId, PieceMeta>;
}

/**
 * Swaps every face-down placement's key for a slot-derived sentinel.
 *
 * Everything else about the placement is preserved verbatim — `index`,
 * `count`, `zone`, `seat`, `group` and the interaction flags — so the fan
 * spreads, the pile stacks and the layout comes out pixel-identical to
 * what the unredacted map would have produced. The viewer loses exactly
 * one thing: which card it is.
 */
export function redactPlacements(
  placements: PlacementMap,
  meta: Record<PieceId, PieceMeta>,
): RedactedPlacements {
  const out: PlacementMap = {};
  const sentinelMeta: Record<PieceId, PieceMeta> = {};

  for (const [id, placement] of Object.entries(placements)) {
    if (placement.faceUp) {
      out[id] = placement;
      continue;
    }
    const stand = sentinelFor(placement);
    out[stand] = placement;
    sentinelMeta[stand] = { kind: meta[id]?.kind ?? "card", face: "" };
  }

  return { placements: out, meta: sentinelMeta };
}

/**
 * How a piece should be named to this viewer across one batch.
 *
 * The subtle case, and the one that leaked: a piece with no placement
 * BEFORE the batch. "Not on the table yet, so nothing to conceal" sounds
 * right and is wrong — an opening deal is exactly that, and the card is
 * face-down in somebody else's hand the instant it lands. Poker showed it
 * plainly (its pre-deal state places no cards at all, so every hole card
 * went out under its real id) while Spades hid it, because Spades does
 * place its deck before dealing and so happened to take the safe branch.
 *
 * So visibility is judged over BOTH ends of the batch, not just the start.
 */
type Naming =
  /** Concealed throughout. Never the real id. */
  | { kind: "conceal"; id: PieceId }
  /** Concealed a moment ago, public now — needs an `unmask` in front. */
  | { kind: "reveal"; at: Placement }
  /** Public at both ends; the real id was never a secret. */
  | { kind: "public" };

function namingFor(piece: PieceId, before: PlacementMap, after: PlacementMap): Naming {
  const was = before[piece];
  const now = after[piece];
  const hiddenBefore = Boolean(was) && !was!.faceUp;
  const hiddenAfter = Boolean(now) && !now!.faceUp;

  if (hiddenBefore && !hiddenAfter) return { kind: "reveal", at: { ...was! } };
  if (hiddenBefore || hiddenAfter) {
    // Named by where it WAS when it already existed, so the stand-in the
    // viewer is looking at is the one that moves; by where it lands when
    // it is new to the table, which is the deal case.
    return { kind: "conceal", id: sentinelFor(hiddenBefore ? was! : now!) };
  }
  return { kind: "public" };
}

/** Every piece id an event names, for the generic rewrite below. */
function piecesOf(event: GameEvent): PieceId[] {
  switch (event.t) {
    case "deal":
    case "draw":
    case "play":
    case "move":
    case "flip":
    case "highlight":
      return [event.piece];
    case "collect":
    case "sweep":
      return event.pieces;
    case "slam":
      return [event.piece, ...event.shake];
    default:
      return [];
  }
}

function withPiece(event: GameEvent, map: (id: PieceId) => PieceId): GameEvent {
  switch (event.t) {
    case "deal":
    case "draw":
    case "play":
    case "move":
    case "flip":
    case "highlight":
      return { ...event, piece: map(event.piece) };
    case "collect":
    case "sweep":
      return { ...event, pieces: event.pieces.map(map) };
    case "slam":
      return { ...event, piece: map(event.piece), shake: event.shake.map(map) };
    default:
      return event;
  }
}

/**
 * Rewrites a batch of events into the ones a single viewer is allowed to
 * receive.
 *
 * Three cases, and the third is the whole reason this is not a one-liner:
 *
 *  1. A piece hidden before AND after (an opponent drawing a tile) has its
 *     id replaced by the sentinel throughout. The viewer sees a back move,
 *     which is exactly what happened.
 *  2. A piece visible throughout keeps its real id and is passed straight
 *     through.
 *  3. A piece that was hidden and is now REVEALED — an opponent playing
 *     from their hand — is the interesting one. The viewer's board holds a
 *     sentinel; the real piece has never existed on their client. Emitting
 *     the play alone would pop the card into being on the table instead of
 *     flying out of the hand it came from.
 *
 *     So an `unmask` rides immediately in front, putting the real piece at
 *     the position it is about to leave. `choreograph` gives it zero
 *     duration and zero offset, so it lands in the same frame and the play
 *     animates from the hand exactly as it does offline — the same trick
 *     `slam` already uses to ride in front of its own `move`. For one
 *     frame two identical backs overlap in that slot; the batch's own
 *     `reset(placements)` reconcile drops the spare, which is the
 *     self-correcting property this architecture already leans on.
 */
export function projectEvents(
  events: readonly GameEvent[],
  before: PlacementMap,
  after: PlacementMap,
): GameEvent[] {
  const out: GameEvent[] = [];

  for (const event of events) {
    // Announcements are prose the engine wrote about the table; they name
    // no pieces and are already public.
    for (const piece of piecesOf(event)) {
      const naming = namingFor(piece, before, after);
      if (naming.kind === "reveal") out.push({ t: "unmask", piece, at: naming.at });
    }

    out.push(
      withPiece(event, (id) => {
        const naming = namingFor(id, before, after);
        // A revealed piece travels under its real id — the `unmask` just
        // put that exact id on the board for it to move from.
        return naming.kind === "conceal" ? naming.id : id;
      }),
    );
  }

  return out;
}
