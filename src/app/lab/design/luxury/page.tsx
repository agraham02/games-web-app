"use client";

/**
 * Design direction B — QUIET LUXURY. A test page, not the product.
 *
 * A near-black page with only a pool of the game's colour behind it, light
 * serif display type (Instrument Serif, italic for names), wide-tracked small
 * caps, hairline rules in place of filled surfaces, and slow fades. The same
 * three screens as the Bold page, on the same real data and themes:
 *   1. Home — the game carousel; the glow follows the game.
 *   2. /play/<game> — the setup screen's header and the REAL options.
 *   3. /room/<code> — the lobby.
 * The controls inside the options panel are today's primitives, unrestyled.
 */

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Instrument_Serif } from "next/font/google";
import { Bot, Crown } from "lucide-react";
import { GAME_IDS, GAMES, type GameId } from "@/session/registry";
import { GameOptions, type SetupValue } from "@/ui/setup/GameOptions";
import { defaultSetup } from "@/ui/setup/savedSetup";
import { GAME_BLURBS, GameThumb, seatRange } from "@/ui/primitives/GameThumb";
import { Carousel, GameArt, GameBackdrop, MOCK_CODE, MOCK_ROSTER } from "../shared";

const serif = Instrument_Serif({ variable: "--font-lux", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });

const CAPS = "text-[10.5px] font-medium tracking-[0.28em] uppercase";
const PRIMARY =
  "inline-flex h-12 items-center justify-center rounded-sm bg-brass-300 px-9 text-[11px] font-semibold tracking-[0.24em] text-felt-950 uppercase transition-colors duration-700 hover:bg-brass-200 focus-visible:ring-1 focus-visible:ring-brass-200 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:outline-none";
const OUTLINE =
  "inline-flex h-12 items-center justify-center rounded-sm border border-brass-400/55 px-9 text-[11px] font-medium tracking-[0.24em] text-brass-300 uppercase transition-colors duration-700 hover:border-brass-300 hover:bg-brass-400/8 focus-visible:ring-1 focus-visible:ring-brass-200 focus-visible:outline-none";
const LINK =
  "text-[11px] font-medium tracking-[0.24em] text-bone-300 uppercase underline decoration-bone-50/25 underline-offset-[7px] transition-colors hover:text-bone-50 hover:decoration-bone-50/60";

function Tag({ children }: { children: React.ReactNode }) {
  return <span className={`${CAPS} text-bone-500`}>{children}</span>;
}

const serifStyle = { fontFamily: "var(--font-lux), Georgia, serif" } as const;

export default function LuxuryLab() {
  const [active, setActive] = useState(0);
  const game = GAME_IDS[active]!;
  return (
    <div className={`${serif.variable} min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#050505]`}>
      <Home active={active} setActive={setActive} />
      <Setup game={game} />
      <Lobby game={game} onPick={(id) => setActive(GAME_IDS.indexOf(id))} />
    </div>
  );
}

/* ------------------------------ 1. Home ------------------------------ */

function Home({ active, setActive }: { active: number; setActive: (i: number) => void }) {
  const game = GAME_IDS[active]!;
  const entry = GAMES[game];
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <section data-game={game} className="relative isolate flex min-h-[calc(100svh-3rem)] flex-col overflow-hidden pb-10">
      <GameBackdrop active={game} kind="glow" />
      <header className="relative flex items-center justify-between px-6 pt-6">
        <span className={`${CAPS} text-bone-200`}>Table Games</span>
        <div className="flex items-center gap-6">
          <button className={`${LINK} hidden sm:block`}>Back to {MOCK_CODE}</button>
          <button className={LINK}>Join with code</button>
        </div>
      </header>

      <div className="relative mt-4 flex flex-1 flex-col justify-center gap-5">
        <Carousel
          active={active}
          onActive={setActive}
          count={GAME_IDS.length}
          slideWidth="min(68vw, 280px)"
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
              <GameArt id={GAME_IDS[i]!} scale={0.92} still={!isActive} />
            </div>
          )}
        </Carousel>

        <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 px-6 text-center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={game}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center gap-4"
            >
              <span className={`${CAPS} text-brass-300 transition-colors duration-700`}>
                {pad(active + 1)} / {pad(GAME_IDS.length)}
              </span>
              <h1
                className="text-[clamp(3rem,13vw,5.8rem)] leading-[0.95] font-normal tracking-tight text-bone-50 italic text-balance"
                style={serifStyle}
              >
                {entry.name}
              </h1>
              <p className="max-w-sm text-sm leading-[1.8] font-light text-bone-300 text-pretty">{GAME_BLURBS[game]}</p>
              <span className={`${CAPS} text-bone-500`}>{seatRange(game)}</span>
            </motion.div>
          </AnimatePresence>

          <div className="flex flex-col items-center gap-5 pt-1 sm:flex-row sm:gap-8">
            <button className={OUTLINE}>Play with friends</button>
            <button className={LINK}>Play solo</button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ 2. Setup ------------------------------ */

