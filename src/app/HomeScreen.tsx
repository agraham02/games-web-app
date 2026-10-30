"use client";

/**
 * The front door: pick a game, then play it with friends or on your own.
 *
 * Quiet luxury (the user's pick, 2026-10-30, between two test pages): a
 * near-black page with only a pool of the selected game's colour behind it,
 * a light sans for names, wide-tracked capitals and hairlines. Swiping the
 * carousel changes the colour — the page IS the game's colour, which is how
 * each game gets to feel like its own.
 *
 * The carousel runs the full width and never ends (`ui/stage/Carousel`): it
 * drags with a mouse as well as a thumb, and the dots under it — with an
 * arrow either side — jump to a game or step one along.
 *
 * A room is still the product (docs/CLAUDE.md, "A room is the point"):
 * "Play with friends" makes one with this game already chosen, and solo is
 * the quiet link beside it. Joining by code and going back to the room you
 * left stay one tap away at the top, whichever game is showing.
 *
 * The name is asked once, in a sheet, and only when this device has none; a
 * press is then the whole action: it leaves an intent for the room screen
 * (`entry.ts`), which carries it out as soon as the server is listening.
 *
 * Only a SHORT (landscape-phone) screen puts the carousel and the words side
 * by side — stacked, the buttons fell below the fold. Everywhere else, the
 * carousel spans the screen (side by side on a laptop squashed it).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { readSavedName, setEntryIntent } from "@/room/entry";
import { RoomEntryForm } from "@/room/RoomEntryForm";
import { GAME_IDS, GAMES } from "@/session/registry";
import { InfoSheet } from "@/ui/disclosure";
import { Button } from "@/ui/primitives/Button";
import { Credit } from "@/ui/primitives/Credit";
import { GAME_BLURBS, seatRange } from "@/ui/primitives/GameThumb";
import { Carousel } from "@/ui/stage/Carousel";
import { ART_W, GameArt } from "@/ui/stage/GameArt";
import { GameBackdrop } from "@/ui/stage/GameBackdrop";
import { useMediaQuery } from "@/ui/useMediaQuery";
import { useViewportWidth } from "@/ui/useViewportWidth";
import { InstallPrompt } from "./InstallPrompt";
import { useRejoin, type Rejoin } from "./useRejoin";

const COUNT = GAME_IDS.length;
const wrap = (i: number) => ((i % COUNT) + COUNT) % COUNT;

/** One slide's size for a window this wide: most of a phone, a generous fixed size on anything larger. */
function slideFor(width: number, short: boolean): number {
  if (short) return 200;
  if (width === 0) return 300;
  return Math.round(Math.min(380, Math.max(240, width * 0.74)));
}

