"use client";

/**
 * Redaction harness.
 *
 * The question this page exists to answer: when the same dealt hand is
 * shown to different seats, does each one see exactly what it should —
 * and, more importantly, is what the client actually HOLDS free of
 * everything it should not?
 *
 * A side-by-side of two viewers would be the obvious shape and is not
 * available: the placement store is a module-level singleton, one table
 * per tab by design (see store.ts). Switching the viewer over a single
 * frozen state turns out to be the better tool anyway. Nothing moves
 * except perspective, so a card that changes from a back to a face when
 * it should not is obvious in a way a static side-by-side would not make
 * obvious at all.
 *
 * The audit strip under the controls is the part that actually proves
 * something. Looking right is necessary but not sufficient — a face-down
 * card whose real id is still sitting in the store looks perfect and is
 * completely broken. So the page re-derives, from the true state, every
 * id this viewer must not be able to name, and reports whether any of
 * them survived into the redacted payload.
 */

import { useEffect, useMemo, useState } from "react";
import { Control, DeviceFrame, DEVICES, LabPanel, SegButton, type DeviceKey } from "@/lab/LabShell";
import type { GameDefinition, PieceId, SeatId } from "@/engine/types";
import { createRng } from "@/engine/rng";
import { createDominoes } from "@/games/dominoes/rules";
import { createLrc } from "@/games/lrc/rules";
import { createPoker } from "@/games/poker/rules";
import { createRummy } from "@/games/rummy/rules";
import { createSpades } from "@/games/spades/rules";
import { botName } from "@/games/_shared/botIdentity";
import { redactPlacements } from "@/session/redact";
import { createBs } from "@/games/bs/rules";
import { SeatRing } from "@/table/SeatRing";
import { TableSurface } from "@/table/TableSurface";
import { useTableStore } from "@/table/store";

type GameKey = "spades" | "dominoes" | "poker" | "rummy" | "lrc" | "bs";

/**
 * Seats are fixed per game rather than adjustable: this page is about
 * WHO CAN SEE WHAT, and a seat-count slider is what `/lab/seats` is for.
 */
const GAMES: Record<
  GameKey,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { label: string; seats: number; make: () => GameDefinition<any, any> }
> = {
  spades: { label: "Spades", seats: 4, make: () => createSpades() },
  dominoes: { label: "Dominoes", seats: 4, make: () => createDominoes() },
  poker: { label: "Poker", seats: 4, make: () => createPoker() },
  rummy: { label: "Rummy", seats: 4, make: () => createRummy() },
  lrc: { label: "LRC", seats: 4, make: () => createLrc() },
  // The hardest subject this page has: BS's pile is a growing stack of cards
  // that are face down to EVERYBODY, its own contributor included, so almost
  // every piece on the table is one the viewer must not be able to name.
  bs: { label: "BS", seats: 4, make: () => createBs() },
};

/**
 * Every id the viewer must not be able to name, read off the TRUE state.
 *
 * Deliberately derived from the true placements rather than from each
 * game's own state shape: "drawn face down" is the same rule the redactor
 * itself applies, so auditing against it checks the redactor did its job
 * consistently, and it needs no per-game knowledge to stay correct when a
 * sixth game arrives.
 */
function secretsFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: GameDefinition<any, any>,
  state: unknown,
  viewer: SeatId,
): PieceId[] {
  const truth = definition.placements(state, viewer);
  return Object.entries(truth)
    .filter(([, p]) => !p.faceUp)
    .map(([id]) => id);
}

