/**
 * The page shell every setup screen and the home screen sit in.
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
 */

export interface SetupShellProps {
  children: React.ReactNode;
  /** Widen for content that is a list rather than a form. */
  maxWidth?: string;
}

export function SetupShell({ children, maxWidth = "max-w-sm" }: SetupShellProps) {
  return (
    <main className="felt felt-weave h-svh overflow-y-auto overscroll-contain">
      <div className="flex min-h-full flex-col px-6 py-10">
        <div className={`m-auto flex w-full ${maxWidth} flex-col items-center gap-7`}>
          {children}
        </div>
      </div>
    </main>
  );
}
