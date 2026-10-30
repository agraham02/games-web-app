import { describe, expect, it } from "vitest";
import type { PieceKind } from "@/engine/types";
import { noteSlam, soundFor } from "./tableSounds";

const kinds: Record<string, PieceKind> = { AS: "card", "6-6": "tile", red: "chip", "R5.1": "chroma" };
const kindOf = (id: string) => kinds[id];

describe("what the table sounds like", () => {
  it("knows a card from a tile from a chip", () => {
    expect(soundFor({ t: "play", piece: "AS", from: 0, to: "trick", faceUp: true }, kindOf)).toEqual({ t: "card", how: "play" });
    expect(soundFor({ t: "move", piece: "6-6", to: { zone: "line", index: 0, count: 1, faceUp: true } }, kindOf)).toEqual({
      t: "tile",
      how: "play",
    });
    expect(soundFor({ t: "move", piece: "red", to: { zone: "center", index: 0, count: 1, faceUp: true } }, kindOf)).toEqual({
      t: "chip",
    });
    expect(soundFor({ t: "draw", piece: "6-6", from: "boneyard", to: 0, faceUp: true }, kindOf)).toEqual({ t: "tile", how: "draw" });
  });

  it("treats a Chromaly card, and a stand-in it cannot name, as a card", () => {
    expect(soundFor({ t: "deal", piece: "R5.1", to: 1, faceUp: false }, kindOf)).toEqual({ t: "card", how: "deal" });
    expect(soundFor({ t: "deal", piece: "#hand:1:-:0", to: 1, faceUp: false }, kindOf)).toEqual({ t: "card", how: "deal" });
  });

  it("gives the table's gestures their own sounds", () => {
    expect(soundFor({ t: "shuffle", seed: 0 }, kindOf)).toEqual({ t: "shuffle" });
    expect(soundFor({ t: "collect", pieces: ["AS"], to: 0 }, kindOf)).toEqual({ t: "collect" });
    expect(soundFor({ t: "sweep", pieces: ["AS"], to: "deck" }, kindOf)).toEqual({ t: "sweep" });
    expect(soundFor({ t: "sweep", pieces: [], to: "deck" }, kindOf)).toBeNull();
    expect(soundFor({ t: "dice", seat: 0, faces: ["L"] }, kindOf)).toEqual({ t: "dice" });
  });

  it("is silent for what moves nothing, and for a tile turned over", () => {
    expect(soundFor({ t: "pause" }, kindOf)).toBeNull();
    expect(soundFor({ t: "think", seat: 1, ms: 500 }, kindOf)).toBeNull();
    expect(soundFor({ t: "announce", text: "hi" }, kindOf)).toBeNull();
    expect(soundFor({ t: "flip", piece: "6-6", faceUp: true }, kindOf)).toBeNull();
  });

  it("lets a slam make the noise for the play it rides in front of", () => {
    noteSlam("6-6", 1_000);
    const play = { t: "move" as const, piece: "6-6", to: { zone: "line" as const, index: 0, count: 1, faceUp: true } };
    expect(soundFor(play, kindOf, 1_100)).toBeNull();
    // Another piece, or the same one long after, sounds as usual.
    expect(soundFor({ ...play, piece: "red" }, kindOf, 1_100)).toEqual({ t: "chip" });
    expect(soundFor(play, kindOf, 9_000)).toEqual({ t: "tile", how: "play" });
  });
});
