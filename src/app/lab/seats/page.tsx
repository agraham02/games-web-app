"use client";

/**
 * Seat-ring harness.
 *
 * The question this page exists to answer: does the table hold up at
 * every seat count on every device? Drag the slider from 2 to 10 and
 * watch where the pods land — the hero must stay pinned bottom-centre
 * and nothing may overlap or hang off an edge.
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
import { cardFixture, makePlayers, tileFixture } from "@/lab/fixtures";
import { TableSurface } from "@/table/TableSurface";
import { SeatRing } from "@/table/SeatRing";
import { useTableStore } from "@/table/store";
import { applyEventToTable } from "@/table/applyEvent";
import { useChoreographer } from "@/motion/useChoreographer";

type PieceSet = "cards" | "tiles";

export default function SeatsLab() {
  const [seats, setSeats] = useState(6);
  const [device, setDevice] = useState<DeviceKey>("phone");
  const [guides, setGuides] = useState(true);
  const [pieceSet, setPieceSet] = useState<PieceSet>("cards");
  const [activeSeat, setActiveSeat] = useState(1);

  const reset = useTableStore((s) => s.reset);
  const { push, skip, isPlaying } = useChoreographer({
    apply: applyEventToTable,
  });

  const perHand = pieceSet === "tiles" ? 7 : seats > 6 ? 5 : 7;

  const fixture = useMemo(
    () =>
      pieceSet === "tiles"
        ? tileFixture({ seats: Math.min(seats, 4), perHand })
        : cardFixture({ seats, perHand }),
    [seats, perHand, pieceSet],
  );

  const players = useMemo(
    () => makePlayers(seats, { activeSeat }),
    [seats, activeSeat],
  );

  // Re-stack the deck and deal again whenever the shape of the table
  // changes, so what is on screen always matches the controls.
  useEffect(() => {
    reset(fixture.placements, fixture.meta);
    const id = setTimeout(() => push(fixture.dealEvents), 120);
    return () => clearTimeout(id);
  }, [fixture, reset, push]);

  const dealAgain = () => {
    reset(fixture.placements, fixture.meta);
    push(fixture.dealEvents);
  };

  return (
    <>
      <LabPanel>
        <Control label={`Seats — ${seats}`}>
          <input
            type="range"
            min={2}
            max={10}
            value={seats}
            onChange={(e) => {
              const n = Number(e.target.value);
              setSeats(n);
              setActiveSeat((a) => Math.min(Math.max(1, a), n - 1));
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

        <Control label="Pieces">
          <SegButton
            value={pieceSet}
            onChange={setPieceSet}
            options={[
              { value: "cards", label: "Cards" },
              { value: "tiles", label: "Dominoes" },
            ]}
          />
        </Control>

        <Control label={`Thinking seat — ${activeSeat}`}>
          <input
            type="range"
            min={1}
            max={Math.max(1, seats - 1)}
            value={activeSeat}
            onChange={(e) => setActiveSeat(Number(e.target.value))}
            className="w-full accent-brass-400"
          />
        </Control>

        <div className="flex flex-wrap gap-2">
          <LabButton tone="primary" onClick={dealAgain}>
            Deal again
          </LabButton>
          <LabButton onClick={skip} disabled={!isPlaying}>
            Skip
          </LabButton>
          <LabButton onClick={() => setGuides((g) => !g)}>
            {guides ? "Hide guides" : "Show guides"}
          </LabButton>
        </div>

        {pieceSet === "tiles" && seats > 4 ? (
          <p className="rounded-lg bg-warn/10 p-2.5 text-[11px] leading-relaxed text-warn ring-1 ring-warn/25">
            Block &amp; Draw seats 2–4. The ring still renders {seats} seats —
            only the tiles are capped.
          </p>
        ) : null}

        <p className="text-[11px] leading-relaxed text-bone-400">
          Hero is always seat 0, bottom centre. Seat 1 is the hero&apos;s left;
          numbering runs anticlockwise, matching the direction turn order
          passes.
        </p>
      </LabPanel>

      <DeviceFrame device={device}>
        <TableSurface
          fill="parent"
          seats={seats}
          density={DEVICES[device].density}
          showGuides={guides}
        >
          <SeatRing players={players} />
        </TableSurface>
      </DeviceFrame>
    </>
  );
}
