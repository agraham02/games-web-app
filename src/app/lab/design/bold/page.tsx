"use client";

/**
 * Design direction A — BOLD & GRAPHIC. A test page, not the product.
 *
 * Full-bleed colour per game, chunky rounded surfaces, one very large word
 * per screen, the game's own pieces as hero art. A modern grotesque
 * (Bricolage Grotesque) in place of Cinzel. The same three screens as the
 * Quiet-luxury page, wired to the same real data and themes:
 *   1. Home — the game carousel; the page colour follows the game.
 *   2. /play/<game> — the setup screen's header and the REAL options.
 *   3. /room/<code> — the lobby.
 * The controls inside the options panel are today's primitives, unrestyled:
 * restyling them is the product work that follows the pick.
 */

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bricolage_Grotesque } from "next/font/google";
import { ArrowRight, Bot, Copy, Crown, KeyRound, Share2, Users } from "lucide-react";
import { GAME_IDS, GAMES, type GameId } from "@/session/registry";
import { GAME_THEMES } from "@/ui/gameTheme";
import { GameOptions, type SetupValue } from "@/ui/setup/GameOptions";
import { defaultSetup } from "@/ui/setup/savedSetup";
import { GAME_BLURBS, GameThumb, seatRange } from "@/ui/primitives/GameThumb";
import { Carousel, GameArt, GameBackdrop, MOCK_CODE, MOCK_ROSTER } from "../shared";

const display = Bricolage_Grotesque({ variable: "--font-bold", subsets: ["latin"] });

// Literal names: Tailwind only emits a theme variable it sees written out.
const TEAM = ["var(--color-team-a)", "var(--color-team-b)", "var(--color-team-c)", "var(--color-team-d)", "var(--color-team-e)"];

/** The primary action: the game's accent as a solid slab, its deepest colour as ink. */
const PRIMARY =
  "inline-flex h-14 items-center justify-center gap-2 rounded-2xl bg-brass-400 px-7 text-base font-extrabold tracking-tight text-felt-950 shadow-e2 transition-colors duration-500 hover:bg-brass-300 focus-visible:ring-2 focus-visible:ring-bone-50 focus-visible:outline-none";
const SECONDARY =
  "inline-flex h-14 items-center justify-center gap-2 rounded-2xl border-2 border-bone-50/30 px-7 text-base font-bold tracking-tight text-bone-50 transition-colors hover:border-bone-50/60 hover:bg-bone-50/8 focus-visible:ring-2 focus-visible:ring-bone-50 focus-visible:outline-none";

function Tag({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <span className="inline-flex w-fit items-center gap-2 rounded-full bg-black/35 px-3 py-1 text-[11px] font-bold tracking-wide text-bone-200 backdrop-blur-sm">
      <span className="grid h-4 w-4 place-items-center rounded-full bg-brass-400 text-[10px] text-felt-950 transition-colors duration-500">
        {n}
      </span>
      {children}
    </span>
  );
}

