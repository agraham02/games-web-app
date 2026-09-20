import Link from "next/link";
import { ArrowRight, Bot, Eye, Users } from "lucide-react";
import { GAMES, GAME_IDS, type GameId } from "@/session/registry";
import { CardBack, CardFace } from "@/ui/primitives/CardFace";
import { ChipFace } from "@/ui/primitives/ChipFace";
import { DiceFace } from "@/ui/primitives/DiceFace";
import { TileFace } from "@/ui/primitives/TileFace";
import { HomeEntry } from "./HomeEntry";

/**
 * The front door.
 *
 * It used to be a paragraph and seven buttons in a row, one of which was
 * "play with friends" — which put the thing this app is actually for in a
 * wrapping list beside "Open the lab". Playing against bots is the fallback
 * here, not the product, so the page is now in two clearly unequal halves:
 * a room you can make or join without leaving this screen, and below it the
 * solo tables for when nobody else is around.
 *
 * The thumbnails are the app's own piece primitives at a small size rather
 * than icons or art. They cost nothing (every one of them is already in the
 * bundle), they cannot drift from what the table actually draws, and a
 * domino that is really a domino says what the game is faster than its name
 * does.
 *
 * The PAGE scrolls, not the body — `body` is `overflow: hidden` on both
 * axes so a table can own its pan gestures (globals.css), and a page that
 * outgrows the viewport would otherwise have no way to be reached at all.
 * Same shape as `SetupShell`; this one is a document rather than a centred
 * form, so it needs no auto-margin centring.
 */

export default function Home() {
  return (
    <main className="felt felt-weave h-svh overflow-y-auto overscroll-contain">
      <div className="relative z-1 mx-auto flex max-w-4xl flex-col gap-10 px-6 py-12 sm:py-16">
        <Hero />
        <PlayTogether />
        <PlayAlone />
        <Footer />
      </div>
    </main>
  );
}

function Hero() {
  return (
    <header className="flex flex-col gap-4">
      <PieceStrip />
      <div>
        <span className="eyebrow">Six table games</span>
        <h1 className="mt-1.5 font-display text-4xl tracking-wider text-brass-300 sm:text-5xl">
          Table Games
        </h1>
      </div>
      <p className="max-w-xl text-sm leading-relaxed text-bone-400">
        Dominoes, Spades, Rummy 500, Poker, Left Right Center and BS — real
        rules, real bots, and a table that moves like a table. Play them
        with people in a room, or on your own against the house.
      </p>
    </header>
  );
}

/**
 * One piece from most of the games, overlapping and slightly turned, the
 * way a set looks when somebody has just cleared the table.
 *
 * Purely decorative and hidden from assistive tech: everything it says is
 * said again in words directly below it.
 */
function PieceStrip() {
  return (
    <div aria-hidden className="flex h-16 items-end pl-1 select-none">
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

/** The main event. Everything about its weight on the page says so. */
function PlayTogether() {
  return (
    <section className="rounded-2xl bg-felt-950/45 p-6 ring-1 ring-brass-500/30 shadow-e2 sm:p-8">
      {/*
        Three grid children rather than two columns, so that on a PHONE the
        source order puts the two buttons directly under the heading and
        the supporting points below them. Nested inside a left column they
        sat under four lines of copy, which is a long way to scroll to
        reach the one thing this panel is for.
      */}
      <div className="grid gap-6 md:grid-cols-[1fr_18rem] md:gap-x-10 md:gap-y-5">
        <div className="md:col-start-1 md:row-start-1">
          <span className="eyebrow">Play together</span>
          <h2 className="mt-1.5 font-display text-2xl tracking-wide text-bone-50">
            A room, a code, and whoever turns up
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-bone-400">
            Make a room, send the four letters to your people, and pick a
            game once everyone is in. Any of the six, up to ten seats.
          </p>
        </div>

        <div className="md:col-start-2 md:row-start-1 md:row-span-2 md:self-start">
          <HomeEntry />
        </div>

        <ul className="flex flex-col gap-2.5 text-sm text-bone-400 md:col-start-1 md:row-start-2">
          <Point icon={<Bot size={14} />}>
            Bots fill the seats nobody is sitting in.
          </Point>
          <Point icon={<Users size={14} />}>
            Step away and your seat, hand and score are held for you.
          </Point>
          <Point icon={<Eye size={14} />}>
            Turn up mid-game to watch, or take a free chair.
          </Point>
        </ul>
      </div>
    </section>
  );
}

function Point({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-brass-400">{icon}</span>
      <span className="leading-snug">{children}</span>
    </li>
  );
}

/** The fallback, and labelled as one. */
function PlayAlone() {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <span className="eyebrow shrink-0">Or play on your own</span>
        <span className="rule-brass flex-1" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {GAME_IDS.map((id) => (
          <GameCard key={id} id={id} />
        ))}
      </div>
    </section>
  );
}

/**
 * Seat counts and names come from the shared registry rather than being
 * written out here, so the one place that already has to be right about
 * them stays the only place that says them.
 */
const BLURBS: Record<GameId, string> = {
  dominoes: "Block & Draw, or the Caribbean game with the whole set dealt and no boneyard.",
  spades: "Partners across the table. Bids, bags, and nil if you are feeling brave.",
  rummy: "Melds on the table, and a discard anybody at the table can race you for.",
  poker: "No-limit hold'em, with real side pots and a proper showdown.",
  lrc: "Three dice, three chips, and not one decision to make.",
  bs: "Claim the rank, lie about it, and see who doubts you before the next card goes down.",
};

const THUMBS: Record<GameId, React.ReactNode> = {
  dominoes: <TileFace tile="5-2" w={26} h={50} ariaHidden />,
  spades: <CardFace card="SA" w={36} h={50} detail="index" ariaHidden />,
  rummy: <CardFace card="D10" w={36} h={50} detail="index" ariaHidden />,
  poker: <ChipFace colour="ruby" size={40} />,
  lrc: <DiceFace face="L" size={40} />,
  // A back rather than a face, because the back of a card is the whole game.
  bs: <CardBack w={36} h={50} ariaHidden />,
};

function GameCard({ id }: { id: GameId }) {
  const game = GAMES[id];
  const seats =
    game.minSeats === game.maxSeats
      ? `${game.minSeats} players`
      : `${game.minSeats}–${game.maxSeats} players`;

  return (
    <Link
      href={`/play/${id}`}
      className="group flex flex-col gap-3 rounded-xl bg-bone-50/5 p-4 ring-1 ring-bone-50/12 transition-colors hover:bg-bone-50/10 hover:ring-brass-400/45"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex h-13 w-11 shrink-0 items-center justify-center">
          {THUMBS[id]}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-display text-lg tracking-wide text-bone-50">
            {game.name}
          </span>
          <span className="text-[11px] font-semibold text-bone-600">{seats}</span>
        </span>
      </div>
      <p className="text-xs leading-relaxed text-bone-400">{BLURBS[id]}</p>
      <span className="mt-auto flex items-center gap-1 pt-1 text-xs font-bold text-brass-300">
        Play solo
        <ArrowRight
          size={12}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </span>
    </Link>
  );
}

function Footer() {
  return (
    <footer className="flex items-center gap-4 pt-2 text-xs text-bone-600">
      <Link href="/lab/seats" className="underline-offset-4 hover:text-bone-400 hover:underline">
        Open the lab
      </Link>
    </footer>
  );
}
