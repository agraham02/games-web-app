import Link from "next/link";

export default function Home() {
  return (
    /* The PAGE scrolls, not the body — `body` is `overflow: hidden` on
       both axes so the table can own its pan gestures (globals.css), and
       a page that outgrows the viewport would otherwise have no way to be
       reached at all. Same shape as `SetupShell`; this one is a document
       rather than a centred form, so it needs no auto-margin centring. */
    <main className="felt felt-weave h-svh overflow-y-auto overscroll-contain">
      <div className="relative z-1 mx-auto max-w-2xl px-6 py-16 sm:py-16">
        <span className="eyebrow">Foundation build</span>
        <h1 className="mt-2 font-display text-4xl tracking-wider text-brass-300">
          Table Games
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-bone-400">
          Dominoes, Left Right Center, Spades, Rummy 500 and Poker have real
          rules, real bots and a full table. Dominoes plays two ways — Block
          &amp; Draw, or the Caribbean game four-handed with the whole set
          dealt and no boneyard. Poker is no-limit hold&apos;em with real
          side pots, 2–10 seats.
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            href="/play/dominoes"
            className="inline-block rounded-lg bg-linear-to-b from-brass-300 to-brass-500 px-6 py-3.5 text-sm font-extrabold text-felt-950 shadow-e2"
          >
            Play Dominoes →
          </Link>
          <Link
            href="/play/lrc"
            className="inline-block rounded-lg bg-bone-50/6 px-6 py-3.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/16"
          >
            Left Right Center
          </Link>
          <Link
            href="/play/spades"
            className="inline-block rounded-lg bg-bone-50/6 px-6 py-3.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/16"
          >
            Spades
          </Link>
          <Link
            href="/play/rummy"
            className="inline-block rounded-lg bg-bone-50/6 px-6 py-3.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/16"
          >
            Rummy 500
          </Link>
          <Link
            href="/play/poker"
            className="inline-block rounded-lg bg-bone-50/6 px-6 py-3.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/16"
          >
            Poker
          </Link>
          <Link
            href="/lab/seats"
            className="inline-block rounded-lg bg-bone-50/6 px-6 py-3.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/16"
          >
            Open the lab
          </Link>
        </div>
      </div>
    </main>
  );
}
