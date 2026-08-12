"use client";

/**
 * Phase-screen gallery.
 *
 * These shells are shared by all five games; only their slot content
 * differs. Reviewing them here, against a real table, is how we catch a
 * screen that reads fine in isolation and badly over felt.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Control,
  DeviceFrame,
  DEVICES,
  LabButton,
  LabPanel,
  SegButton,
  type DeviceKey,
} from "@/lab/LabShell";
import { cardFixture, makePlayers } from "@/lab/fixtures";
import { TableSurface } from "@/table/TableSurface";
import { SeatRing } from "@/table/SeatRing";
import { useTableStore } from "@/table/store";
import { applyEventToTable } from "@/table/applyEvent";
import { useChoreographer } from "@/motion/useChoreographer";
import {
  GameEndSummary,
  RoundEndScorecard,
  RoundIntro,
  TurnIndicator,
  type ScoreRow,
} from "@/ui/phases/PhaseScreens";

type Phase = "none" | "intro" | "turn" | "roundEnd" | "gameEnd";

const PHASES: ReadonlyArray<{ value: Phase; label: string }> = [
  { value: "none", label: "Table" },
  { value: "intro", label: "Round intro" },
  { value: "turn", label: "Turn HUD" },
  { value: "roundEnd", label: "Round end" },
  { value: "gameEnd", label: "Game end" },
];

export default function PhasesLab() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [device, setDevice] = useState<DeviceKey>("phone");
  const seats = 4;

  const reset = useTableStore((s) => s.reset);
  const { push } = useChoreographer({ apply: applyEventToTable });

  const fixture = useMemo(() => cardFixture({ seats, perHand: 7 }), []);
  const players = useMemo(() => makePlayers(seats), []);

  useEffect(() => {
    reset(fixture.placements, fixture.meta);
    const id = setTimeout(() => push(fixture.dealEvents), 150);
    return () => clearTimeout(id);
  }, [fixture, reset, push]);

  const rows: ScoreRow[] = [
    {
      seat: 0, name: "You", colour: "#e3c68f",
      detail: "bid 4 · won 5", delta: 41, total: 221,
    },
    {
      seat: 1, name: "Mia", colour: "#c9a0a0",
      detail: "bid 3 · won 3", delta: 30, total: 198,
    },
    {
      seat: 2, name: "Sam", colour: "#a0a8c9",
      detail: "nil · took 1 trick", delta: -100, total: 42,
    },
    {
      seat: 3, name: "Kofi", colour: "#c9bfa0",
      detail: "bid 4 · won 2", flag: "3 bags", delta: -40, total: 115,
    },
  ];

  return (
    <>
      <LabPanel>
        <Control label="Phase">
          <SegButton value={phase} onChange={setPhase} options={PHASES} />
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

        <LabButton
          tone="primary"
          onClick={() => {
            reset(fixture.placements, fixture.meta);
            push(fixture.dealEvents);
          }}
        >
          Re-deal behind
        </LabButton>

        <p className="text-[11px] leading-relaxed text-bone-400">
          Round end and game end are full-height on a phone and a centred card
          from <code className="text-brass-300">sm:</code> up — one component,
          so a game never decides which it is on.
        </p>
      </LabPanel>

      <DeviceFrame device={device}>
        <TableSurface
          fill="parent"
          seats={seats}
          density={DEVICES[device].density}
        >
          <SeatRing players={players} />

          <RoundIntro
            show={phase === "intro"}
            eyebrow="Round 3 of 7"
            title="Spades"
          />

          <TurnIndicator label="Your turn" show={phase === "turn"} />

          <RoundEndScorecard
            show={phase === "roundEnd"}
            eyebrow="Round 3 of 7"
            title="Hand complete"
            rows={rows}
            note={{
              tone: "warn",
              title: "Bag warning",
              body: "Kofi is at 9 bags. One more triggers the −100 penalty.",
            }}
            onContinue={() => setPhase("none")}
          />

          <GameEndSummary
            show={phase === "gameEnd"}
            winnerName="You"
            winnerColour="#e3c68f"
            subtitle="521 points · 7 rounds"
            standings={[
              { seat: 0, name: "You", total: 521 },
              { seat: 1, name: "Mia", total: 468 },
              { seat: 3, name: "Kofi", total: 302 },
              { seat: 2, name: "Sam", total: 154 },
            ]}
            stats={[
              { label: "Best round", value: "+141" },
              { label: "Nils made", value: "2 / 3" },
              { label: "Bags", value: "6" },
            ]}
            onRematch={() => setPhase("intro")}
            onLobby={() => setPhase("none")}
          />
        </TableSurface>
      </DeviceFrame>
    </>
  );
}