export default function BoldLab() {
  const [active, setActive] = useState(0);
  const game = GAME_IDS[active]!;
  return (
    <div
      className={`${display.variable} min-h-0 flex-1 overflow-y-auto overscroll-contain`}
      style={{ fontFamily: "var(--font-bold), var(--font-sans)" }}
    >
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
  return (
    <section data-game={game} className="relative isolate flex min-h-[calc(100svh-3rem)] flex-col overflow-hidden pb-10">
      <GameBackdrop active={game} kind="felt" />
      <header className="relative flex items-center justify-between gap-3 px-5 pt-5">
        <span className="text-xl font-extrabold tracking-tight">Table Games</span>
        <div className="flex items-center gap-2">
          <button className="hidden rounded-full bg-brass-400/90 px-3.5 py-2 text-xs font-extrabold text-felt-950 sm:block">
            Back to {MOCK_CODE}
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-full bg-black/35 px-4 py-2 text-xs font-bold text-bone-50 ring-1 ring-bone-50/20 backdrop-blur-sm">
            <KeyRound size={14} /> Join with code
          </button>
        </div>
      </header>

      <div className="relative mt-5 flex flex-1 flex-col justify-center gap-6">
        <Carousel
          active={active}
          onActive={setActive}
          count={GAME_IDS.length}
          slide={300}
          gap={14}
          label="Games"
          className="py-4"
        >
          {(i, isActive) => {
            const t = GAME_THEMES[GAME_IDS[i]!];
            return (
              <div
                className={`grid aspect-[1/1.02] place-items-center rounded-[2rem] ring-1 ring-white/15 transition-all duration-500 ${
                  isActive ? "scale-100 opacity-100" : "scale-[0.86] opacity-55"
                }`}
                style={{
                  background: `linear-gradient(155deg, color-mix(in srgb, ${t.lit} 88%, white), ${t.lit} 40%, ${t.mid})`,
                  boxShadow: isActive ? "0 24px 60px rgb(0 0 0 / 0.45)" : "none",
                }}
              >
                <GameArt id={GAME_IDS[i]!} scale={1} still={!isActive} />
              </div>
            );
          }}
        </Carousel>

        <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 px-5 text-center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={game}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center gap-3"
            >
              <h1 className="text-[clamp(2.6rem,12vw,5.2rem)] leading-[0.92] font-extrabold tracking-tight text-balance">
                {entry.name}
              </h1>
              <div className="flex items-center gap-2 text-xs font-bold">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-black/35 px-3 py-1.5">
                  <Users size={13} /> {seatRange(game)}
                </span>
                <span className="rounded-full bg-black/35 px-3 py-1.5">Online or solo</span>
              </div>
              <p className="max-w-md text-[15px] leading-relaxed text-bone-100/90 text-pretty">{GAME_BLURBS[game]}</p>
            </motion.div>
          </AnimatePresence>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <button className={PRIMARY}>
              Play with friends <ArrowRight size={18} />
            </button>
            <button className={SECONDARY}>Play solo</button>
          </div>

          <div className="flex items-center gap-1.5 pt-1" role="presentation">
            {GAME_IDS.map((id, i) => (
              <button
                key={id}
                aria-label={GAMES[id].name}
                onClick={() => setActive(i)}
                className={`h-2 rounded-full transition-all duration-300 ${
                  i === active ? "w-7 bg-brass-400" : "w-2 bg-bone-50/35 hover:bg-bone-50/60"
                }`}
              />
            ))}
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
      <GameBackdrop active={game} kind="felt" />
      <div className="relative mx-auto flex max-w-2xl flex-col gap-6 px-5 pt-8 pb-10">
        <Tag n={2}>/play/{game}</Tag>
        <div className="flex items-center gap-4">
          <div className="-my-3 -ml-1">
            <GameArt id={game} scale={0.56} still />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-bold tracking-[0.14em] text-brass-300 uppercase transition-colors duration-500">
              New match
            </span>
            <h2 className="text-[clamp(2rem,9vw,3.4rem)] leading-[0.95] font-extrabold tracking-tight text-balance">
              {GAMES[game].name}
            </h2>
          </div>
        </div>
        <p className="max-w-lg text-[15px] leading-relaxed text-bone-100/85 text-pretty">{GAME_BLURBS[game]}</p>
        <SetupPanel key={game} game={game} />
        <button className={`${PRIMARY} w-full`}>Deal in</button>
      </div>
    </section>
  );
}

function SetupPanel({ game }: { game: GameId }) {
  const [value, setValue] = useState<SetupValue>(() => defaultSetup(game));
  return (
    <div className="rounded-[1.75rem] bg-black/28 p-5 ring-1 ring-bone-50/12 backdrop-blur-sm">
      <GameOptions game={game} mode="solo" value={value} onChange={setValue} />
    </div>
  );
}

/* ------------------------------ 3. Lobby ------------------------------ */

function Lobby({ game, onPick }: { game: GameId; onPick: (id: GameId) => void }) {
  return (
    <section data-game={game} className="relative isolate min-h-[calc(100svh-3rem)] overflow-hidden">
      <GameBackdrop active={game} kind="felt" />
      <div className="relative mx-auto flex max-w-4xl flex-col gap-5 px-5 pt-8 pb-28">
        <Tag n={3}>/room/{MOCK_CODE}</Tag>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1.1fr]">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="rounded-[1.75rem] bg-brass-400 p-6 text-felt-950 shadow-e3 transition-colors duration-500">
              <span className="text-[11px] font-extrabold tracking-[0.16em] uppercase opacity-70">Room code</span>
              <div className="my-1 text-[clamp(3.4rem,17vw,5.6rem)] leading-none font-extrabold tracking-[0.12em]">
                {MOCK_CODE}
              </div>
              <div className="mt-3 flex gap-2">
                <button className="inline-flex h-11 items-center gap-2 rounded-xl bg-felt-950 px-4 text-sm font-bold text-bone-50">
                  <Copy size={15} /> Copy link
                </button>
                <button className="inline-flex h-11 items-center gap-2 rounded-xl bg-felt-950/12 px-4 text-sm font-bold ring-2 ring-felt-950/30">
                  <Share2 size={15} /> Share
                </button>
              </div>
            </div>

            <div className="rounded-[1.75rem] bg-black/28 p-4 ring-1 ring-bone-50/12 backdrop-blur-sm">
              <div className="mb-3 flex items-baseline justify-between">
                <span className="text-sm font-extrabold tracking-tight">Game</span>
                <span className="text-xs text-bone-300">Ada picks</span>
              </div>
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {GAME_IDS.map((id) => (
                  <button
                    key={id}
                    onClick={() => onPick(id)}
                    aria-pressed={id === game}
                    className={`flex w-24 shrink-0 flex-col items-center gap-2 rounded-2xl px-2 pt-3 pb-2.5 text-center transition-all ${
                      id === game ? "bg-brass-400 text-felt-950" : "bg-bone-50/8 text-bone-200 hover:bg-bone-50/14"
                    }`}
                  >
                    <span className="grid h-[50px] place-items-center">
                      <GameThumb id={id} />
                    </span>
                    <span className="text-[11px] leading-tight font-bold">{GAMES[id].name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2 rounded-[1.75rem] bg-black/28 p-4 ring-1 ring-bone-50/12 backdrop-blur-sm">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-sm font-extrabold tracking-tight">Table</span>
              <span className="text-xs text-bone-300">3 of {GAMES[game].maxSeats} here</span>
            </div>
            {MOCK_ROSTER.map((p, i) => (
              <div key={p.name} className="flex items-center gap-3 rounded-2xl bg-bone-50/7 px-3 py-2.5">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-extrabold text-felt-950"
                  style={{ background: TEAM[i % TEAM.length] }}
                >
                  {p.bot ? <Bot size={18} /> : p.name[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[15px] font-bold">
                    {p.name}
                    {p.you ? <span className="text-xs font-semibold text-bone-400">you</span> : null}
                    {p.leader ? <Crown size={14} className="text-brass-300 transition-colors duration-500" /> : null}
                  </div>
                  <div className="text-xs text-bone-400">{p.status}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 bg-linear-to-t from-felt-950 from-50% to-transparent px-5 pt-10 pb-5">
        <span className="text-xs text-bone-300">Everyone&rsquo;s here — you can start.</span>
        <button className={`${PRIMARY} w-full max-w-md`}>Start {GAMES[game].name}</button>
      </div>
    </section>
  );
}
