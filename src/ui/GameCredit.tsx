/**
 * The credit a game owes for something it is built on, shown only where that
 * game is: its solo setup screen, its lobby and its Settings drawer — not on
 * every screen of the app (the user, 2026-10-30).
 *
 * Mind Meld's bots think with ConceptNet Numberbatch, which is CC BY-SA 4.0:
 * that licence lets the app go commercial, and asks for attribution where
 * people can see it. The files themselves carry it too
 * (`public/mindmeld/NOTICE.txt`). Keep this wherever Mind Meld's bots are
 * chosen or played.
 */

const LINK =
  "underline decoration-bone-50/25 underline-offset-2 hover:text-bone-200 hover:decoration-bone-50/60 focus-visible:text-bone-200";

/** Whether a game has a credit to show, so a container can skip reserving room for one. */
export function hasGameCredit(game: string): boolean {
  return game === "mindmeld";
}

export function GameCredit({ game, className }: { game: string; className?: string }) {
  if (!hasGameCredit(game)) return null;
  return (
    <p className={`text-[11px] leading-relaxed text-bone-500 ${className ?? ""}`}>
      Mind Meld&rsquo;s bots use{" "}
      <a
        href="https://github.com/commonsense/conceptnet-numberbatch"
        target="_blank"
        rel="noopener noreferrer"
        className={LINK}
      >
        ConceptNet Numberbatch
      </a>{" "}
      by Luminoso Technologies, Inc., under{" "}
      <a
        href="https://creativecommons.org/licenses/by-sa/4.0/"
        target="_blank"
        rel="noopener noreferrer"
        className={LINK}
      >
        CC BY-SA 4.0
      </a>
      .
    </p>
  );
}
