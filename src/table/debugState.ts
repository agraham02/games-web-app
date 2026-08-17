/**
 * Finds the "piles of pieces" inside an arbitrary game state, so the dev
 * panel can edit them without knowing anything about any game.
 *
 * Rules-legal play makes it slow and awkward to reach the states that
 * actually stress the table layer — a 20-card hand, a 30-card discard
 * pile, a board with a dozen melds. You either grind out real turns or
 * hand-edit engine state, and hand-editing twenty card-id strings is
 * exactly the friction this removes.
 *
 * The trick that makes it game-agnostic: a game already declares its
 * complete, fixed piece vocabulary (`GameDefinition.pieces`). Any array
 * of strings drawn entirely from that vocabulary is a pile of pieces;
 * anything else is incidental data. No per-game code, ever — a game
 * that does not exist yet gets this for free.
 *
 * Deliberately arrays only. A `Record<PieceId, X>` "where is it" map
 * (Rummy's own `hitBy`, dominoes' placed-tile chain) is left alone: it
 * carries structure this tool cannot infer, and mangling it would
 * produce a state the engine rejects. Those stay a job for reading the
 * state directly. Per the brief, this stops once "move a piece between
 * piles" and "fill a pile to N" work.
 */

import type { PieceId } from "@/engine/types";

export interface Pile {
  /** Dotted path into the state object — "hands.0", "stock", "melds.2.cards". */
  path: string;
  /** Human label derived from the path — "hands / 0". */
  label: string;
  ids: PieceId[];
}

type Unknown = Record<string, unknown>;

function isPlainObject(v: unknown): v is Unknown {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every array of known piece ids, anywhere in the state tree. */
export function findPiles(state: unknown, vocabulary: ReadonlySet<PieceId>): Pile[] {
  const confirmed: Pile[] = [];
  const empties: Array<{ path: string; parent: string }> = [];

  const walk = (node: unknown, path: string, parent: string, depth: number) => {
    if (depth > 6) return;

    if (Array.isArray(node)) {
      if (node.length === 0) {
        // An empty array is ambiguous — an emptied hand looks exactly
        // like a `melds: []`. Resolved below by whether a SIBLING under
        // the same parent turned out to be a real pile.
        empties.push({ path, parent });
        return;
      }
      if (node.every((v) => typeof v === "string" && vocabulary.has(v))) {
        confirmed.push({ path, label: labelOf(path), ids: node as PieceId[] });
        return;
      }
      // Not a pile itself, but may contain them (melds -> meld.cards).
      node.forEach((v, i) => walk(v, `${path}.${i}`, path, depth + 1));
      return;
    }

    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k, path, depth + 1);
      }
    }
  };

  walk(state, "", "", 0);

  const parentsWithPiles = new Set(
    confirmed.map((p) => p.path.split(".").slice(0, -1).join(".")),
  );
  for (const e of empties) {
    if (parentsWithPiles.has(e.parent)) {
      confirmed.push({ path: e.path, label: labelOf(e.path), ids: [] });
    }
  }

  return confirmed.sort((a, b) => a.path.localeCompare(b.path));
}

function labelOf(path: string): string {
  return path.split(".").join(" / ");
}

function getAtPath(state: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (Array.isArray(node)) return node[Number(key)];
    if (isPlainObject(node)) return node[key];
    return undefined;
  }, state);
}

/** Immutable set-by-path — clones only the spine, like every store write here. */
function setAtPath<T>(state: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const write = (node: unknown, i: number): unknown => {
    const key = keys[i]!;
    if (i === keys.length - 1) {
      if (Array.isArray(node)) {
        const next = [...node];
        next[Number(key)] = value;
        return next;
      }
      return { ...(node as Unknown), [key]: value };
    }
    if (Array.isArray(node)) {
      const next = [...node];
      next[Number(key)] = write(node[Number(key)], i + 1);
      return next;
    }
    const obj = node as Unknown;
    return { ...obj, [key]: write(obj[key], i + 1) };
  };
  return write(state, 0) as T;
}

export function pileAt(state: unknown, path: string): PieceId[] {
  const v = getAtPath(state, path);
  return Array.isArray(v) ? (v as PieceId[]) : [];
}

/** Moves one piece from one pile to the end of another. */
export function movePiece<T>(state: T, from: string, to: string, id: PieceId): T {
  if (from === to) return state;
  const source = pileAt(state, from).filter((x) => x !== id);
  let next = setAtPath(state, from, source);
  next = setAtPath(next, to, [...pileAt(next, to), id]);
  return next;
}

/**
 * Grows or shrinks a pile to exactly `target` pieces — the one action
 * that makes "give this hand twenty cards" a single gesture instead of
 * twenty.
 *
 * Cards to grow with come from pieces not currently in ANY pile first
 * (so nothing visible is disturbed), and only then from the largest
 * other pile — which is almost always the stock, and is the pile a real
 * deal would have taken them from anyway. Shrinking returns the excess
 * to the largest other pile rather than deleting it, so the deck stays
 * intact and the game stays playable afterwards.
 */
export function fillPile<T>(
  state: T,
  path: string,
  target: number,
  vocabulary: ReadonlySet<PieceId>,
): T {
  const piles = findPiles(state, vocabulary);
  const current = pileAt(state, path);
  if (target === current.length) return state;

  const others = piles.filter((p) => p.path !== path);
  const donor = [...others].sort((a, b) => b.ids.length - a.ids.length)[0];

  if (target < current.length) {
    const excess = current.slice(target);
    let next = setAtPath(state, path, current.slice(0, target));
    if (donor) next = setAtPath(next, donor.path, [...pileAt(next, donor.path), ...excess]);
    return next;
  }

  const placed = new Set(piles.flatMap((p) => p.ids));
  const spare = [...vocabulary].filter((id) => !placed.has(id));
  const needed = target - current.length;

  const taken: PieceId[] = spare.slice(0, needed);
  let next = state;
  if (taken.length < needed && donor) {
    const fromDonor = pileAt(state, donor.path).slice(0, needed - taken.length);
    taken.push(...fromDonor);
    next = setAtPath(
      next,
      donor.path,
      pileAt(next, donor.path).filter((id) => !fromDonor.includes(id)),
    );
  }
  return setAtPath(next, path, [...current, ...taken]);
}
