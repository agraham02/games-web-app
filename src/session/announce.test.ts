// @vitest-environment node

/**
 * The engine writes predicates; the client writes names.
 *
 * Offline this distinction did not exist — one human, always seat 0, so
 * `seat === HERO ? "You" : botName(seat)` baked into the event text was
 * correct by construction. In a room it is wrong twice: every viewer needs
 * their own "You", and everybody else needs the name of the person
 * actually sitting there rather than the bot name that seat would have had.
 */

import { describe, expect, it } from "vitest";
import { createRng } from "@/engine/rng";
import type { GameEvent } from "@/engine/types";
import { createSpades } from "@/games/spades/rules";
import { composeAnnounce, type AnnounceEvent } from "./announce";

const NAMES = ["Ada", "Bo", "Cy", "Di"];
const nameFor = (seat: number) => NAMES[seat] ?? `Seat ${seat + 1}`;

describe("composeAnnounce", () => {
  it("names the actor for everyone else and says 'You' to the actor", () => {
    const event: AnnounceEvent = { t: "announce", actor: 2, text: "takes the trick" };
    expect(composeAnnounce(event, 0, nameFor).text).toBe("Cy takes the trick");
    expect(composeAnnounce(event, 2, nameFor).text).toBe("You takes the trick");
  });

  it("uses the second-person form where the verb disagrees", () => {
    // The whole reason `selfText` exists: "Ada leads" and "You lead" differ
    // in the verb, not just the subject, and no single template covers both.
    const event: AnnounceEvent = { t: "announce", actor: 1, text: "leads", selfText: "lead" };
    expect(composeAnnounce(event, 0, nameFor).text).toBe("Bo leads");
    expect(composeAnnounce(event, 1, nameFor).text).toBe("You lead");
  });

  it("leaves a line that belongs to the table alone", () => {
    // "Nobody could play" is about the board, not a person. Prefixing it
    // with a name would be wrong, so an actor-less announcement is returned
    // untouched.
    const event: AnnounceEvent = { t: "announce", text: "Nobody could play" };
    expect(composeAnnounce(event, 0, nameFor).text).toBe("Nobody could play");
  });

  it("says a real name to a spectator, never 'You'", () => {
    // A spectator has no seat, so nothing at the table is theirs.
    const event: AnnounceEvent = { t: "announce", actor: 0, text: "leads", selfText: "lead" };
    expect(composeAnnounce(event, null, nameFor).text).toBe("Ada leads");
  });

  it("reads correctly from every seat's point of view, over a real deal", () => {
    // The end-to-end claim: the SAME event stream produces a different,
    // correct line for each viewer — which is exactly what was impossible
    // while the name was baked into the text.
    const spades = createSpades();
    const rng = createRng(4242);
    const base = spades.setup({ seats: 4, rng });
    const { events } = spades.startRound!(base, rng);
    const announcements = events.filter((e): e is AnnounceEvent => e.t === "announce");
    expect(announcements.length).toBeGreaterThan(0);

    for (const event of announcements) {
      if (event.actor === undefined) continue;
      const asActor = composeAnnounce(event, event.actor, nameFor).text;
      const asOther = composeAnnounce(event, ((event.actor + 1) % 4) as number, nameFor).text;
      expect(asActor.startsWith("You ")).toBe(true);
      expect(asOther.startsWith(nameFor(event.actor))).toBe(true);
      // And no engine text still carries a baked-in name.
      expect(event.text).not.toMatch(/\b(You|Mia|Sam|Kofi|Jo|Ada|Rui|Nia|Tomas|Elle)\b/);
    }
  });
});

describe("no game bakes a name into announcement text any more", () => {
  it("holds across a full Spades match", () => {
    // A sweep rather than a spot check: the rewrite touched eleven sites
    // across four games, and the failure mode of missing one is a toast
    // that says "Mia" to a room where nobody is called Mia.
    const spades = createSpades();
    const rng = createRng(77);
    let state = spades.setup({ seats: 4, rng });
    const seen: GameEvent[] = [];

    for (let round = 0; round < 6 && !spades.isOver(state); round++) {
      const dealt = spades.startRound!(state, rng);
      state = dealt.state;
      seen.push(...dealt.events);
      for (let turn = 0; turn < 400; turn++) {
        const seat = spades.currentSeat(state);
        if (seat === null) break;
        const action = spades.bots.steady.choose(spades.playerView(state, seat), seat, rng);
        const result = spades.reduce(state, action);
        state = result.state;
        seen.push(...result.events);
      }
    }

    const announcements = seen.filter((e): e is AnnounceEvent => e.t === "announce");
    expect(announcements.length).toBeGreaterThan(10);
    for (const event of announcements) {
      expect(event.text).not.toMatch(/\b(Mia|Sam|Kofi|Jo|Ada|Rui|Nia|Tomas|Elle)\b/);
    }
  });
});

describe("tone, which is also per-viewer", () => {
  const nameFor = (seat: number) => ["Ada", "Bo", "Cy", "Di"][seat] ?? `Seat ${seat}`;

  it("gives the actor their own tone and everybody else the neutral one", () => {
    // "Takes the trick" is good news to exactly one person at the table.
    // Games used to write `tone: winner === HERO ? "good" : "info"`, which
    // is correct offline by construction and colours the toast for the
    // wrong player the moment a second human sits down.
    const event = {
      t: "announce",
      actor: 2,
      text: "takes the trick",
      selfText: "take the trick",
      tone: "info",
      selfTone: "good",
    } as const;

    expect(composeAnnounce(event, 2, nameFor)).toEqual({
      text: "You take the trick",
      tone: "good",
    });
    expect(composeAnnounce(event, 0, nameFor)).toEqual({
      text: "Cy takes the trick",
      tone: "info",
    });
    // A spectator is nobody's actor, so they get the table's reading.
    expect(composeAnnounce(event, null, nameFor).tone).toBe("info");
  });

  it("falls back to the one tone when a line has only one", () => {
    const event = { t: "announce", actor: 1, text: "passes", tone: "info" } as const;
    expect(composeAnnounce(event, 1, nameFor).tone).toBe("info");
    expect(composeAnnounce(event, 0, nameFor).tone).toBe("info");
  });
});
