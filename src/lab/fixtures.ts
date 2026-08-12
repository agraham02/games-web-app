"use client";

/**
 * Fake data for the lab harness.
 *
 * Deliberately not backed by any game engine — the point of the
 * foundation review is to judge layout and motion before a single rule
 * is written, so the lab fabricates boards directly.
 */

import { createRng } from "@/engine/rng";
import type {
  GameEvent,
  PieceId,
  PlacementMap,
  SeatId,
} from "@/engine/types";
import { HERO } from "@/engine/types";
import type { PieceMeta } from "@/table/store";
import { shuffledDeck, SUIT_GLYPH, parseCard } from "@/games/_shared/cards";
import { doubleSixSet } from "@/ui/primitives/TileFace";
import type { SeatView } from "@/table/SeatRing";

const BOT_NAMES = [
  "Mia", "Sam", "Kofi", "Jo", "Ada", "Rui", "Nia", "Tomas", "Elle",
];

const BOT_COLOURS = [
  "#c9a0a0", "#a0a8c9", "#c9bfa0", "#8fb8a0", "#b9a0c9",
  "#a0c9c4", "#c9b0a0", "#aab8a0", "#c0a8b8",
];

export function makePlayers(
  seats: number,
  opts: { activeSeat?: SeatId; melds?: boolean } = {},
): SeatView[] {
  const out: SeatView[] = [];
  for (let seat = 1; seat < seats; seat++) {
    const i = seat - 1;
    out.push({
      seat,
      name: BOT_NAMES[i % BOT_NAMES.length]!,
      colour: BOT_COLOURS[i % BOT_COLOURS.length]!,
      meta: opts.melds ? `${4 + (i % 5)} cards` : `bid ${1 + (i % 4)}`,
      active: opts.activeSeat === seat,
      thinking: opts.activeSeat === seat,
      melds: opts.melds ? sampleMelds(seat) : undefined,
    });
  }
  return out;
}

function sampleMelds(seat: SeatId): string[] {
  const pool = [
    ["7♣7♦7♥", "4-5-6♠"],
    ["J-Q-K♥", "2♠2♦", "9-10-J♣"],
    ["A♠A♥A♦"],
    ["3-4-5♦", "K♠K♣"],
    [],
    ["8♥8♠", "5-6-7♣", "Q♦Q♥", "10♠10♦"],
    ["6-7-8♥"],
    [],
    ["2-3-4♣", "J♦J♣"],
  ];
  return pool[(seat - 1) % pool.length]!;
}

/* ============================================================
   Card board
   ============================================================ */

export interface Fixture {
  placements: PlacementMap;
  meta: Record<PieceId, PieceMeta>;
  /** Fire these through the choreographer to animate the deal. */
  dealEvents: GameEvent[];
}

/**
 * Every card starts stacked in the deck; `dealEvents` then walks them
 * out to the seats. That is the real sequence a game produces, so the
 * lab exercises the same code path a game will.
 */
export function cardFixture(opts: {
  seats: number;
  perHand: number;
  seed?: number;
}): Fixture {
  const rng = createRng(opts.seed ?? 20260811);
  const deck = shuffledDeck(rng);

  const placements: PlacementMap = {};
  const meta: Record<PieceId, PieceMeta> = {};

  deck.forEach((card, index) => {
    placements[card.id] = {
      zone: "deck",
      index,
      count: deck.length,
      faceUp: false,
    };
    meta[card.id] = { kind: "card", face: card.id };
  });

  const dealEvents: GameEvent[] = [];
  let cursor = 0;
  // Round-robin, exactly as a dealer would: one card per seat per pass.
  for (let round = 0; round < opts.perHand; round++) {
    for (let seat = 0; seat < opts.seats; seat++) {
      const card = deck[cursor++];
      if (!card) break;
      dealEvents.push({
        t: "deal",
        piece: card.id,
        to: seat,
        // Only the hero's cards are dealt face up.
        faceUp: seat === HERO,
      });
    }
  }

  return { placements, meta, dealEvents };
}

/** Tiles for the dominoes surface. */
export function tileFixture(opts: { seats: number; perHand: number }): Fixture {
  const tiles = doubleSixSet();
  const placements: PlacementMap = {};
  const meta: Record<PieceId, PieceMeta> = {};

  tiles.forEach((tile, index) => {
    placements[tile] = {
      zone: "deck",
      index,
      count: tiles.length,
      faceUp: false,
    };
    meta[tile] = { kind: "tile", face: tile };
  });

  const dealEvents: GameEvent[] = [];
  let cursor = 0;
  for (let round = 0; round < opts.perHand; round++) {
    for (let seat = 0; seat < opts.seats; seat++) {
      const tile = tiles[cursor++];
      if (!tile) break;
      dealEvents.push({ t: "deal", piece: tile, to: seat, faceUp: seat === HERO });
    }
  }

  return { placements, meta, dealEvents };
}

/* ============================================================
   Rummy board — melds already on the table.
   ============================================================ */

export interface MeldView {
  id: string;
  owner: SeatId;
  ownerName: string;
  ownerColour: string;
  cards: PieceId[];
  /** True when the currently-selected card can be laid off here. */
  valid?: boolean;
}

export function rummyBoard(seats: number): MeldView[] {
  const players = makePlayers(seats, { melds: true });
  const raw: Array<[SeatId, string[]]> = [
    [1, ["H6", "H7"]],
    [1, ["S4", "S5", "S6"]],
    [2, ["S8", "C8", "D8"]],
    [2, ["HJ", "HQ", "HK"]],
    [3, ["C2", "C3", "C4"]],
    [3, ["DQ", "SQ"]],
    [4, ["D3", "D4", "D5"]],
    [5, ["C9", "C10", "CJ"]],
  ];

  return raw
    .filter(([owner]) => owner < seats)
    .map(([owner, cards], i) => {
      const p = players.find((x) => x.seat === owner);
      return {
        id: `meld-${i}`,
        owner,
        ownerName: p?.name ?? `Seat ${owner}`,
        ownerColour: p?.colour ?? "#a69d89",
        cards,
      };
    });
}

/** Compact label for a meld, e.g. "6♥7♥" or "4-5-6♠". */
export function meldLabel(cards: readonly PieceId[]): string {
  const parsed = cards.map(parseCard);
  const suits = new Set(parsed.map((c) => c.suit));
  if (suits.size === 1 && parsed.length >= 3) {
    const suit = SUIT_GLYPH[parsed[0]!.suit];
    return `${parsed[0]!.rank}-${parsed[parsed.length - 1]!.rank}${suit}`;
  }
  return parsed.map((c) => `${c.rank}${SUIT_GLYPH[c.suit]}`).join("");
}
