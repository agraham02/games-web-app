/**
 * A game, drawn as one of its own pieces: the home page's solo tiles and
 * the lobby's game picker.
 *
 * The app's own piece primitives at a small size, rather than icons or art.
 * They cost nothing (every one is already in the bundle), they cannot drift
 * from what the table actually draws, and a domino that is really a domino
 * says what the game is faster than its name does.
 *
 * The lobby's picker used to be a row of names while the home page had
 * these (the user, 2026-09-27), so both now draw from here.
 */

import { GAMES, type GameId } from "@/session/registry";
import { CardBack, CardFace } from "./CardFace";
import { ChipFace } from "./ChipFace";
import { DiceFace } from "./DiceFace";
import { TileFace } from "./TileFace";

/** How tall the piece is drawn, in px. The home page's tiles are `md`. */
const HEIGHT = { sm: 40, md: 50 } as const;

export function GameThumb({ id, size = "md" }: { id: GameId; size?: keyof typeof HEIGHT }) {
  const h = HEIGHT[size];
  const card = Math.round(h * 0.72);
  const round = Math.round(h * 0.8);
  switch (id) {
    case "dominoes":
      return <TileFace tile="5-2" w={Math.round(h * 0.52)} h={h} ariaHidden />;
    case "spades":
      return <CardFace card="SA" w={card} h={h} detail="index" ariaHidden />;
    case "rummy":
      return <CardFace card="D10" w={card} h={h} detail="index" ariaHidden />;
    case "poker":
      return <ChipFace colour="ruby" size={round} />;
    case "lrc":
      return <DiceFace face="L" size={round} />;
    case "bs":
      // A back rather than a face, because the back of a card is the whole game.
      return <CardBack w={card} h={h} ariaHidden />;
  }
}

/**
 * "2–4 players", from the registry — the one place that already has to be
 * right about seat counts stays the only place that says them.
 */
export function seatRange(id: GameId): string {
  const { minSeats, maxSeats } = GAMES[id];
  return minSeats === maxSeats ? `${minSeats} players` : `${minSeats}–${maxSeats} players`;
}

/** A line on what each game is like, for somebody choosing one. */
export const GAME_BLURBS: Record<GameId, string> = {
  dominoes: "Block & Draw, or the Caribbean game with the whole set dealt and no boneyard.",
  spades: "Partners across the table. Bids, bags, and nil if you are feeling brave.",
  rummy: "Melds on the table, and a discard anybody at the table can race you for.",
  poker: "No-limit hold'em, with real side pots and a proper showdown.",
  lrc: "Three dice, three chips, and not one decision to make.",
  bs: "Claim the rank, lie about it, and see who doubts you before the next card goes down.",
};
