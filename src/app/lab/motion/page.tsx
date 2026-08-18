"use client";

/**
 * Motion harness.
 *
 * Fire the real event vocabulary at the real piece layer and judge the
 * pacing. Every button here emits the same GameEvent shape a game
 * engine will, so what you see is what a game will feel like.
 */

import { useEffect, useMemo, useState } from "react";
import type { GameEvent, PieceId } from "@/engine/types";
import { HERO } from "@/engine/types";
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
import { TurnIndicator } from "@/ui/phases/PhaseScreens";
import { announce, GameToaster } from "@/ui/disclosure";

export default function MotionLab() {
  const [seats, setSeats] = useState(4);
  const [device, setDevice] = useState<DeviceKey>("phone");
  const [speed, setSpeed] = useState(1);
  const [log, setLog] = useState<string[]>([]);

  const reset = useTableStore((s) => s.reset);
  const { push, skip, isPlaying } = useChoreographer({
    apply: (e) => {
      applyEventToTable(e);
      // Announcements are rung 3 of the disclosure ladder: they ride
      // alongside the motion and never block it.
      if (e.t === "announce") announce(e.text, e.tone);
      setLog((l) => [describe(e), ...l].slice(0, 14));
    },
    speed,
  });

  const fixture = useMemo(
    () => cardFixture({ seats, perHand: 7 }),
    [seats],
  );
  const players = useMemo(() => makePlayers(seats), [seats]);

  // Only syncs the external store. Clearing the log is an event-driven
  // reset and belongs on the control that caused it, not here.
  useEffect(() => {
    reset(fixture.placements, fixture.meta);
  }, [fixture, reset]);

  /** Reads live state so the buttons always act on what is on screen. */
  const pieces = (zone: string, seat?: number): PieceId[] => {
    const { placements } = useTableStore.getState();
    return Object.entries(placements)
      .filter(([, p]) => p.zone === zone && (seat === undefined || p.seat === seat))
      .sort((a, b) => a[1].index - b[1].index)
      .map(([id]) => id);
  };

  const deal = () => {
    reset(fixture.placements, fixture.meta);
    setLog([]);
    push(fixture.dealEvents);
  };

  /** A full trick: hero leads, each bot thinks then follows, winner sweeps. */
  const playTrick = () => {
    const events: GameEvent[] = [];
    const heroCard = pieces("hand", HERO)[0];
    if (!heroCard) return;

    events.push({ t: "play", piece: heroCard, from: HERO, to: "trick" });
    const played: PieceId[] = [heroCard];

    for (let seat = 1; seat < seats; seat++) {
      const card = pieces("hand", seat)[0];
      if (!card) continue;
      events.push({ t: "think", seat, ms: 500 + seat * 260 });
      events.push({ t: "flip", piece: card, faceUp: true });
      events.push({ t: "play", piece: card, from: seat, to: "trick" });
      played.push(card);
    }

    const winner = 1 % seats;
    events.push({
      t: "announce",
      text: `${winner === HERO ? "You" : players[winner - 1]?.name} took the trick`,
      tone: "good",
    });
    events.push({ t: "collect", pieces: played, to: winner });
    push(events);
  };

  const flipHand = () => {
    const hand = pieces("hand", HERO);
    push(hand.map((piece) => ({ t: "flip" as const, piece, faceUp: false })));
  };

  const gather = () => {
    const loose = [...pieces("trick"), ...pieces("collected")];
    push(
      loose.map((piece) => ({
        t: "move" as const,
        piece,
        to: { zone: "deck" as const, index: 0, count: loose.length, faceUp: false },
      })),
    );
  };

  /**
   * Caribbean dominoes' slam, on demand. In a real game it is a ~12%
   * roll on a tile in flight, which is a poor way to look at whether the
   * timing reads right — here it fires the exact pair of events `reduce`
   * emits (`slam`, then the `move` for the same piece) through the real
   * choreographer, so what plays is what a game plays.
   */
  const slam = () => {
    const hand = pieces("hand", HERO);
    const piece = hand[0];
    if (!piece) return;
    const table = pieces("trick");
    push([
      { t: "slam", piece, shake: table },
      {
        t: "move",
        piece,
        to: { zone: "trick", seat: HERO, index: table.length, count: table.length + 1, faceUp: true },
      },
    ]);
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
              setSeats(Number(e.target.value));
              setLog([]);
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

        <Control label={`Speed — ${speed.toFixed(2)}×`}>
          <input
            type="range"
            min={0.25}
            max={3}
            step={0.25}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="w-full accent-brass-400"
          />
        </Control>

        <Control label="Fire events">
          <div className="flex flex-wrap gap-2">
            <LabButton tone="primary" onClick={deal}>
              Deal
            </LabButton>
            <LabButton onClick={playTrick}>Play trick</LabButton>
            <LabButton onClick={flipHand}>Flip hand</LabButton>
            <LabButton onClick={gather}>Gather</LabButton>
            <LabButton onClick={slam}>Slam</LabButton>
            <LabButton onClick={skip} disabled={!isPlaying}>
              Skip
            </LabButton>
          </div>
        </Control>

        <Control label="Event log">
          <ol className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg bg-felt-950/60 p-2 font-mono text-[10px] text-bone-400 ring-1 ring-bone-50/8">
            {log.length === 0 ? (
              <li className="text-bone-600">nothing fired yet</li>
            ) : (
              log.map((l, i) => (
                <li key={i} className={i === 0 ? "text-brass-300" : undefined}>
                  {l}
                </li>
              ))
            )}
          </ol>
        </Control>
      </LabPanel>

      <DeviceFrame device={device}>
        <TableSurface
          fill="parent"
          seats={seats}
          density={DEVICES[device].density}
        >
          <SeatRing players={players} />
          <TurnIndicator label="Your turn" show={!isPlaying} />
          <GameToaster />
        </TableSurface>
      </DeviceFrame>
    </>
  );
}

function describe(e: GameEvent): string {
  switch (e.t) {
    case "deal":
      return `deal ${e.piece} → seat ${e.to}`;
    case "play":
      return `play ${e.piece} (seat ${e.from}) → ${e.to}`;
    case "think":
      return `think seat ${e.seat} ${e.ms}ms`;
    case "collect":
      return `collect ${e.pieces.length} → seat ${e.to}`;
    case "flip":
      return `flip ${e.piece} ${e.faceUp ? "up" : "down"}`;
    case "announce":
      return `say "${e.text}"`;
    case "move":
      return `move ${e.piece} → ${e.to.zone}`;
    default:
      return e.t;
  }
}
