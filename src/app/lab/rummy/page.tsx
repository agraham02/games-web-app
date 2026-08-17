"use client";

/**
 * Rummy 500 — board disclosure prototype. Fixtures only, no rules.
 *
 * This is the hardest UI problem in the project: with six players there
 * can be eighteen melds on the table, and the player needs to know what
 * is layable and how deep the discard pile is eligible — without the
 * screen turning into a spreadsheet and without stopping play to find
 * out.
 *
 * Three tiers were prototyped here, each costing strictly more attention
 * than the last:
 *
 *  1. AMBIENT   Each pod carries a micro-strip of that player's melds.
 *  2. PEEK RAIL A strip above the hand listing every meld on the board.
 *               Drag or tap to open. Never covers your own hand.
 *  3. LAY-OFF   Select a card: invalid melds dim, valid ones light and
 *               show exactly where the card lands.
 *
 * **The shipped game kept only tier 2, and this file is now a record of
 * what was tried rather than of what is.** Tier 1 restated the sheet in
 * truncated text and was cut. Tier 3 is exactly the hand-holding the
 * real game refuses: lighting the melds a selected card can join answers
 * the question the game is asking. Same for the discard pile's lit
 * eligible depth below — the real pile lights nothing.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Control,
  DeviceFrame,
  DEVICES,
  LabButton,
  LabPanel,
  SegButton,
  type DeviceKey,
} from "@/lab/LabShell";
import { makePlayers, meldLabel, rummyBoard, type MeldView } from "@/lab/fixtures";
import { TableSurface } from "@/table/TableSurface";
import { SeatRing } from "@/table/SeatRing";
import { useGeometry, useTableStore } from "@/table/store";
import type { PieceId, PlacementMap } from "@/engine/types";
import { HERO } from "@/engine/types";
import type { PieceMeta } from "@/table/store";
import { CardFace } from "@/ui/primitives/CardFace";
import { PeekRail } from "@/ui/disclosure/PeekRail";
import {
  parseCard,
  rankValue,
  shuffledDeck,
  standardDeck,
} from "@/games/_shared/cards";
import { createRng } from "@/engine/rng";

/** Chosen so lay-off has interesting answers: H8 fits a run AND a set. */
const HERO_HAND: PieceId[] = ["H8", "C5", "C6", "D9", "S3", "H4", "DA"];
/** Deepest eligible card first — you may take from there down. */
const DISCARD: PieceId[] = ["S9", "S10", "SJ", "SK", "D2"];
const ELIGIBLE_FROM_INDEX = 2;

export default function RummyLab() {
  const [seats, setSeats] = useState(6);
  const [device, setDevice] = useState<DeviceKey>("phone");
  const [selected, setSelected] = useState<PieceId | null>(null);
  const [snap, setSnap] = useState(0);

  const reset = useTableStore((s) => s.reset);
  const patch = useTableStore((s) => s.patch);

  const board = useMemo(() => rummyBoard(seats), [seats]);
  const players = useMemo(() => makePlayers(seats, { melds: true }), [seats]);

  const fixture = useMemo(() => buildBoard(board), [board]);

  // Only syncs the external store. Clearing the selection is an
  // event-driven reset and lives on the control that caused it.
  useEffect(() => {
    reset(fixture.placements, fixture.meta);
  }, [fixture, reset]);

  const validMelds = useMemo(
    () => (selected ? board.filter((m) => canLayOff(selected, m.cards)) : []),
    [selected, board],
  );

  const onPieceTap = (id: PieceId) => {
    const { placements } = useTableStore.getState();
    const p = placements[id];
    if (!p) return;

    // Only the hero's own cards enter lay-off mode.
    if (p.zone !== "hand" || (p.seat ?? HERO) !== HERO) return;

    if (selected === id) {
      patch(id, { selected: false });
      setSelected(null);
      setSnap(0);
      return;
    }
    if (selected) patch(selected, { selected: false });
    patch(id, { selected: true });
    setSelected(id);
    setSnap(2); // Opening the rail IS the answer to "where can this go?"
  };

  return (
    <>
      <LabPanel>
        <Control label={`Seats — ${seats}`}>
          <input
            type="range"
            min={2}
            max={8}
            value={seats}
            onChange={(e) => {
              setSeats(Number(e.target.value));
              setSelected(null);
              setSnap(0);
            }}
            className="w-full accent-brass-400"
          />
        </Control>

        <Control label="Device">
          <SegButton
            value={device}
            onChange={setDevice}
            options={(Object.keys(DEVICES) as DeviceKey[]).map((k) => ({
              value: k,
              label: DEVICES[k].label,
            }))}
          />
        </Control>

        <Control label="Rail">
          <SegButton
            value={String(snap)}
            onChange={(v) => setSnap(Number(v))}
            options={[
              { value: "0", label: "Peek" },
              { value: "1", label: "Half" },
              { value: "2", label: "Full" },
            ]}
          />
        </Control>

        {selected ? (
          <LabButton
            onClick={() => {
              patch(selected, { selected: false });
              setSelected(null);
              setSnap(0);
            }}
          >
            Clear selection
          </LabButton>
        ) : null}

        <div className="rounded-lg bg-felt-950/60 p-3 ring-1 ring-bone-50/8">
          <div className="eyebrow mb-1.5">Try this</div>
          <p className="text-[11px] leading-relaxed text-bone-400">
            Tap <b className="text-brass-300">8♥</b> in your hand. It extends
            Mia&apos;s <b className="text-bone-200">6♥7♥</b> run and joins
            Sam&apos;s <b className="text-bone-200">8♠8♣8♦</b> set — both light
            up, everything else dims, and your hand stays visible the whole
            time.
          </p>
        </div>

        <p className="text-[11px] leading-relaxed text-bone-400">
          {board.length} melds on the board across {seats} players.
        </p>
      </LabPanel>

      <DeviceFrame device={device}>
        <TableSurface
          fill="parent"
          seats={seats}
          density={DEVICES[device].density}
          onPieceTap={onPieceTap}
        >
          <SeatRing players={players} />
          <TableHud />
          <DiscardCallout />
          <BoardRail
            board={board}
            selected={selected}
            validMelds={validMelds}
            snap={snap}
            onSnap={setSnap}
            onCancel={() => {
              if (selected) patch(selected, { selected: false });
              setSelected(null);
              setSnap(0);
            }}
          />
        </TableSurface>
      </DeviceFrame>
    </>
  );
}

