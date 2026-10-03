"use client";

/**
 * Opponent seat pods, positioned from the geometry engine.
 *
 * Pods are vertical (avatar above a name) rather than horizontal. A
 * horizontal pod is ~140px wide, which does not fit against the left or
 * right edge of a 390px phone, and collides with its neighbours when
 * four of them share the top edge. Vertical is ~64px and fits every
 * seat count on every device, so there is one pod shape, not three.
 */

import { memo, type CSSProperties } from "react";
import { Bot } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { SeatId } from "@/engine/types";
import type { Density } from "./geometry";
import { useGeometry } from "./store";
import { TRANSITIONS } from "@/motion/presets";
import { Avatar } from "@/ui/primitives/Avatar";
import { WeakLinkIcon } from "@/ui/primitives/WeakLinkIcon";
import { Stats, type Stat, type StatLines } from "@/ui/primitives/Stats";
import { CountdownRing } from "@/ui/primitives/CountdownRing";

/** One labelled number on a pod: "Bid 4", "Cards 7" — see `Stats`. */
export type SeatStat = Stat;

export interface SeatView {
  seat: SeatId;
  name: string;
  /** Avatar tint. Any CSS colour. */
  colour: string;
  /**
   * The numbers under the name, labelled — at most two lines, each a list
   * of stats. The label is quiet and the number is not, in one style for
   * every game.
   *
   * They used to be bare: "7 cards · 45", "4 · won 2 · 120". A second
   * number with no label means nothing to anybody who did not write it,
   * and joined onto one line it was wider than the pod and cut off. The
   * second line may still truncate; each game keeps its first one short.
   */
  stats?: StatLines;
  /** A word that says more than the numbers would: "Folded", "Out". */
  status?: string;
  /** Highlights the pod and shows a pulse. */
  active?: boolean;
  thinking?: boolean;
  /** Out for the rest of the game — LRC's elimination, a future game's
   * fold/bust. Dims the pod; it stays in the ring rather than
   * disappearing, since the seat itself is still a real position other
   * players' relative left/right depends on. */
  eliminated?: boolean;
  /** This seat won. GameHost sets this from `live.winner`, which (unlike
   * `live.showSummary`) is public the instant the game ends — so the
   * crown lands on the table itself before GameEndSummary covers it,
   * the same "show it, THEN summarize it" pacing the endHoldMs pause
   * exists for. */
  winning?: boolean;
  /**
   * This seat is the HERO's partner — Spades' 2v2 partnership, the first
   * game with any team concept in this app. Purely a rung-1/2 ambient
   * cue (POLICY.md): a small always-visible tag, same weight as `stats`.
   * The hero's own pod never renders here at all (SeatRing filters it
   * out below), so this only ever needs to answer one question — "is
   * THIS pod my partner or an opponent" — not represent teams in the
   * abstract, which is why it's a boolean rather than a team index.
   */
  partner?: boolean;
  /**
   * Dealer/small-blind/big-blind marker — poker's own addition; every
   * other game leaves this unset. Deliberately a single badge per seat,
   * even heads-up (where the button seat is technically also the small
   * blind): real tables mark it with one disc, and the other seat still
   * reads unambiguously as the big blind. See `positionBadge` in
   * `src/games/poker/state.ts` for how it's derived.
   */
  badge?: "D" | "SB" | "BB";
  /**
   * A real person owns this seat and a bot is playing it for them — they
   * closed the tab, their phone slept, or they stepped out to the lobby.
   *
   * Only ever true online, and only for a seat with an OWNER: a seat
   * nobody ever sat in is played by a bot too, but there is nothing there
   * to have gone away, and flagging it would tell every table with an
   * empty chair that somebody had abandoned it. The distinction is made
   * where the frame is read (`awayFrom`), not here.
   *
   * Why it needs saying at all: from the other side of the table a bot
   * playing Bo's hand is indistinguishable from Bo playing it — same
   * name, same pod, same tiles — so the table quietly stops being the
   * game people think they are in. Rung 1/2 per POLICY.md, the same
   * always-visible ambient weight as `partner`.
   */
  away?: boolean;
  /**
   * Nobody owns this seat: a bot plays it, and from a person's table a
   * bot named Kofi looks like a friend named Kofi (reported 2026-09-29,
   * three friends at a Dominoes table). Only online, where the seat has
   * no name of a person's; solo, every opponent is a bot and saying so
   * on every pod would be noise. Never true together with `away`.
   */
  bot?: boolean;
  /**
   * Their photo (`photoUrl`), in a room where they took one — laid over by
   * `GameHost`'s `seatExtras`, never by a game. Initials stay underneath.
   */
  photo?: string | null;
  /**
   * The last thing they said in the room's chat — shown beside the pod by
   * `SeatBubbles` if it is new, never by the pod itself. Laid over by
   * `seatExtras`, like `photo`.
   */
  bubble?: { id: number; text: string } | null;
  /**
   * Their connection is slow right now (`MemberView.weak`) — a translucent
   * pulsing wifi glyph on the avatar's top-right corner, the one corner no
   * other marker claims. Laid over by `seatExtras`, like `photo`. Not drawn
   * once `away`: a bot is playing then, and the link is beside the point.
   */
  weakLink?: boolean;
  /**
   * The turn timer's clock on this seat's move: a ring round the pod that
   * empties, green to amber at half to red at a fifth (the user, 2026-09-29).
   * `endsAt` is by `Date.now()`. Laid over by `GameHost`, never by a game.
   */
  timer?: { key: string; totalMs: number; endsAt: number } | null;
}

