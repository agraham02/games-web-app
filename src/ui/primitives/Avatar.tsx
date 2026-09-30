"use client";

/**
 * A person at the table: their photo if they took one in this room, else
 * initials on their tint — or, for a seat a bot holds with nobody's name on
 * it, the bot glyph the lobby uses.
 *
 * It was drawn four ways: the lobby's roster, the seat pods, the round
 * card's rows and the game-end winner each had their own circle, with
 * their own type, their own dimming and their own idea of initials. One
 * component now, sized by the caller.
 */

import { useState } from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

export function Avatar({
  name,
  colour,
  size = 32,
  dim = false,
  bot = false,
  src,
  className,
  style,
}: {
  name: string;
  /** The tint. Any CSS colour. */
  colour: string;
  /** Diameter, px. */
  size?: number;
  /** Not here right now — disconnected, eliminated. Greyed, never hidden. */
  dim?: boolean;
  /** A seat a bot holds for nobody: the glyph, not a name. */
  bot?: boolean;
  /**
   * Their photo (`photoUrl`), drawn over the initials. The initials stay
   * underneath, so a photo still loading shows them, and one that cannot
   * be loaded at all (they took it down, the room closed) falls back to
   * them rather than to a broken-image box.
   */
  src?: string | null;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (bot) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-bone-50/8 text-bone-400 ring-1 ring-bone-50/12",
          className,
        )}
        style={{ width: size, height: size, ...style }}
      >
        <Bot size={Math.round(size * 0.5)} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full font-display font-bold text-felt-950",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: colour,
        fontSize: Math.round(size * 0.38),
        opacity: dim ? 0.45 : 1,
        filter: dim ? "grayscale(1)" : undefined,
        ...style,
      }}
    >
      {name.slice(0, 2).toUpperCase()}
      {src && failed !== src ? (
        // A plain <img>: it is our own small square, served by URL, and
        // next/image's optimiser would only add a round trip to it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          onError={() => setFailed(src)}
          className="absolute inset-0 h-full w-full rounded-full object-cover"
        />
      ) : null}
    </span>
  );
}
