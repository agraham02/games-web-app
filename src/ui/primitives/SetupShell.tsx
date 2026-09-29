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
 * `footer` is the screen's primary action, and it STICKS to the bottom of
 * the scroll container while the content is taller than the window — so
 * "Deal in" is never below the fold (Dominoes' setup was 933px tall; on a
 * laptop, a landscape phone and a landscape tablet the button was off
 * screen). When the content fits, the footer simply follows it: it is
 * sticky inside the centred block, not pinned to the window's edge.
 */

import { Credit } from "./Credit";

export interface SetupShellProps {
  children: React.ReactNode;
  /** Widen for content that is a list rather than a form. */
  maxWidth?: string;
  /** The primary action, kept in reach — see the file's doc. */
  footer?: React.ReactNode;
}

export function SetupShell({ children, maxWidth = "max-w-sm", footer }: SetupShellProps) {
  return (
    <main className="felt felt-weave h-svh overflow-y-auto overscroll-contain">
      <div className="flex min-h-full flex-col px-6 pt-10 pb-6">
        <div className={`m-auto flex w-full ${maxWidth} flex-col items-center gap-7`}>
          {children}
          {footer ? (
            <div
              className="sticky bottom-0 z-10 -mx-6 flex w-[calc(100%+3rem)] flex-col items-center gap-3 bg-linear-to-t from-felt-950 from-60% to-transparent px-6 pt-8 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            >
              {footer}
            </div>
          ) : null}
        </div>
        <Credit />
      </div>
    </main>
  );
}
