import Link from "next/link";
import { ArrowRight, Bot, Eye, Users } from "lucide-react";
import { GAMES, GAME_IDS, type GameId } from "@/session/registry";
import { GAME_BLURBS, GameThumb, seatRange } from "@/ui/primitives/GameThumb";
import { PieceStrip } from "@/ui/primitives/PieceStrip";
import { Credit } from "@/ui/primitives/Credit";
import { labEnabled } from "@/lab/enabled";
import { HomeEntry } from "./HomeEntry";
import { InstallPrompt } from "./InstallPrompt";

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
 * The thumbnails are the app's own piece primitives (`GameThumb`, shared
 * with the lobby's game picker).
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
      <div className="relative z-1 mx-auto flex max-w-4xl flex-col gap-10 px-6 py-12 sm:py-16 short:gap-6 short:py-5">
        <Hero />
        <PlayTogether />
        <PlayAlone />
        {/* The lab link is dev-only (see `labEnabled`). */}
        {labEnabled() ? <Footer /> : null}
        <Credit />
      </div>
      <InstallPrompt />
    </main>
  );
}

/**
 * On a landscape phone the hero is just its title: the pieces and the
 * paragraph put "Play together" below the first screen, and a room is
 * what this page is for.
 */
function Hero() {
  return (
    <header className="flex flex-col gap-4 short:gap-1">
      <PieceStrip className="short:hidden" />
      <div>
        <span className="eyebrow">Six table games</span>
        <h1 className="mt-1.5 font-display text-4xl tracking-wider text-brass-300 sm:text-5xl">
          Table Games
        </h1>
      </div>
      <p className="max-w-xl text-sm leading-relaxed text-bone-400 short:hidden">
        Dominoes, Spades, Rummy 500, Poker, Left Right Center and BS — real
        rules, real bots, and a table that moves like a table. Play them
        with people in a room, or on your own against the house.
      </p>
    </header>
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
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_18rem] md:gap-x-10 md:gap-y-5">
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
      {/* Two columns of compact tiles on a phone — six full-width cards
          were most of a phone's scroll for the page's second purpose. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {GAME_IDS.map((id) => (
          <GameCard key={id} id={id} />
        ))}
      </div>
    </section>
  );
}

function GameCard({ id }: { id: GameId }) {
  const game = GAMES[id];

  return (
    <Link
      href={`/play/${id}`}
      className="group flex flex-col gap-2 rounded-xl bg-bone-50/5 p-3 ring-1 ring-bone-50/12 transition-colors hover:bg-bone-50/10 hover:ring-brass-400/45 sm:gap-3 sm:p-4"
    >
      {/* Stacked on a phone: beside the thumbnail, a half-width tile left a
          name like "Dominoes" about 85px, and it did not fit. */}
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
        <span aria-hidden className="flex h-13 w-11 shrink-0 items-center justify-center">
          <GameThumb id={id} />
        </span>
        <span className="flex min-w-0 max-w-full flex-col">
          <span className="font-display text-base leading-tight tracking-wide text-bone-50 sm:truncate sm:text-lg">
            {game.name}
          </span>
          <span className="text-[11px] font-semibold text-bone-600">{seatRange(id)}</span>
        </span>
      </div>
      <p className="hidden text-xs leading-relaxed text-bone-400 sm:block">{GAME_BLURBS[id]}</p>
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
