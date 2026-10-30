"use client";

/**
 * The front door: pick a game, then play it with friends or on your own.
 *
 * Quiet luxury (the user's pick, 2026-10-30, between two test pages): a
 * near-black page with only a pool of the selected game's colour behind it,
 * serif italic names, wide-tracked capitals and hairlines. Swiping the
 * carousel changes the colour — the page IS the game's colour, which is how
 * each game gets to feel like its own.
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
 * On a short (landscape) screen the carousel and the words sit side by side:
 * stacked, the title and the buttons fell below the fold.
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
import { GameArt } from "@/ui/stage/GameArt";
import { GameBackdrop } from "@/ui/stage/GameBackdrop";
import { useMediaQuery } from "@/ui/useMediaQuery";
import { InstallPrompt } from "./InstallPrompt";
import { useRejoin, type Rejoin } from "./useRejoin";

const pad = (n: number) => String(n).padStart(2, "0");

export function HomeScreen({ lab = false }: { lab?: boolean }) {
  const router = useRouter();
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState(false);
  const rejoin = useRejoin();
  // A phone on its side: see the file's doc. `false` until hydrated, so the
  // first paint is the upright one everywhere.
  const short = useMediaQuery("(max-height: 559.98px)");
  // Wide screens get the same side-by-side arrangement (layout is CSS; only
  // the numeric sizes below need to know).
  const wide = useMediaQuery("(min-width: 1024px)");
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

  const step = (by: number) => setActive((i) => Math.min(GAME_IDS.length - 1, Math.max(0, i + by)));

  return (
    <div className="relative h-svh" data-game={id}>
      <GameBackdrop active={id} />
      <main className="relative h-full overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col px-6 pt-[max(1.5rem,calc(env(safe-area-inset-top)+0.75rem))] pb-4 short:pt-3">
          <header className="flex items-center justify-between gap-4">
            <span className="caps text-bone-200">Table Games</span>
            <button type="button" className="text-link" onClick={() => setSheet(true)}>
              Join with code
            </button>
          </header>

          {rejoin ? <RejoinStrip room={rejoin} /> : null}

          <div className="flex flex-1 flex-col justify-center gap-5 py-4 short:flex-row short:items-center short:gap-6 short:py-2 lg:flex-row lg:items-center lg:gap-10 lg:py-8">
            <div className="relative -mx-6 short:mx-0 short:w-[46%] short:shrink-0 lg:mx-0 lg:w-1/2 lg:shrink-0">
              <Carousel
                active={active}
                onActive={setActive}
                count={GAME_IDS.length}
                slideWidth={short ? "min(32vw, 190px)" : wide ? "280px" : "min(68vw, 280px)"}
                gap="0.5rem"
                label="Games"
                className="py-2"
              >
                {(i, isActive) => (
                  <div
                    className={`relative grid aspect-square place-items-center rounded-full transition-all duration-700 ${
                      isActive ? "scale-100 opacity-100 ring-1 ring-bone-50/12" : "scale-[0.74] opacity-30 ring-1 ring-bone-50/0"
                    }`}
                  >
                    <GameArt id={GAME_IDS[i]!} scale={short ? 0.62 : 0.92} still={!isActive} />
                  </div>
                )}
              </Carousel>
              {/* A pointer can click through; a thumb swipes. */}
              <button
                type="button"
                aria-label="Previous game"
                disabled={active === 0}
                onClick={() => step(-1)}
                className="absolute top-1/2 left-4 hidden h-11 w-11 -translate-y-1/2 place-items-center rounded-full text-bone-300 ring-1 ring-bone-50/15 transition-colors hover:text-bone-50 hover:ring-bone-50/40 disabled:opacity-25 pointer-fine:grid"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                aria-label="Next game"
                disabled={active === GAME_IDS.length - 1}
                onClick={() => step(1)}
                className="absolute top-1/2 right-4 hidden h-11 w-11 -translate-y-1/2 place-items-center rounded-full text-bone-300 ring-1 ring-bone-50/15 transition-colors hover:text-bone-50 hover:ring-bone-50/40 disabled:opacity-25 pointer-fine:grid"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 text-center short:mx-0 short:items-start short:text-left lg:mx-0 lg:items-start lg:text-left">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="flex flex-col items-center gap-4 short:items-start short:gap-2 lg:items-start"
                >
                  <span className="caps text-brass-300 transition-colors duration-700">
                    {pad(active + 1)} / {pad(GAME_IDS.length)}
                  </span>
                  <h1 className="font-title text-[clamp(3rem,13vw,5.8rem)] leading-[0.95] font-normal tracking-tight text-bone-50 italic text-balance short:text-[2.6rem] lg:text-[4.5rem]">
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
                  className="px-9 ring-brass-400/55 text-brass-300 transition-colors duration-700 hover:text-brass-200 hover:ring-brass-300 hover:bg-brass-400/8"
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

          {lab ? (
            <Link href="/lab/seats" className="text-link self-center pt-2">
              Open the lab
            </Link>
          ) : null}
          <Credit />
        </div>
        <InstallPrompt />
      </main>

      <InfoSheet open={sheet} title="Play with friends" onClose={() => setSheet(false)}>
        <div className="mx-auto flex max-w-sm flex-col gap-4 pb-2">
          <p className="text-sm leading-relaxed font-light text-bone-300">
            Make a room for <span className="text-bone-50 italic">{entry.name}</span>, or join one with its code.
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