export default function RedactLab() {
  const [game, setGame] = useState<GameKey>("spades");
  const [device, setDevice] = useState<DeviceKey>("desktop");
  const [viewer, setViewer] = useState(0);
  const [seed, setSeed] = useState(4242);

  const { definition, seats } = useMemo(() => {
    const entry = GAMES[game];
    return { definition: entry.make(), seats: entry.seats };
  }, [game]);

  // One deal, held still. Every control except the seed re-reads it
  // rather than re-dealing, which is what makes a perspective change the
  // only variable in the room.
  const state = useMemo(() => {
    const rng = createRng(seed);
    const base = definition.setup({ seats, rng });
    return definition.startRound ? definition.startRound(base, rng).state : base;
  }, [definition, seats, seed]);

  const audit = useMemo(() => {
    const meta = definition.pieces(state);
    const truth = definition.placements(state, viewer);
    const { placements, meta: standIns } = redactPlacements(truth, meta);
    const secrets = secretsFor(definition, state, viewer);
    const wire = JSON.stringify(placements);
    const leaked = secrets.filter((id) => wire.includes(`"${id}"`));
    return {
      placements,
      meta: { ...meta, ...standIns },
      secrets: secrets.length,
      standIns: Object.keys(standIns).length,
      visible: Object.values(truth).filter((p) => p.faceUp).length,
      leaked,
    };
  }, [definition, state, viewer]);

  const reset = useTableStore((s) => s.reset);
  useEffect(() => {
    reset(audit.placements, audit.meta);
  }, [audit, reset]);

  const players = useMemo(
    () =>
      Array.from({ length: seats }, (_, seat) => ({
        seat,
        name: seat === viewer ? "You (viewer)" : botName(seat),
        colour: seat === viewer ? "var(--color-brass-300)" : "#a0a8c9",
      })).filter((p) => p.seat !== viewer),
    [seats, viewer],
  );

  const clean = audit.leaked.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <LabPanel>
        <Control label="Game">
          <SegButton
            options={(Object.keys(GAMES) as GameKey[]).map((k) => ({
              value: k,
              label: GAMES[k].label,
            }))}
            value={game}
            onChange={(v) => {
              setGame(v);
              setViewer(0);
            }}
          />
        </Control>

        <Control label="Viewing as">
          <SegButton
            options={Array.from({ length: seats }, (_, s) => ({
              value: String(s),
              label: s === 0 ? "Seat 0" : `Seat ${s}`,
            }))}
            value={String(viewer)}
            onChange={(v) => setViewer(Number(v))}
          />
        </Control>

        <Control label="Device">
          <SegButton
            options={(Object.keys(DEVICES) as DeviceKey[]).map((k) => ({ value: k, label: k }))}
            value={device}
            onChange={setDevice}
          />
        </Control>

        <Control label="Deal">
          <SegButton
            options={[
              { value: "4242", label: "A" },
              { value: "909", label: "B" },
              { value: "31337", label: "C" },
            ]}
            value={String(seed)}
            onChange={(v) => setSeed(Number(v))}
          />
        </Control>
      </LabPanel>

      {/*
        The audit. Green is not "it looks right" — it is "every id this
        seat is not entitled to is absent from what the client holds."
      */}
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl px-4 py-3 text-sm"
        style={{
          background: clean ? "color-mix(in oklab, var(--color-win) 14%, transparent)" : "color-mix(in oklab, var(--color-loss) 20%, transparent)",
          border: `1px solid ${clean ? "var(--color-win)" : "var(--color-loss)"}`,
        }}
      >
        <span className="font-semibold" style={{ color: clean ? "var(--color-win)" : "var(--color-loss)" }}>
          {clean ? "No leaks" : `${audit.leaked.length} LEAKED`}
        </span>
        <span className="text-bone-400">
          <span className="tnum text-bone-200">{audit.visible}</span> visible
        </span>
        <span className="text-bone-400">
          <span className="tnum text-bone-200">{audit.secrets}</span> concealed
        </span>
        <span className="text-bone-400">
          <span className="tnum text-bone-200">{audit.standIns}</span> stand-ins
        </span>
        {!clean && (
          <span className="font-mono text-xs" style={{ color: "var(--color-loss)" }}>
            {audit.leaked.slice(0, 8).join(" ")}
            {audit.leaked.length > 8 ? " …" : ""}
          </span>
        )}
      </div>

      <DeviceFrame device={device}>
        <TableSurface seats={seats} fill="parent">
          <SeatRing players={players} />
        </TableSurface>
      </DeviceFrame>
    </div>
  );
}