function Setup({ game }: { game: GameId }) {
  return (
    <section data-game={game} className="relative isolate min-h-[calc(100svh-3rem)] overflow-hidden">
      <GameBackdrop active={game} kind="glow" />
      <div className="relative mx-auto flex max-w-2xl flex-col gap-8 px-6 pt-10 pb-12">
        <Tag>/play/{game}</Tag>
        <div className="flex flex-col gap-4">
          <span className={`${CAPS} text-brass-300 transition-colors duration-700`}>New match</span>
          <h2
            className="text-[clamp(2.6rem,10vw,4.4rem)] leading-[0.98] font-normal tracking-tight italic text-balance"
            style={serifStyle}
          >
            {GAMES[game].name}
          </h2>
          <p className="max-w-md text-sm leading-[1.8] font-light text-bone-300 text-pretty">{GAME_BLURBS[game]}</p>
        </div>
        <div className="h-px w-full bg-linear-to-r from-brass-400/50 to-transparent transition-colors duration-700" />
        <SetupPanel key={game} game={game} />
        <button className={`${PRIMARY} w-full`}>Deal in</button>
      </div>
    </section>
  );
}

function SetupPanel({ game }: { game: GameId }) {
  const [value, setValue] = useState<SetupValue>(() => defaultSetup(game));
  return (
    <div className="rounded-md border border-bone-50/10 p-5">
      <GameOptions game={game} mode="solo" value={value} onChange={setValue} />
    </div>
  );
}

/* ------------------------------ 3. Lobby ------------------------------ */

function Lobby({ game, onPick }: { game: GameId; onPick: (id: GameId) => void }) {
  return (
    <section data-game={game} className="relative isolate min-h-[calc(100svh-3rem)] overflow-hidden">
      <GameBackdrop active={game} kind="glow" />
      <div className="relative mx-auto flex max-w-4xl flex-col gap-10 px-6 pt-10 pb-32">
        <Tag>/room/{MOCK_CODE}</Tag>

        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1fr]">
          <div className="flex min-w-0 flex-col gap-10">
            <div className="flex flex-col gap-3 border-y border-bone-50/10 py-7">
              <span className={`${CAPS} text-bone-500`}>Room code</span>
              <div
                className="text-[clamp(3.6rem,18vw,6rem)] leading-none font-normal tracking-[0.14em] text-brass-200 transition-colors duration-700"
                style={serifStyle}
              >
                {MOCK_CODE}
              </div>
              <div className="flex gap-7 pt-2">
                <button className={LINK}>Copy link</button>
                <button className={LINK}>Share</button>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <span className={`${CAPS} text-bone-500`}>Game</span>
              <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {GAME_IDS.map((id) => (
                  <button
                    key={id}
                    onClick={() => onPick(id)}
                    aria-pressed={id === game}
                    className={`flex w-[88px] shrink-0 flex-col items-center gap-3 border-b px-1 pt-2 pb-3 transition-all duration-500 ${
                      id === game
                        ? "border-brass-300 opacity-100"
                        : "border-transparent opacity-45 hover:opacity-80"
                    }`}
                  >
                    <span className="grid h-[50px] place-items-center">
                      <GameThumb id={id} />
                    </span>
                    <span className="text-[11px] leading-tight font-light text-bone-200">{GAMES[id].name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-col">
            <div className="flex items-baseline justify-between pb-3">
              <span className={`${CAPS} text-bone-500`}>Table</span>
              <span className="text-xs font-light text-bone-400">3 of {GAMES[game].maxSeats} here</span>
            </div>
            {MOCK_ROSTER.map((p) => (
              <div key={p.name} className="flex items-center gap-4 border-t border-bone-50/10 py-4">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-lg text-bone-100 ring-1 ring-bone-50/25"
                  style={serifStyle}
                >
                  {p.bot ? <Bot size={16} /> : p.name[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[15px] font-light text-bone-50">
                    {p.name}
                    {p.you ? <span className="text-xs text-bone-500">you</span> : null}
                    {p.leader ? <Crown size={13} className="text-brass-300 transition-colors duration-700" /> : null}
                  </div>
                  <div className="text-xs font-light text-bone-500">{p.status}</div>
                </div>
              </div>
            ))}
            <div className="border-t border-bone-50/10" />
          </div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-linear-to-t from-black from-55% to-transparent px-6 pt-12 pb-6">
        <span className="text-xs font-light text-bone-400">Everyone&rsquo;s here.</span>
        <button className={`${PRIMARY} w-full max-w-md`}>Start {GAMES[game].name}</button>
      </div>
    </section>
  );
}
