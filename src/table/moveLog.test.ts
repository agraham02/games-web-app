import { describe, expect, it } from "vitest";
import { describeFrame } from "./moveLog";

describe("the dev move log", () => {
  it("says who moved, how, and where the cards went", () => {
    const line = describeFrame({ seat: 0, action: { t: "draw" }, by: "player" }, [
      { t: "cue", kind: "draw", seat: 0, amount: 1 },
      { t: "draw", piece: "B3.1", from: "deck", to: 0, faceUp: false },
      { t: "sweep", pieces: ["R1.1", "W.2"], to: "deck" },
      { t: "draw", piece: "R9.1", from: "deck", to: 0, faceUp: false },
      { t: "play", piece: "R9.1", from: 0, to: "discard", faceUp: true },
    ]);
    expect(line).toBe(
      'you [player] {"t":"draw"}: you drew B3.1, reshuffle (2), you drew R9.1, R9.1 -> discard',
    );
  });

  it("names a bot's seat, and keeps a deal to one count", () => {
    expect(describeFrame({ seat: 2, action: { t: "draw" }, by: "bot" }, [])).toBe('seat 2 [bot] {"t":"draw"}');
    expect(describeFrame(null, [{ t: "deal", piece: "R1.1", to: 1, faceUp: false }])).toBe("deal (1 cards)");
  });
});