/* ============================================================
   Table furniture
   ============================================================ */

function TableHud() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-850 flex items-center justify-between px-4 pt-3.5">
      <span className="eyebrow">Rummy 500</span>
      <span className="rounded-full bg-bone-50/10 px-2.5 py-1 text-[10px] font-extrabold text-bone-200">
        You 180
      </span>
    </div>
  );
}

/** The "3 eligible" label under the discard pile. */
function DiscardCallout() {
  const geometry = useGeometry();
  if (!geometry) return null;
  const z = geometry.zones.discard;
  const eligible = DISCARD.length - ELIGIBLE_FROM_INDEX;

  return (
    <div
      className="pointer-events-none absolute z-850 text-center"
      style={{ left: z.x - z.w, top: z.y + z.h + 8, width: z.w * 3 }}
    >
      <span className="text-[10px] font-bold text-brass-300">
        {eligible} eligible · tap to take
      </span>
    </div>
  );
}

/* ============================================================
   The rail — tiers 2 and 3
   ============================================================ */

function BoardRail({
  board,
  selected,
  validMelds,
  snap,
  onSnap,
  onCancel,
}: {
  board: readonly MeldView[];
  selected: PieceId | null;
  validMelds: readonly MeldView[];
  snap: number;
  onSnap: (n: number) => void;
  onCancel: () => void;
}) {
  const geometry = useGeometry();
  if (!geometry) return null;

  const handH = geometry.zones.hand.h;
  const available = geometry.box.h - handH - 16;
  const snapPoints = [76, Math.min(240, available), Math.max(120, available)];

  const laying = Boolean(selected);
  const validIds = new Set(validMelds.map((m) => m.id));

  const header = laying ? (
    <div className="flex items-center justify-between">
      <span className="font-display text-[15px] tracking-wide text-brass-300">
        Lay off {labelOf(selected!)}
      </span>
      <span className="text-[11px] font-bold text-brass-300">
        {validMelds.length} valid
      </span>
    </div>
  ) : (
    <div className="flex items-center justify-between">
      <span className="eyebrow">Board · {board.length} melds</span>
      <span className="text-[10px] text-bone-400">
        {snap === 0 ? "drag up ↑" : "drag down ↓"}
      </span>
    </div>
  );

  return (
    <PeekRail
      snapPoints={snapPoints}
      snapIndex={snap}
      onSnapChange={onSnap}
      offsetBottom={handH}
      header={header}
      footer={
        laying ? (
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-lg bg-bone-50/6 py-3 text-xs font-semibold text-bone-200 ring-1 ring-bone-50/16"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={validMelds.length === 0}
              className="flex-[1.4] rounded-lg bg-linear-to-b from-brass-300 to-brass-500 py-3 text-xs font-extrabold text-felt-950 shadow-e2 disabled:opacity-40"
            >
              {validMelds.length ? "Lay off" : "No valid meld"}
            </button>
          </div>
        ) : null
      }
    >
      {snap === 0 ? (
        /* Peek: one scrollable line of compact labels. */
        <div className="flex gap-1.5 overflow-hidden pb-1">
          {board.map((m) => (
            <span
              key={m.id}
              className="shrink-0 rounded-lg bg-felt-950/50 px-2 py-1.5 font-rank text-[11px] font-bold text-bone-200 ring-1 ring-brass-400/18"
            >
              {meldLabel(m.cards)}
            </span>
          ))}
        </div>
      ) : (
        /* Half and full: grouped by owner, real card faces. */
        <div className="flex flex-col gap-3.5 pb-2">
          {groupByOwner(board).map(([owner, melds]) => (
            <div key={owner} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-felt-950"
                  style={{ background: melds[0]!.ownerColour }}
                >
                  {melds[0]!.ownerName.slice(0, 2).toUpperCase()}
                </span>
                <span className="text-[11px] font-semibold text-bone-200">
                  {melds[0]!.ownerName}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {melds.map((m) => (
                  <MeldGroup
                    key={m.id}
                    meld={m}
                    laying={laying}
                    valid={validIds.has(m.id)}
                    addend={selected}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </PeekRail>
  );
}

function MeldGroup({
  meld,
  laying,
  valid,
  addend,
}: {
  meld: MeldView;
  laying: boolean;
  valid: boolean;
  addend: PieceId | null;
}) {
  const lit = laying && valid;
  const dim = laying && !valid;

  return (
    <motion.div
      animate={{ opacity: dim ? 0.3 : 1, scale: lit ? 1.03 : 1 }}
      transition={{ duration: 0.2 }}
      className={`flex items-center gap-0.5 rounded-lg p-1.5 ring-1 ${
        lit
          ? "bg-felt-600/45 ring-brass-400 shadow-glow"
          : "bg-felt-950/50 ring-brass-400/18"
      }`}
    >
      {meld.cards.map((c) => (
        <CardFace key={c} card={c} w={30} h={42} detail="index" />
      ))}
      {lit && addend ? (
        <>
          <span className="mx-0.5 h-8 w-px bg-brass-400" />
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.2 }}
          >
            <CardFace card={addend} w={30} h={42} detail="index" />
          </motion.div>
        </>
      ) : null}
    </motion.div>
  );
}

/* ============================================================
   Fixture construction + lay-off rules
   ============================================================ */

function buildBoard(board: readonly MeldView[]) {
  const placements: PlacementMap = {};
  const meta: Record<PieceId, PieceMeta> = {};

  for (const card of standardDeck()) {
    meta[card.id] = { kind: "card", face: card.id };
  }

  // Real games can't collide — a single deck reduces a shuffle, not a
  // set of independent lists. This is fixture data hand-authored across
  // four separate arrays (hand, discard, eight melds), so nothing stops
  // the same card id from being written twice; `placements[id] = ...`
  // would just silently let the later zone win, leaving the earlier one
  // short a card with no error. That exact bug shipped here once
  // already (four "hand" cards were actually rendering on the board).
  // Guard the seam instead of trusting four hand-picked lists to stay
  // disjoint as this file changes.
  const claim = (id: PieceId, zone: string) => {
    const prev = placements[id];
    if (prev) {
      throw new Error(
        `Rummy lab fixture: "${id}" is claimed by both ${prev.zone} and ${zone} — pick a different card for one of them.`,
      );
    }
  };

  HERO_HAND.forEach((id, index) => {
    claim(id, "hand");
    placements[id] = {
      zone: "hand",
      seat: HERO,
      index,
      count: HERO_HAND.length,
      faceUp: true,
    };
  });

  DISCARD.forEach((id, index) => {
    claim(id, "discard");
    placements[id] = {
      zone: "discard",
      index,
      count: DISCARD.length,
      faceUp: true,
      fanned: true,
      highlighted: index >= ELIGIBLE_FROM_INDEX,
      dimmed: index < ELIGIBLE_FROM_INDEX,
    };
  });

  board.forEach((meld, group) => {
    meld.cards.forEach((id, index) => {
      claim(id, `board meld ${group}`);
      placements[id] = {
        zone: "board",
        seat: meld.owner,
        group,
        index,
        count: meld.cards.length,
        faceUp: true,
      };
    });
  });

  // Whatever is left is the stock.
  const used = new Set(Object.keys(placements));
  const rest = shuffledDeck(createRng(7)).filter((c) => !used.has(c.id));
  rest.forEach((card, index) => {
    placements[card.id] = {
      zone: "deck",
      index,
      count: rest.length,
      faceUp: false,
    };
  });

  return { placements, meta };
}

/**
 * Can `card` be added to `meld`? Sets take a matching rank in a suit not
 * already present; runs take the card immediately above or below.
 */
export function canLayOff(card: PieceId, meld: readonly PieceId[]): boolean {
  if (meld.length === 0) return false;
  const c = parseCard(card);
  const cards = meld.map(parseCard);

  const isSet = cards.every((x) => x.rank === cards[0]!.rank);
  if (isSet) {
    return c.rank === cards[0]!.rank && !cards.some((x) => x.suit === c.suit);
  }

  const isRun = cards.every((x) => x.suit === cards[0]!.suit);
  if (isRun) {
    if (c.suit !== cards[0]!.suit) return false;
    const values = cards.map((x) => rankValue(x.rank)).sort((a, b) => a - b);
    const v = rankValue(c.rank);
    return v === values[0]! - 1 || v === values[values.length - 1]! + 1;
  }

  return false;
}

function groupByOwner(
  board: readonly MeldView[],
): Array<[number, MeldView[]]> {
  const map = new Map<number, MeldView[]>();
  for (const m of board) {
    const list = map.get(m.owner);
    if (list) list.push(m);
    else map.set(m.owner, [m]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function labelOf(id: PieceId): string {
  const c = parseCard(id);
  return `${c.rank}${{ S: "♠", H: "♥", D: "♦", C: "♣" }[c.suit]}`;
}