/**
 * Pod dimensions per density tier. `compact`/`regular` keep the numbers
 * this component always had; `wide` steps up noticeably rather than a
 * token amount — that tier spans a 1024px laptop to a big desktop
 * monitor, and a pod sized for the former reads as undersized on the
 * latter, the same gap `DENSITY.wide` in geometry.ts exists to close for
 * pieces. Full literal class strings, not built from `density` at
 * runtime — Tailwind only picks up classes that appear as literal
 * substrings in source, and a lookup table keyed by a runtime value is
 * exactly that (unlike `w-${x}`, which it can't see).
 */
//
// Tight vertical spacing on the two phone tiers: a pod carries up to two
// lines under its name (`POD_LINES`), and at compact density a top-edge
// pod's centre is only 37px from the top of the screen — any taller and
// its avatar goes off the top.
//
// Retuned 2026-09-28 from both ends at once: on a phone, beside a board now
// fitted to its room, 64px pods with 9px stats read too small and cut "Bid 3
// · Won 0" to "Bid …"; on a laptop the 96px pods were among the biggest
// things on the table. Keep `POD_SIZE` in geometry.ts in step (measured).
const POD_STYLES: Record<Density, { pod: string; avatar: number; name: string; meta: string }> = {
  compact: { pod: "w-19 gap-0.5 py-1", avatar: 32, name: "text-[12px]", meta: "text-[10px]" },
  regular: { pod: "w-19 gap-0.5 py-1", avatar: 32, name: "text-[12px]", meta: "text-[10px]" },
  wide: { pod: "w-20 gap-0.5 py-1.5", avatar: 38, name: "text-[13px]", meta: "text-[11px]" },
};

export function SeatRing({ players }: { players: readonly SeatView[] }) {
  const geometry = useGeometry();
  if (!geometry) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-800">
      {geometry.seats
        .filter((slot) => !slot.isHero)
        .map((slot) => {
          const view = players.find((p) => p.seat === slot.seat);
          if (!view) return null;
          return (
            <div
              key={slot.seat}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: slot.x, top: slot.y }}
            >
              <SeatPod view={view} density={geometry.density} solid={geometry.tuck} />
            </div>
          );
        })}
    </div>
  );
}

/**
 * Lines a pod may carry under the name, all told. The geometry sizes every
 * pod for this (`POD_SIZE`); a third line made a top-edge pod taller than
 * its slot, so its avatar went off the top of the screen and its last line
 * sat under its own cards. "Away", "Partner" and a status word come first
 * — they change how the numbers read — and the numbers take what is left.
 *
 * The words share ONE line, so the numbers always keep at least one. Each
 * had a line of its own until a bot partner (2026-10-01): "Bot" and
 * "Partner" took both, and the pod never said what they bid or won.
 */
const POD_LINES = 2;

/**
 * `solid`: the seat's hand is tucked BEHIND this pod (phones — see
 * `TableGeometry.tuck`), so the pod has to be opaque. Translucent, the white
 * backs of the cards behind it washed its stats out to grey on grey.
 */
