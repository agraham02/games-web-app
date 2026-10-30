"use client";

/**
 * What the table sounds like: every card dealt, tile laid, chip moved and die
 * thrown, in every game.
 *
 * Until this existed the app had exactly two sounds - the dominoes slam, and
 * Chromaly's and Mind Meld's cues - so four of the games were silent, and the
 * one shared sound was wrong half the time: the slam's thud is a domino hitting
 * wood, and it played for Chromaly's cards as well (the user, 2026-10-30).
 *
 * One rule decides a sound: WHAT moved, and HOW. A card dealt, drawn, played
 * or turned over; a tile drawn or laid; a chip. It comes from the event as the
 * choreographer applies it (`applyEvent` emits it, `useTableSounds` plays it),
 * so a sound lands on the frame its motion starts, obeys skip and speed for
 * free, and a new game gets the right sounds without writing any.
 *
 * Synthesised, like the slam: noise through a filter for anything papery or
 * clacky, a couple of sines for anything that rings. Nothing to load. Soft on
 * purpose - these play on every move, in a room where people are talking.
 */

import { useEffect, useRef } from "react";
import type { GameEvent, PieceId, PieceKind } from "@/engine/types";
import { audioContext, unlockAudio } from "./slamFeedback";

export type TableSound =
  | { t: "card"; how: "deal" | "draw" | "play" | "flip" }
  | { t: "tile"; how: "draw" | "play" }
  | { t: "chip" }
  | { t: "collect" }
  | { t: "sweep" }
  | { t: "shuffle" }
  | { t: "dice" }
  | { t: "gather" };

/** How long a slammed piece's own play stays covered by the slam's sound. */
const SLAM_COVERS_MS = 1_500;

/**
 * The piece last slammed, and when: its `play` follows the slam in the same
 * frame, and the slam already made the noise for it. Module state like the
 * audio context's, because the two events arrive as separate calls.
 */
let slammed: { piece: PieceId; at: number } | null = null;

export function noteSlam(piece: PieceId, now = Date.now()): void {
  slammed = { piece, at: now };
}

function coveredBySlam(piece: PieceId, now: number): boolean {
  return slammed !== null && slammed.piece === piece && now - slammed.at < SLAM_COVERS_MS;
}

/**
 * The sound one event makes, or null. Pure apart from the slam note, so it is
 * the thing the tests pin. `kindOf` says what a piece is; a stand-in the table
 * has no meta for is a card, which is what every face-down stand-in is.
 */
export function soundFor(
  event: GameEvent,
  kindOf: (piece: PieceId) => PieceKind | undefined,
  now = Date.now(),
): TableSound | null {
  switch (event.t) {
    case "deal":
    case "draw": {
      const kind = kindOf(event.piece);
      if (kind === "chip") return { t: "chip" };
      if (kind === "tile") return { t: "tile", how: "draw" };
      return { t: "card", how: event.t };
    }
    case "play":
    case "move": {
      if (coveredBySlam(event.piece, now)) return null;
      const kind = kindOf(event.piece);
      if (kind === "chip") return { t: "chip" };
      if (kind === "tile") return { t: "tile", how: "play" };
      return { t: "card", how: "play" };
    }
    case "flip":
      return kindOf(event.piece) === "tile" ? null : { t: "card", how: "flip" };
    case "collect":
      return { t: "collect" };
    case "sweep":
      return event.pieces.length > 0 ? { t: "sweep" } : null;
    case "shuffle":
      return { t: "shuffle" };
    case "dice":
      return { t: "dice" };
    case "gather":
      return { t: "gather" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------- synthesis */

type Ctx = AudioContext;

function noise(ctx: Ctx, at: number, o: { s: number; f: number; to?: number; q?: number; gain: number; curve?: number }) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * o.s));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Cosmetic noise, not game logic: the no-`Math.random` rule is about
  // replaying a match from its seed, which a sound has no part in.
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** (o.curve ?? 2);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = o.q ?? 1;
  band.frequency.setValueAtTime(o.f, at);
  if (o.to) band.frequency.exponentialRampToValueAtTime(o.to, at + o.s);
  const g = ctx.createGain();
  g.gain.value = o.gain;
  src.connect(band).connect(g).connect(ctx.destination);
  src.start(at);
}

function ring(ctx: Ctx, at: number, o: { f: number; to?: number; s: number; gain: number; type?: OscillatorType }) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.f, at);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + o.s);
  g.gain.setValueAtTime(o.gain, at);
  g.gain.exponentialRampToValueAtTime(0.0008, at + o.s);
  osc.connect(g).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + o.s + 0.02);
}

/** A little variety, so a run of the same sound is not a machine gun. */
const jitter = (n: number, spread: number) => n * (1 + (Math.random() * 2 - 1) * spread);