export function HomeScreen({ lab = false }: { lab?: boolean }) {
  const router = useRouter();
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState(false);
  const rejoin = useRejoin();
  // A phone on its side: see the file's doc. `false` until hydrated, so the
  // first paint is the upright one everywhere.
  const short = useMediaQuery("(max-height: 559.98px)");
  const slide = slideFor(useViewportWidth(), short);
  const id = GAME_IDS[active]!;
  const entry = GAMES[id];

  const makeRoom = () => {
    setEntryIntent({ t: "make", game: id });
    router.push("/room");
  };
  const withFriends = () => {
    // A name already given is not asked for again: one press, one room.
    if (readSavedName()) makeRoom();
    else setSheet(true);
  };

  return (
    <div className="relative h-svh" data-game={id}>
      <GameBackdrop active={id} />
      <main className="relative h-full overflow-x-hidden overflow-y-auto overscroll-contain">
        <div className="flex min-h-full flex-col pt-[max(1.5rem,calc(env(safe-area-inset-top)+0.75rem))] pb-4 short:pt-3">
          <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6">
            <span className="caps text-bone-200">Table Games</span>
            <button type="button" className="text-link" onClick={() => setSheet(true)}>
              Join with code
            </button>
          </header>

          {rejoin ? (
            <div className="mx-auto w-full max-w-6xl px-6">
              <RejoinStrip room={rejoin} />
            </div>
          ) : null}

          <div className="flex flex-1 flex-col justify-center gap-6 py-6 short:flex-row short:items-center short:gap-4 short:px-6 short:py-2">
            <div className="flex flex-col items-center gap-5 short:w-[48%] short:shrink-0 short:gap-3">
              <Carousel active={active} onActive={setActive} count={COUNT} slide={slide} gap={Math.round(slide * 0.06)} label="Games">
                {(i, isActive) => (
                  <div
                    className={`grid h-full w-full place-items-center rounded-full ring-1 transition-colors duration-700 ${
                      isActive ? "ring-bone-50/14" : "ring-transparent"
                    }`}
                  >
                    <GameArt id={GAME_IDS[i]!} scale={(slide * 0.84) / ART_W} still={!isActive} />
                  </div>
                )}
              </Carousel>
              <GameDots active={active} onActive={setActive} />
            </div>

            <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 px-6 text-center short:mx-0 short:items-start short:px-0 short:text-left">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="flex flex-col items-center gap-3 short:items-start short:gap-2"
                >
                  <h1 className="font-title text-[clamp(2.8rem,11vw,5rem)] leading-[1] font-light tracking-tight text-bone-50 text-balance short:text-[2.4rem]">
                    {entry.name}
                  </h1>
                  <p className="max-w-sm text-sm leading-[1.8] font-light text-bone-300 text-pretty short:text-[13px] short:leading-relaxed">
                    {GAME_BLURBS[id]}
                  </p>
                  <span className="caps text-bone-500">{seatRange(id)}</span>
                </motion.div>
              </AnimatePresence>

              <div className="flex flex-col items-center gap-5 pt-1 sm:flex-row sm:gap-8 short:flex-row short:gap-6 short:pt-0">
                <Button
                  tone="ghost"
                  className="px-9 ring-brass-400/55 text-brass-300 transition-colors duration-700 hover:bg-brass-400/8 hover:text-brass-200 hover:ring-brass-300"
                  onClick={withFriends}
                >
                  Play with friends
                </Button>
                <Link href={`/play/${id}`} className="text-link">
                  Play solo
                </Link>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center px-6">
            {lab ? (
              <Link href="/lab/seats" className="text-link pt-2">
                Open the lab
              </Link>
            ) : null}
            <Credit />
          </div>
        </div>
        <InstallPrompt />
      </main>

      <InfoSheet open={sheet} title="Play with friends" onClose={() => setSheet(false)}>
        <div className="mx-auto flex max-w-sm flex-col gap-4 pb-2">
          <p className="text-sm leading-relaxed font-light text-bone-300">
            Make a room for <span className="font-medium text-bone-50">{entry.name}</span>, or join one with its code.
          </p>
          <RoomEntryForm
            mode="home"
            onMake={makeRoom}
            onJoin={(code) => {
              setEntryIntent({ t: "join", code });
              router.push(`/room/${code}`);
            }}
          />
        </div>
      </InfoSheet>
    </div>
  );
}

/**
 * Where you are among the games, and the way to any of them: a dot each
 * (the one in front drawn long), an arrow either side that steps one along.
 * Both wrap, like the carousel. The visible dot is small; what you press is
 * a 28px target around it.
 */
function GameDots({ active, onActive }: { active: number; onActive: (i: number) => void }) {
  const arrow =
    "grid h-9 w-9 place-items-center rounded-full text-bone-300 ring-1 ring-bone-50/15 transition-colors hover:text-bone-50 hover:ring-bone-50/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
  return (
    <nav aria-label="Choose a game" className="flex items-center gap-3">
      <button type="button" aria-label="Previous game" className={arrow} onClick={() => onActive(wrap(active - 1))}>
        <ChevronLeft size={16} />
      </button>
      <div className="flex items-center">
        {GAME_IDS.map((g, i) => (
          <button
            key={g}
            type="button"
            aria-label={GAMES[g].name}
            aria-current={i === active ? "true" : undefined}
            onClick={() => onActive(i)}
            className="group grid h-7 w-5 place-items-center outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span
              className={`block h-1.5 rounded-full transition-all duration-500 ${
                i === active ? "w-5 bg-brass-300" : "w-1.5 bg-bone-50/30 group-hover:bg-bone-50/60"
              }`}
            />
          </button>
        ))}
      </div>
      <button type="button" aria-label="Next game" className={arrow} onClick={() => onActive(wrap(active + 1))}>
        <ChevronRight size={16} />
      </button>
    </nav>
  );
}

/**
 * "You're still in room ABCD" — the screen's primary action when it is
 * there (the user's design, 2026-09-26): the whole strip is the button.
 */
function RejoinStrip({ room }: { room: NonNullable<Rejoin> }) {
  const router = useRouter();
  const what = room.running
    ? `${room.game ?? "Game"} in progress`
    : room.game
      ? `${room.game} lobby`
      : "Lobby";
  return (
    <button
      type="button"
      onClick={() => router.push(`/room/${room.code}`)}
      className="group mt-4 flex w-full items-center gap-3 border-y border-brass-400/40 py-3 text-left transition-colors hover:border-brass-300 hover:bg-brass-400/6 short:mt-2 short:py-2"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="caps text-brass-300">
          Back to room <span className="tracking-[0.3em]">{room.code}</span>
        </span>
        <span className="text-xs font-light text-bone-400">{what}</span>
      </span>
      <ArrowRight size={16} aria-hidden className="shrink-0 text-brass-300 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
