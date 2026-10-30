"use client";

/**
 * Chromaly's sounds and buzzes, one per `cue`.
 *
 * Synthesised, as the slam's is: a few lines of Web Audio and nothing to
 * load, so every sound is a handful of oscillators and a burst of filtered
 * noise. They are short and soft on purpose - this table is played in a room
 * with other people talking - and they all go through the player's Sound and
 * Vibration settings, which default to what the rest of the app does.
 *
 * Browsers allow no sound before the person has touched the page, so these are
 * silent until the first tap (`unlockAudio`), which is the browser's rule.
 */

import { useEffect, useRef } from "react";
import type { CueKind, SeatId } from "@/engine/types";
import { audioContext, unlockAudio } from "@/table/slamFeedback";
import { onCue, type CueFx } from "@/table/fx";

type Ctx = AudioContext;

function tone(
  ctx: Ctx,
  at: number,
  opts: { type?: OscillatorType; from: number; to?: number; seconds: number; gain: number },
): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.from, at);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, at + opts.seconds);
  g.gain.setValueAtTime(opts.gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + opts.seconds);
  osc.connect(g).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + opts.seconds + 0.02);
}

/** A burst of band-passed noise, optionally sweeping: a flick, a swish, a knock. */
function noise(
  ctx: Ctx,
  at: number,
  opts: { seconds: number; from: number; to?: number; q?: number; gain: number },
): void {
  const length = Math.floor(ctx.sampleRate * opts.seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Cosmetic noise, not game logic: the no-`Math.random` rule is about replaying
  // a match from its seed, which a sound has no part in.
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 1.5;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = opts.q ?? 1.2;
  band.frequency.setValueAtTime(opts.from, at);
  if (opts.to) band.frequency.exponentialRampToValueAtTime(opts.to, at + opts.seconds);
  const g = ctx.createGain();
  g.gain.value = opts.gain;
  src.connect(band).connect(g).connect(ctx.destination);
  src.start(at);
}

/** The sound for one cue. `amount` is how many cards, or how tall a stack. */
export function playCue(kind: CueKind, amount = 0): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  switch (kind) {
    case "skip":
      // A stamp.
      tone(ctx, now, { type: "triangle", from: 240, to: 90, seconds: 0.16, gain: 0.5 });
      noise(ctx, now, { seconds: 0.05, from: 1400, gain: 0.35 });
      return;
    case "reverse":
      // A whip round: up, then back down.
      noise(ctx, now, { seconds: 0.18, from: 500, to: 3200, q: 2, gain: 0.3 });
      noise(ctx, now + 0.16, { seconds: 0.22, from: 3200, to: 600, q: 2, gain: 0.3 });
      return;
    case "draw": {
      // Soft flicks, one a card up to a handful.
      const n = Math.min(Math.max(amount, 1), 6);
      for (let i = 0; i < n; i++) noise(ctx, now + i * 0.07, { seconds: 0.045, from: 2400, q: 1.5, gain: 0.22 });
      return;
    }
    case "stack":
      // A blip that rises a step with every card on the stack.
      tone(ctx, now, { type: "triangle", from: 300 * (1 + amount / 10), seconds: 0.16, gain: 0.3 });
      return;
    case "colour":
      // A soft chord.
      for (const f of [392, 494, 587]) tone(ctx, now, { from: f, seconds: 0.42, gain: 0.14 });
      return;
    case "jump":
      noise(ctx, now, { seconds: 0.07, from: 3000, q: 2, gain: 0.35 });
      tone(ctx, now + 0.04, { type: "triangle", from: 200, to: 80, seconds: 0.14, gain: 0.4 });
      return;
    case "called":
      // A bright chime.
      tone(ctx, now, { from: 880, seconds: 0.35, gain: 0.22 });
      tone(ctx, now + 0.05, { from: 1320, seconds: 0.3, gain: 0.14 });
      return;
    case "caught":
      // A buzzer.
      tone(ctx, now, { type: "sawtooth", from: 150, to: 130, seconds: 0.28, gain: 0.22 });
      return;
    case "bluff":
      // A gavel.
      tone(ctx, now, { from: 130, to: 45, seconds: 0.3, gain: 0.7 });
      noise(ctx, now, { seconds: 0.06, from: 900, gain: 0.5 });
      return;
    case "clean":
      // Two low notes: a wasted call.
      tone(ctx, now, { from: 220, seconds: 0.2, gain: 0.22 });
      tone(ctx, now + 0.14, { from: 165, seconds: 0.3, gain: 0.22 });
      return;
    case "swap":
    case "pass":
    case "shuffleHands":
      noise(ctx, now, { seconds: 0.3, from: 700, to: 2600, q: 0.8, gain: 0.25 });
      return;
  }
}

/** The buzz, for the cues that are about the viewer's own seat. */
const BUZZ: Partial<Record<CueKind, number | number[]>> = {
  skip: 40,
  draw: 30,
  caught: [30, 30, 60],
  bluff: 50,
};

function buzz(kind: CueKind): void {
  const pattern = BUZZ[kind];
  if (pattern === undefined || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* Some browsers throw instead of ignoring it; either way, no buzz. */
  }
}

/**
 * Plays each cue's sound, and buzzes for the ones about the viewer, per their
 * settings. Mounted once per table by `ChromalyTable`.
 */
export function useCueFeedback({
  sound,
  vibration,
  viewerSeat,
}: {
  sound: boolean;
  vibration: boolean;
  viewerSeat: SeatId;
}) {
  const prefs = useRef({ sound, vibration, viewerSeat });
  useEffect(() => {
    prefs.current = { sound, vibration, viewerSeat };
  }, [sound, vibration, viewerSeat]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    const off = onCue((cue: CueFx) => {
      const p = prefs.current;
      if (p.sound) playCue(cue.kind, cue.amount ?? 0);
      if (p.vibration && cue.seat === p.viewerSeat) buzz(cue.kind);
    });
    return () => {
      off();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
}
