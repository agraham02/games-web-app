/**
 * Chromaly's cards: what each one is, what it is worth, and when it may go
 * on the pile. Pure; nothing here knows about a game in progress.
 *
 * A piece id is the whole identity of a card and is stable for the game:
 * `R7.1` is the first red seven, `YD.2` the second yellow draw-two, `W.3`
 * the third wild. Ids carry no colons so they are safe in CSS selectors,
 * and none starts with `#`, which is how redaction recognises a stand-in.
 */

import type { PieceId } from "@/engine/types";

export const COLORS = ["R", "Y", "G", "B"] as const;
export type Color = (typeof COLORS)[number];

export const COLOR_NAME: Record<Color, string> = {
  R: "Red",
  Y: "Yellow",
  G: "Green",
  B: "Blue",
};

/** What a card does. `number` cards have a `value`; the rest are their kind. */
export type Kind =
  | "number"
  | "skip"
  | "reverse"
  | "draw2"
  /** Wild: names a colour. */
  | "wild"
  /** Wild +4: names a colour, and the next player draws four. */
  | "wild4"
  /** Wild Shuffle Hands: names a colour, then every hand is shuffled and redealt. */
  | "shuffle";

export interface ParsedCard {
  id: PieceId;
  kind: Kind;
  /** Absent on a wild. */
  color?: Color;
  /** 0-9 on a number card. */
  value?: number;
  copy: number;
}

const COLORED = /^([RYGB])([0-9SVD])\.(\d)$/;
const WILD = /^([WFX])\.(\d)$/;

const SYMBOL_KIND = { S: "skip", V: "reverse", D: "draw2" } as const;
const WILD_KIND = { W: "wild", F: "wild4", X: "shuffle" } as const;

/** The card an id names, or null for anything else (a stand-in, "??"). */
export function parseCard(id: PieceId): ParsedCard | null {
  const colored = COLORED.exec(id);
  if (colored) {
    const color = colored[1] as Color;
    const face = colored[2]!;
    const copy = Number(colored[3]);
    if (face >= "0" && face <= "9") return { id, kind: "number", color, value: Number(face), copy };
    return { id, kind: SYMBOL_KIND[face as "S" | "V" | "D"], color, copy };
  }
  const wild = WILD.exec(id);
  if (wild) {
    return { id, kind: WILD_KIND[wild[1] as "W" | "F" | "X"], copy: Number(wild[2]) };
  }
  return null;
}

export function cardId(color: Color, face: string, copy: number): PieceId {
  return `${color}${face}.${copy}`;
}

const wildId = (letter: "W" | "F" | "X", copy: number): PieceId => `${letter}.${copy}`;

/**
 * The deck: 108 cards, or 109 with the Shuffle Hands wild.
 *
 * Per colour one 0 and two each of 1-9, Skip, Reverse and Draw 2 (25), so
 * 100 coloured cards, then four Wilds and four Wild +4. In a stable order,
 * which is what `pieces()` and the undealt pile are built from.
 */
export function deckIds(shuffleHands = false): PieceId[] {
  const out: PieceId[] = [];
  for (const color of COLORS) {
    out.push(cardId(color, "0", 1));
    for (let copy = 1; copy <= 2; copy++) {
      for (let n = 1; n <= 9; n++) out.push(cardId(color, String(n), copy));
      for (const face of ["S", "V", "D"]) out.push(cardId(color, face, copy));
    }
  }
  for (let copy = 1; copy <= 4; copy++) out.push(wildId("W", copy));
  for (let copy = 1; copy <= 4; copy++) out.push(wildId("F", copy));
  if (shuffleHands) out.push(wildId("X", 1));
  return out;
}

export function isWild(card: ParsedCard): boolean {
  return card.kind === "wild" || card.kind === "wild4" || card.kind === "shuffle";
}

/** Draw cards: the ones a stack is made of. */
export function isDraw(card: ParsedCard): boolean {
  return card.kind === "draw2" || card.kind === "wild4";
}

/** How many cards a draw card makes the next player take. */
export function drawAmount(card: ParsedCard): number {
  return card.kind === "wild4" ? 4 : card.kind === "draw2" ? 2 : 0;
}

/**
 * What a card is worth to whoever goes out against it. Numbers at face
 * value, Skip / Reverse / Draw 2 twenty, Wild and Wild +4 fifty, Shuffle
 * Hands forty (Mattel, 2018).
 */
export function points(id: PieceId): number {
  const card = parseCard(id);
  if (!card) return 0;
  switch (card.kind) {
    case "number":
      return card.value ?? 0;
    case "skip":
    case "reverse":
    case "draw2":
      return 20;
    case "wild":
    case "wild4":
      return 50;
    case "shuffle":
      return 40;
  }
}

/**
 * The pile's top, as far as matching goes: the colour in force (a wild's is
 * chosen) and the card that is showing.
 */
export interface Top {
  card: ParsedCard;
  color: Color;
}

/** Do these two share a number or a symbol? Wilds never do. */
export function sameFace(a: ParsedCard, b: ParsedCard): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "number") return a.value === b.value;
  return a.kind === "skip" || a.kind === "reverse" || a.kind === "draw2";
}

/** The same card, to the colour: what a Jump-In needs. */
export function identical(a: ParsedCard, b: ParsedCard): boolean {
  return !isWild(a) && !isWild(b) && a.color === b.color && sameFace(a, b);
}

/** May `card` go on this top by the ordinary rules? A wild always may. */
export function matches(card: ParsedCard, top: Top): boolean {
  if (isWild(card)) return true;
  return card.color === top.color || sameFace(card, top.card);
}

/** A card's name for a toast or a screen reader. */
export function cardLabel(id: PieceId): string {
  const card = parseCard(id);
  if (!card) return "a card";
  const colour = card.color ? COLOR_NAME[card.color] + " " : "";
  switch (card.kind) {
    case "number":
      return `${colour}${card.value}`;
    case "skip":
      return `${colour}Skip`;
    case "reverse":
      return `${colour}Reverse`;
    case "draw2":
      return `${colour}Draw 2`;
    case "wild":
      return "Wild";
    case "wild4":
      return "Wild +4";
    case "shuffle":
      return "Wild Shuffle Hands";
  }
}

/**
 * A hand's order on screen: by colour, then face, wilds last — so a colour
 * is a block the eye can scan, which is how everyone sorts this game by hand.
 * Cosmetic; the authoritative hand order is untouched.
 */
export function handDisplayOrder(hand: readonly PieceId[]): PieceId[] {
  const faceRank = (c: ParsedCard) =>
    c.kind === "number" ? (c.value ?? 0) : c.kind === "skip" ? 10 : c.kind === "reverse" ? 11 : 12;
  const key = (id: PieceId): [number, number, number] => {
    const c = parseCard(id);
    if (!c) return [9, 0, 0];
    if (isWild(c)) return [4, ["wild", "wild4", "shuffle"].indexOf(c.kind), c.copy];
    return [COLORS.indexOf(c.color!), faceRank(c), c.copy];
  };
  return [...hand].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}