export function playTableSound(sound: TableSound): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  switch (sound.t) {
    case "card":
      switch (sound.how) {
        case "deal":
          // A light flick off the top of the deck.
          noise(ctx, now, { s: 0.04, f: jitter(3200, 0.12), q: 0.9, gain: 0.11 });
          return;
        case "draw":
          noise(ctx, now, { s: 0.06, f: jitter(2600, 0.1), to: 3600, q: 0.9, gain: 0.14 });
          return;
        case "play":
          // Laid down with a little snap: a papery slap and the felt under it.
          noise(ctx, now, { s: 0.05, f: jitter(1900, 0.1), q: 0.8, gain: 0.22 });
          ring(ctx, now, { f: 170, to: 110, s: 0.06, gain: 0.07, type: "triangle" });
          return;
        case "flip":
          noise(ctx, now, { s: 0.03, f: jitter(4200, 0.1), q: 1.2, gain: 0.08 });
          return;
      }
      return;
    case "tile":
      if (sound.how === "draw") {
        // Slid off the boneyard.
        noise(ctx, now, { s: 0.09, f: jitter(1100, 0.1), to: 1600, q: 0.7, gain: 0.1, curve: 1 });
        return;
      }
      // A clack: two hard edges meeting, then the second tile settling.
      noise(ctx, now, { s: 0.025, f: jitter(2600, 0.08), q: 5, gain: 0.32 });
      ring(ctx, now, { f: jitter(1500, 0.05), to: 1100, s: 0.05, gain: 0.07, type: "triangle" });
      noise(ctx, now + 0.022, { s: 0.02, f: 2100, q: 5, gain: 0.14 });
      return;
    case "chip": {
      // A clink: two short rings, a hair apart, over a tick.
      const f = jitter(3400, 0.06);
      ring(ctx, now, { f, s: 0.09, gain: 0.05 });
      ring(ctx, now + 0.004, { f: f * 1.47, s: 0.07, gain: 0.035 });
      noise(ctx, now, { s: 0.012, f: 6200, q: 2, gain: 0.09 });
      return;
    }
    case "collect":
      // A trick gathered in: one soft swish.
      noise(ctx, now, { s: 0.2, f: 700, to: 2400, q: 0.8, gain: 0.12, curve: 1 });
      return;
    case "sweep":
      noise(ctx, now, { s: 0.28, f: 500, to: 2000, q: 0.7, gain: 0.14, curve: 1 });
      return;
    case "gather":
      noise(ctx, now, { s: 0.16, f: 900, to: 2200, q: 0.9, gain: 0.1, curve: 1 });
      return;
    case "shuffle":
      // A riffle: a run of tiny ticks, closing up as the halves meet.
      for (let i = 0; i < 16; i++) {
        noise(ctx, now + i * 0.026 * (1 - i / 40), { s: 0.018, f: jitter(3400, 0.2), q: 1.8, gain: 0.07 });
      }
      return;
    case "dice": {
      // Thrown: a few knocks as they tumble, the last one the landing.
      const knocks = [0, 0.09, 0.17, 0.27, 0.36, 0.5];
      knocks.forEach((t, i) => {
        const last = i === knocks.length - 1;
        noise(ctx, now + t, { s: 0.025, f: jitter(1700, 0.2), q: 3, gain: last ? 0.3 : 0.2 });
        ring(ctx, now + t, { f: jitter(900, 0.15), to: 600, s: 0.04, gain: 0.05, type: "triangle" });
      });
      return;
    }
  }
}

/**
 * The fewest ms between two sounds of one kind. A deal of fifty cards, or a
 * batch skipped through, would otherwise stack dozens into one burst.
 */
const GAP_MS: Record<TableSound["t"], number> = {
  card: 38,
  tile: 45,
  chip: 32,
  collect: 120,
  sweep: 150,
  shuffle: 300,
  dice: 300,
  gather: 120,
};

/* ------------------------------------------------------------- channel */

const listeners = new Set<(sound: TableSound) => void>();

export function emitTableSound(sound: TableSound): void {
  for (const listener of listeners) listener(sound);
}

/** Plays the table's sounds, per the player's Sound setting. Mounted once, by `GameHost`. */
export function useTableSounds({ sound }: { sound: boolean }) {
  const on = useRef(sound);
  useEffect(() => {
    on.current = sound;
  }, [sound]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    const last: Partial<Record<TableSound["t"], number>> = {};
    const listener = (s: TableSound) => {
      if (!on.current) return;
      const now = performance.now();
      if (now - (last[s.t] ?? -Infinity) < GAP_MS[s.t]) return;
      last[s.t] = now;
      playTableSound(s);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
}

/** Somebody has locked something in - Mind Meld's word. A soft click, nothing more. */
export function playLockTick(): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  noise(ctx, now, { s: 0.02, f: 2800, q: 3, gain: 0.12 });
  ring(ctx, now, { f: 1320, s: 0.08, gain: 0.04 });
}

/**
 * A short rising flourish for the viewer winning a round or the match - the
 * moment the crown and confetti already mark on screen.
 */
export function playWinFlourish(match: boolean): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  const notes = match ? [523, 659, 784, 1047] : [587, 740, 880];
  notes.forEach((f, i) => ring(ctx, now + i * 0.09, { f, s: match ? 0.6 : 0.4, gain: 0.12, type: "triangle" }));
  if (match) ring(ctx, now + 0.36, { f: 1568, s: 0.7, gain: 0.07 });
}