export const SeatPod = memo(function SeatPod({
  view,
  density,
  solid,
}: {
  view: SeatView;
  density: Density;
  solid: boolean;
}) {
  const highlighted = view.active || view.winning;
  const s = POD_STYLES[density];
  const tags = podTags(view);
  return (
    <motion.div
      initial={false}
      animate={{ scale: highlighted ? 1.06 : 1, opacity: view.eliminated ? 0.45 : 1 }}
      transition={TRANSITIONS.ui}
      className={`relative flex ${s.pod} flex-col items-center rounded-xl px-1 backdrop-blur-md transition-colors ${
        highlighted
          ? `${solid ? "bg-felt-950" : "bg-felt-950/70"} ring-1 ring-brass-400 shadow-[0_0_20px_rgb(212_175_106/0.35)]`
          : `${solid ? "bg-felt-950" : "bg-felt-950/55"} ring-1 ring-brass-400/20`
      }`}
    >
      {view.timer ? (
        // ON the pod's own edge, not outside it: a side pod sits flush with
        // the screen's edge on a phone, and a ring outside it lost that side
        // to the table's clipping (seen in a screenshot).
        <CountdownRing
          key={view.timer.key}
          totalMs={view.timer.totalMs}
          endsAt={view.timer.endsAt}
          radius="0.75rem"
          offset={0}
        />
      ) : null}
      <div className="relative">
        <AnimatePresence>{view.winning ? <WinnerCrown /> : null}</AnimatePresence>
        <Avatar
          name={view.name}
          colour={view.colour}
          size={s.avatar}
          src={view.photo}
          // The pod itself fades an eliminated seat; the avatar only greys.
          style={{ filter: view.eliminated ? "grayscale(1)" : undefined }}
        />
        {view.thinking ? <ThinkingRing /> : null}
        {view.badge ? <PositionBadge label={view.badge} /> : null}
        {view.away ? <AwayBadge name={view.name} /> : view.bot ? <BotBadge name={view.name} /> : null}
        <WeakLinkIcon
          show={Boolean(view.weakLink) && !view.away}
          label={`${view.name}'s connection is slow`}
          size={10}
          className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-felt-950 ring-1 ring-felt-950/60"
        />
      </div>

      <div
        className={`max-w-full truncate ${s.name} leading-none font-semibold ${
          // Their name, in the weight of somebody not at the table. The
          // badge says a bot is playing; this stops the pod from reading
          // as fully present at a glance, which is how you actually take
          // a table in.
          view.away ? "text-bone-400" : "text-bone-50"
        }`}
      >
        {view.name}
      </div>

      {tags.length > 0 ? (
        // A gap rather than " · " between the words: the dot and its spaces
        // cost the 2px that clipped "Away Partner" on a laptop pod, and each
        // word's own colour already tells them apart.
        <div className={`flex max-w-full gap-1 ${s.meta} leading-none whitespace-nowrap`}>
          {tags.map((tag, i) => (
            <span
              key={tag.text}
              className={`${tag.className} ${i === tags.length - 1 ? "min-w-0 truncate" : "shrink-0"}`}
              style={tag.style}
            >
              {tag.text}
            </span>
          ))}
        </div>
      ) : null}

      <Stats lines={view.stats ?? []} max={POD_LINES - (tags.length > 0 ? 1 : 0)} className={s.meta} />
    </motion.div>
  );
});

/** The words a pod carries before its numbers, in the order they read. */
function podTags(view: SeatView): Array<{ text: string; className: string; style?: CSSProperties }> {
  const tags: Array<{ text: string; className: string; style?: CSSProperties }> = [];
  // "Away" in `warn` rather than in the pod's ordinary muted tone: it has
  // to be findable at a glance across a table, and it sits directly above
  // the stats, whose labels are bone-400. Not `loss` — nothing has gone
  // wrong, somebody is just not here.
  if (view.away) tags.push({ text: "Away", className: "font-bold", style: { color: "var(--color-warn)" } });
  else if (view.bot) tags.push({ text: "Bot", className: "font-bold text-bone-300" });
  if (view.partner) tags.push({ text: "Partner", className: "font-bold text-brass-300/90" });
  if (view.status) tags.push({ text: view.status, className: "text-bone-400" });
  return tags;
}

