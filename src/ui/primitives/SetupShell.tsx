"use client";

/**
 * The page shell every setup screen, the room's own screens and the home
 * screen sit in.
 *
 * It exists because of one interaction that is easy to get wrong twice.
 * `body` has `overflow: hidden` on BOTH axes (globals.css — a table game
 * must never let a native scroll container claim a pan gesture), so a
 * page that outgrows the viewport has no way to be reached at all. On a
 * short window the Rummy setup screen simply lost its bottom half: the
 * "Play to" stepper and the Deal in button were below the fold with no
 * scrollbar and no gesture that could get to them.
 *
 * So the PAGE is the scroll container, not the body. `body` keeps its
 * `overflow: hidden` and the table keeps its gesture guarantees.
 *
 * The centring is the second half, and `justify-center` alone does not
 * do it: a flex container centres its overflow in BOTH directions, so
 * once the content is taller than the box the top is pushed above the
 * scrollport and is unreachable even though the thing scrolls. `m-auto`
 * on the content is the fix — auto margins collapse to zero rather than
 * going negative, so the content centres when it fits and pins to the
 * top when it does not.
 *
 * `footer` is the screen's primary action, in a bar across the whole width of
 * the window that STICKS to its bottom edge — so "Deal in" and "Start" are
 * never below the fold (Dominoes' setup was 933px tall; on a laptop, a
 * landscape phone and a landscape tablet the button was off screen). It is a
 * solid bar, not a fade: a gradient the width of the content column stopped
 * short of the window's edges and read as a box cut out of the page (the
 * user, 2026-10-30).
 */

import { isGameId } from "@/session/registry";
import { themeAttrs } from "@/ui/gameTheme";
import { GameBackdrop } from "@/ui/stage/GameBackdrop";
import { Credit } from "./Credit";

export interface SetupShellProps {
  children: React.ReactNode;
  /** Widen for content that is a list rather than a form. */
  maxWidth?: string;
  /** The primary action, kept in reach — see the file's doc. */
  footer?: React.ReactNode;
  /** The game whose surface this screen wears; omit for the house green. */
  game?: string;
}

export function SetupShell({ children, maxWidth = "max-w-sm", footer, game }: SetupShellProps) {
  return (
    // The backdrop sits OUTSIDE the scroller: inside it, `inset-0` is the
    // scroller's visible box and would scroll away with the content.
    <div className="relative h-svh" {...(game ? themeAttrs(game) : {})}>
      <GameBackdrop active={game && isGameId(game) ? game : "spades"} />
      <main className="relative h-full overflow-y-auto overscroll-contain">
        <div className="flex min-h-full flex-col">
          <div className="flex flex-1 flex-col px-5 pt-[max(2.5rem,calc(env(safe-area-inset-top)+1rem))] pb-6 sm:px-8">
            <div className={`m-auto flex w-full ${maxWidth} flex-col items-center gap-7`}>{children}</div>
            <Credit />
          </div>
          {footer ? (
            <div className="sticky bottom-0 z-10 border-t border-bone-50/10 bg-[#070707]/85 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:px-8">
              <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3">{footer}</div>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
