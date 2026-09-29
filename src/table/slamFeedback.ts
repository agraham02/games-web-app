"use client";

/**
 * The slam's sound and its buzz — what a hand coming down on a real table
 * does that a picture of one cannot.
 *
 * The sound is synthesised rather than shipped as a file: a low sine that
 * drops in pitch (the table's body) under a short burst of filtered noise
 * (the tile's knock). A few lines of Web Audio, nothing to load, and the
 * final slam can simply be the same thing heavier.
 *
 * Both fire at IMPACT, not when the slam starts: the piece rises before it
 * comes down (`SLAM_LAND_MS`), and a thud on the wind-up reads as the
 * table being hit by nothing.
 *
 * Browsers only let a page make sound after the person has interacted with
 * it, so the audio context is created lazily and resumed on the first tap
 * anywhere (`useSlamFeedback` listens for it). A slam before that is
 * simply silent, which is the browser's rule rather than ours.
 */

import { useEffect, useRef } from "react";
import { SLAM_FINAL_LAND_MS, SLAM_LAND_MS, prefersReducedMotion } from "@/motion/presets";
import { onSlam } from "./fx";

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

/** Called from a user gesture, which is what lets the context start. */
export function unlockAudio(): void {
  const ctx = audio();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

/** One thud. `final` is the round-ending slam: lower, longer, louder. */
export function playSlamSound(final: boolean): void {
  const ctx = audio();
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = final ? 0.9 : 0.65;
  out.connect(ctx.destination);

  // The body: a sine falling from a low note to a lower one.
  const body = ctx.createOscillator();
  const bodyGain = ctx.createGain();
  body.type = "sine";
  body.frequency.setValueAtTime(final ? 120 : 150, now);
  body.frequency.exponentialRampToValueAtTime(final ? 42 : 55, now + (final ? 0.28 : 0.18));
  bodyGain.gain.setValueAtTime(1, now);
  bodyGain.gain.exponentialRampToValueAtTime(0.001, now + (final ? 0.42 : 0.26));
  body.connect(bodyGain).connect(out);
  body.start(now);
  body.stop(now + 0.5);

  // The knock: a few milliseconds of noise through a band-pass.
  const length = Math.floor(ctx.sampleRate * 0.06);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    // Cosmetic noise, not game logic: the no-`Math.random` rule is about
    // replaying a match from its seed, which a sound has no part in.
    data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
  }
  const knock = ctx.createBufferSource();
  knock.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = final ? 900 : 1200;
  band.Q.value = 0.9;
  const knockGain = ctx.createGain();
  knockGain.gain.value = final ? 0.7 : 0.5;
  knock.connect(band).connect(knockGain).connect(out);
  knock.start(now);
}

/** A buzz, where the device and browser can (Android; not iOS Safari). */
export function vibrateSlam(final: boolean): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(final ? [45, 35, 90] : 50);
  } catch {
    /* Some browsers throw instead of ignoring it; either way, no buzz. */
  }
}

/**
 * Plays the slam's sound and buzz, per the player's settings. Mounted once
 * per table, by `GameHost`.
 */
export function useSlamFeedback({ sound, vibration }: { sound: boolean; vibration: boolean }) {
  const prefs = useRef({ sound, vibration });
  useEffect(() => {
    prefs.current = { sound, vibration };
  }, [sound, vibration]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = onSlam(({ final }) => {
      const { sound: withSound, vibration: withBuzz } = prefs.current;
      if (!withSound && !withBuzz) return;
      // With reduced motion the slam does not animate, so there is no
      // wind-up to wait out: the impact is now.
      const delay = prefersReducedMotion() ? 0 : final ? SLAM_FINAL_LAND_MS : SLAM_LAND_MS;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (withSound) playSlamSound(final);
        if (withBuzz) vibrateSlam(final);
      }, delay);
      timers.add(timer);
    });
    return () => {
      off();
      for (const t of timers) clearTimeout(t);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
}
