"use client";

/**
 * The visual system, rendered from the real components.
 *
 * This is the code-side counterpart to the Claude Design canvas — if
 * they disagree, this one is the truth, because these are the actual
 * components the games will use.
 */

import { CardBack, CardFace } from "@/ui/primitives/CardFace";
import { TileFace } from "@/ui/primitives/TileFace";
import { ChipFace } from "@/ui/primitives/ChipFace";
import { RANKS, SUITS, cardId } from "@/games/_shared/cards";

const FELT = ["950", "900", "850", "800", "700", "600"];
const BRASS = ["200", "300", "400", "500", "600", "700"];
const BONE = ["50", "200", "400", "600"];

export default function TokensLab() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-10 p-6">
        <header>
          <span className="eyebrow">Neo-felt</span>
          <h1 className="mt-1 font-display text-3xl tracking-wider text-brass-300">
            Visual system
          </h1>
          <p className="mt-2 max-w-xl text-sm text-bone-400">
            Deep felt, brass rule lines, printed card stock. Motion is weighted
            and settled — pieces have mass. Nothing bounces; things arrive.
          </p>
        </header>

        <Section title="Surface · felt">
          <Swatches prefix="felt" steps={FELT} />
        </Section>

        <Section title="Accent · brass">
          <Swatches prefix="brass" steps={BRASS} />
        </Section>

        <div className="grid gap-8 sm:grid-cols-2">
          <Section title="Text · bone">
            <Swatches prefix="bone" steps={BONE} />
          </Section>
          <Section title="Semantic">
            <div className="grid grid-cols-4 gap-2">
              <Swatch token="win" label="win" />
              <Swatch token="warn" label="warn" />
              <Swatch token="loss" label="loss" />
              <Swatch token="suit-red" label="suit" />
            </div>
          </Section>
        </div>

        <Section title="Type">
          <div className="space-y-2">
            <p className="font-display text-3xl tracking-wider text-brass-300">
              Cinzel · display
            </p>
            <p className="text-xs text-bone-600">
              Round banners, winner, game titles. Sparingly.
            </p>
            <p className="text-2xl font-bold text-bone-50">Figtree · interface</p>
            <p className="text-xs text-bone-600">
              Every functional label, score and button. Tabular numerals.
            </p>
            <p className="font-rank text-2xl font-bold text-bone-50">
              Source Serif 4 · A K Q J 10 9
            </p>
            <p className="text-xs text-bone-600">
              Card rank indices only — legible down to 9px.
            </p>
          </div>
        </Section>

        <Section title="Elevation">
          <div className="flex flex-wrap gap-6">
            {(
              [
                ["e1", "resting on felt"],
                ["e2", "lifted / playable"],
                ["e3", "dragged / selected"],
              ] as const
            ).map(([token, note]) => (
              <div key={token} className="flex items-center gap-3">
                <div
                  className="rounded-lg bg-card-face"
                  style={{
                    width: 76,
                    height: 52,
                    boxShadow: `var(--shadow-${token})`,
                  }}
                />
                <span className="text-[11px] text-bone-400">
                  <b className="text-bone-200">{token}</b> — {note}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Cards · every rank">
          <div className="space-y-3">
            {SUITS.map((suit) => (
              <div key={suit} className="flex flex-wrap gap-1.5">
                {RANKS.map((rank) => (
                  <CardFace
                    key={rank}
                    card={cardId(suit, rank)}
                    w={64}
                    h={90}
                  />
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Sizes · one face, four scales">
          <div className="flex flex-wrap items-end gap-3">
            <CardFace card="HA" w={84} h={118} />
            <CardFace card="SK" w={64} h={90} />
            <CardFace card="C10" w={44} h={62} detail="index" />
            <CardFace card="D7" w={26} h={36} detail="index" />
            <CardBack w={84} h={118} />
          </div>
          <p className="mt-2 max-w-lg text-[11px] text-bone-600">
            Below 52px the pip field becomes mud, so the piece layer swaps to a
            single centred glyph. The corner index never moves — that is what
            keeps a fanned hand readable.
          </p>
        </Section>

        <div className="grid gap-8 sm:grid-cols-2">
          <Section title="Dominoes · double-six">
            <div className="flex flex-wrap gap-2">
              {["6-6", "6-3", "5-0", "4-4", "3-1", "0-0"].map((t) => (
                <TileFace key={t} tile={t} w={54} h={106} />
              ))}
            </div>
          </Section>

          <Section title="Chips · LRC">
            <div className="flex flex-wrap gap-3">
              <ChipFace colour="ruby" size={48} />
              <ChipFace colour="forest" size={48} />
              <ChipFace colour="gold" size={48} />
              <ChipFace colour="neutral" size={48} label="5" />
              <ChipFace colour="brass" size={48} label="25" />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="eyebrow">{title}</h2>
      {children}
      <span className="rule-brass block" />
    </section>
  );
}

function Swatches({ prefix, steps }: { prefix: string; steps: string[] }) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0,1fr))` }}
    >
      {steps.map((s) => (
        <Swatch key={s} token={`${prefix}-${s}`} label={s} />
      ))}
    </div>
  );
}

/**
 * Backed by the CSS variable rather than a Tailwind class: Tailwind
 * scans source statically, so an interpolated `bg-${prefix}-${step}`
 * would never be generated. The variable is the same token either way.
 */
function Swatch({ token, label }: { token: string; label: string }) {
  return (
    <div
      className="flex h-14 items-end rounded-md p-1.5 shadow-rim ring-1 ring-bone-50/10"
      style={{ background: `var(--color-${token})` }}
    >
      <span className="text-[9px] font-bold mix-blend-difference text-bone-50">
        {label}
      </span>
    </div>
  );
}
