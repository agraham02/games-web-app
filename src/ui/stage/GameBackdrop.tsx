"use client";

/**
 * The page colour that follows a game.
 *
 * One layer per game, all mounted, the active one at full opacity. Eight
 * painted gradients cost nothing, and a fast swipe through three games never
 * has to wait for a layer to mount. Only opacity animates, so it stays on the
 * compositor; under reduced motion it simply cuts.
 *
 * `glow` is the shell's look: a near-black page with a pool of the game's
 * colour (read from the layer's own `data-game` scope). `felt` draws the
 * game's own table surface and is what the design-lab pages use.
 *
 * It fills its nearest positioned ancestor and takes no clicks, so a scroller
 * that sits on top of it keeps the backdrop still while the page moves.
 */

import { motion, useReducedMotion } from "motion/react";
import { GAME_IDS, type GameId } from "@/session/registry";

export const SHELL_BLACK = "#050505";

export function GameBackdrop({ active, kind = "glow" }: { active: GameId; kind?: "felt" | "glow" }) {
  const reduced = useReducedMotion();
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ background: SHELL_BLACK }}>
      {GAME_IDS.map((id) => (
        <motion.div
          key={id}
          data-game={id}
          className={kind === "felt" ? "felt felt-weave" : undefined}
          style={
            kind === "felt"
              ? { position: "absolute", inset: 0 }
              : {
                  position: "absolute",
                  inset: 0,
                  background: `radial-gradient(70% 55% at 50% 38%, color-mix(in srgb, var(--color-felt-700) 62%, transparent), transparent 72%), radial-gradient(120% 80% at 50% 120%, color-mix(in srgb, var(--color-felt-850) 80%, transparent), transparent 60%)`,
                }
          }
          initial={false}
          animate={{ opacity: id === active ? 1 : 0 }}
          transition={{ duration: reduced ? 0 : 0.6, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}
