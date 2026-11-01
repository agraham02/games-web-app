import { describe, expect, it } from "vitest";
import type { CueKind, GameEvent } from "@/engine/types";
import { CUE_SECONDS } from "@/motion/presets";
import { choreograph, gapAfter, playbackMs } from "@/motion/choreographer";
import { projectEvents } from "@/session/redact";
import { applyEventToTable } from "./applyEvent";
import { onCue } from "./fx";
import { useTableStore } from "./store";

/**
 * The `cue` event is cosmetic and rides the queue like a slam. These hold the
 * three promises that make that safe: it has a real duration (an event with no
 * case gets none and is stomped by the next one in the same frame), it never
 * holds the game up, and it names no piece, so redaction cannot leak through it.
 */

// Every kind, checked against the type: adding a kind without adding it here is
// a type error, and without a duration is a failing test.
const KINDS: Record<CueKind, true> = {
  skip: true,
  reverse: true,
  draw: true,
  stack: true,
  colour: true,
  jump: true,
  called: true,
  caught: true,
  bluff: true,
  clean: true,
  swap: true,
  pass: true,
  shuffleHands: true,
  countdown: true,
  meld: true,
  close: true,
  miss: true,
};

const cue = (kind: CueKind): GameEvent => ({ t: "cue", kind, seat: 1, amount: 2, dir: 1, colour: "R" });

describe("every cue kind", () => {
  for (const kind of Object.keys(KINDS) as CueKind[]) {
    it(`${kind}: has a real duration${kind === "countdown" ? ", and holds the queue for it" : ", and holds nothing up"}`, () => {
      expect(CUE_SECONDS[kind], `${kind} has no duration`).toBeGreaterThan(0);
      const [step] = choreograph([cue(kind)]);
      expect(step!.duration).toBeGreaterThan(0);
      const next: GameEvent = { t: "play", piece: "R3.1", from: 0, to: "discard", faceUp: true };
      // Most ride with what follows (offset 0) rather than making it wait; the
      // countdown is the exception, because the words come after it.
      if (kind === "countdown") expect(gapAfter(cue(kind), next)).toBe(step!.duration);
      else expect(gapAfter(cue(kind), next)).toBe(0);
    });
  }

  it("does not lengthen how long a turn takes to watch", () => {
    const play: GameEvent = { t: "play", piece: "R3.1", from: 0, to: "discard", faceUp: true };
    const draw: GameEvent = { t: "draw", piece: "R4.1", from: "deck", to: 1, faceUp: false };
    const plain = playbackMs([play, draw]);
    const withCues = playbackMs([cue("skip"), play, cue("draw"), draw]);
    expect(withCues).toBe(plain);
  });
});

describe("what the table does with one", () => {
  it("emits it to whoever is listening, and writes no placement", () => {
    const heard: GameEvent[] = [];
    const off = onCue((c) => heard.push(c));
    const before = useTableStore.getState().placements;
    applyEventToTable(cue("reverse"));
    off();
    expect(heard).toEqual([cue("reverse")]);
    // The store's identity is untouched: `reindex` was never called.
    expect(useTableStore.getState().placements).toBe(before);
  });

  it("stops being heard once unsubscribed", () => {
    const heard: GameEvent[] = [];
    const off = onCue((c) => heard.push(c));
    off();
    applyEventToTable(cue("skip"));
    expect(heard).toEqual([]);
  });
});

describe("through redaction", () => {
  it("passes a cue through unchanged, for every viewer", () => {
    const events: GameEvent[] = [cue("draw"), cue("bluff"), cue("shuffleHands")];
    expect(projectEvents(events, {}, {})).toEqual(events);
  });
});
