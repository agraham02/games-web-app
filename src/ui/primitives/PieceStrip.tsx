/**
 * One piece from most of the games, overlapping and slightly turned, the
 * way a set looks when somebody has just cleared the table.
 *
 * The app's motif: the home screen's hero, and the screens a room passes
 * through on the way to a table (`RoomStatusScreen`). The app's own piece
 * primitives rather than icons or art — they are already in the bundle and
 * cannot drift from what the table actually draws.
 *
 * Purely decorative and hidden from assistive tech: every screen it is on
 * says what it means in words.
 */

import { CardBack, CardFace } from "./CardFace";
import { ChipFace } from "./ChipFace";
import { DiceFace } from "./DiceFace";
import { TileFace } from "./TileFace";
import { cn } from "@/lib/utils";

export function PieceStrip({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("flex h-16 items-end pl-1 select-none", className)}>
      <div className="rotate-[-10deg] drop-shadow-lg">
        <TileFace tile="6-3" w={30} h={58} ariaHidden />
      </div>
      {/* Only the CARDS overlap each other much — a fanned hand is what
          that reads as. The domino and the die want their own air or they
          just look broken. */}
      <div className="-ml-1 rotate-[6deg] drop-shadow-lg">
        <CardFace card="SA" w={42} h={60} detail="index" ariaHidden />
      </div>
      <div className="-ml-3 rotate-[-3deg] drop-shadow-lg">
        <CardFace card="HK" w={42} h={60} detail="index" ariaHidden />
      </div>
      {/* Face down, for BS — and it sits in the fan rather than beside it,
          because a card nobody can see is only interesting next to ones
          they can. */}
      <div className="-ml-3 rotate-[4deg] drop-shadow-lg">
        <CardBack w={42} h={60} ariaHidden />
      </div>
      <div className="-ml-1 mb-1 rotate-[9deg] drop-shadow-lg">
        <DiceFace face="C" size={38} />
      </div>
      <div className="-ml-2 mb-0.5 drop-shadow-lg">
        <ChipFace colour="ruby" size={34} />
      </div>
    </div>
  );
}