/**
 * Dealer/small-blind/big-blind marker — poker only; every other game
 * leaves `SeatView.badge` unset. Rests on the avatar's own corner
 * rather than appending above it, the same "overlap, don't add height"
 * reasoning `WinnerCrown`'s own doc gives: a top-row pod's headroom is
 * thin by design, so this has to fit within the avatar's existing
 * footprint. Opposite corner from `WinnerCrown` (top) so the two never
 * fight for the same few pixels on a seat that's both dealer and, on
 * the final hand, the match winner.
 */
function PositionBadge({ label }: { label: "D" | "SB" | "BB" }) {
  const title = label === "D" ? "Dealer" : label === "SB" ? "Small blind" : "Big blind";
  return (
    <div
      aria-label={title}
      title={title}
      className="absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brass-400 px-1 text-[9px] leading-none font-extrabold text-felt-950 ring-1 ring-felt-950/60"
    >
      {label}
    </div>
  );
}

/**
 * "A bot is playing this hand."
 *
 * Bottom-LEFT of the avatar, which is the one corner nothing else claims:
 * `PositionBadge` owns bottom-right and `WinnerCrown` the top edge, and a
 * seat can genuinely be all three at once — poker's dealer steps away and
 * their bot wins the match. Sized and shaped like `PositionBadge` so the
 * two read as one family of marker rather than two ideas.
 *
 * A glyph rather than the word, because the pod is 64px wide at compact
 * density and "Away" already has the line below the name. `title` and
 * `aria-label` carry the whole sentence for anyone who needs it.
 */
function AwayBadge({ name }: { name: string }) {
  const title = `${name} stepped away — a bot is playing this seat`;
  return (
    <div
      aria-label={title}
      title={title}
      className="absolute -bottom-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full bg-bone-200 text-felt-950 ring-1 ring-felt-950/60"
    >
      <Bot size={10} strokeWidth={2.5} aria-hidden />
    </div>
  );
}

/** The same marker for a seat with no person in it: this one is a bot. */
function BotBadge({ name }: { name: string }) {
  const title = `${name} is a bot`;
  return (
    <div
      aria-label={title}
      title={title}
      className="absolute -bottom-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full bg-bone-200 text-felt-950 ring-1 ring-felt-950/60"
    >
      <Bot size={10} strokeWidth={2.5} aria-hidden />
    </div>
  );
}

/** Bot deliberation, made visible. */
function ThinkingRing() {
  return (
    <motion.span
      aria-hidden
      className="absolute -inset-0.5 rounded-full border border-brass-300"
      animate={{ opacity: [0.15, 0.85, 0.15], scale: [1, 1.14, 1] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

/**
 * The per-seat echo of GameEndSummary's winner callout, landing on the
 * table itself the instant `live.winner` is known (see the `winning`
 * doc on SeatView) — well before the summary panel does, per the same
 * "show it, then summarize it" pacing endHoldMs exists for.
 *
 * Rests ON the avatar's own top edge rather than floating clear above
 * it with a gap: TableSurface clips its contents (`overflow-hidden`),
 * and a top-row pod's own headroom above it is thin by design (14–24px
 * of `ringPad`, tuned only for the pod itself) — a crown hovering a
 * full ~20px above the avatar reliably poked past that and got clipped
 * at the screen edge. Overlapping the avatar instead of appending above
 * it means the crown never needs more vertical room than the pod
 * already has, on any seat, at any density.
 *
 * Motion: a settle-style entrance (no bounce, matching the app's whole
 * direction — see layout.ts/CLAUDE.md), then a slow, gentle float while
 * it holds, small enough to stay within that same margin. That float is
 * ambient idle motion, not a bounce: it never overshoots or rebounds,
 * just drifts up and back on a long, easeInOut sine — the same category
 * of motion as ThinkingRing's pulse just above it in this file, not the
 * bounce the rest of the app deliberately avoids.
 */
function WinnerCrown() {
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute -top-1.5 left-1/2 -translate-x-1/2 text-sm"
      style={{ filter: "drop-shadow(0 0 5px rgb(212 175 106 / 0.65))" }}
      initial={{ opacity: 0, scale: 0.5, y: 3 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.6, y: 3 }}
      transition={TRANSITIONS.deal}
    >
      <motion.span
        className="block"
        animate={{ y: [0, -1.5, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      >
        👑
      </motion.span>
    </motion.div>
  );
}

