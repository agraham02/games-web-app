import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  parseSettings,
  summarizeRules,
  summarizeSetup,
  withOption,
  type GameSetupSpec,
} from "./gameSetup";

/** A small game with presets, shaped like the real ones will be. */
const SPEC: GameSetupSpec = {
  description: "test",
  difficulty: null,
  summary: "changes",
  presets: {
    key: "preset",
    custom: "custom",
    values: {
      classic: { drawToMatch: false, jumpIn: false, stacking: "off" },
      party: { drawToMatch: true, jumpIn: true, stacking: "upward" },
    },
  },
  options: [
    {
      kind: "choice",
      key: "preset",
      label: "Rules",
      ruleset: true,
      choices: [
        { value: "classic", label: "Classic" },
        { value: "party", label: "Party" },
        { value: "custom", label: "Custom" },
      ],
      default: "classic",
    },
    { kind: "number", key: "target", label: "Play to", min: 100, max: 1000, step: 50, default: 500, unit: () => "points" },
    { kind: "toggle", key: "drawToMatch", label: "Draw to match", hint: "h", default: false, section: "Drawing" },
    { kind: "toggle", key: "jumpIn", label: "Jump-In", hint: "h", default: false, section: "Special plays" },
    {
      kind: "choice",
      key: "stacking",
      label: "Stacking",
      choices: [
        { value: "off", label: "Off" },
        { value: "same", label: "Same card" },
        { value: "upward", label: "Equal or higher" },
      ],
      default: "off",
      section: "Draw cards",
    },
  ],
};

const start = () => defaultSettings(SPEC);

describe("presets", () => {
  it("picking a preset copies its rules onto the form and leaves the rest alone", () => {
    const s = withOption(SPEC, { ...start(), target: 250 }, "preset", "party");
    expect(s).toMatchObject({ preset: "party", drawToMatch: true, jumpIn: true, stacking: "upward", target: 250 });
  });

  it("changing one rule moves the choice to custom", () => {
    const party = withOption(SPEC, start(), "preset", "party");
    expect(withOption(SPEC, party, "jumpIn", false).preset).toBe("custom");
  });

  it("changing a rule back to match a preset finds that preset again", () => {
    const party = withOption(SPEC, start(), "preset", "party");
    const custom = withOption(SPEC, party, "jumpIn", false);
    expect(withOption(SPEC, custom, "jumpIn", true).preset).toBe("party");
    // And the plain defaults are Classic.
    expect(withOption(SPEC, withOption(SPEC, start(), "drawToMatch", true), "drawToMatch", false).preset).toBe("classic");
  });

  it("an option no preset names does not disturb the choice", () => {
    const party = withOption(SPEC, start(), "preset", "party");
    expect(withOption(SPEC, party, "target", 300).preset).toBe("party");
  });

  it("choosing custom keeps the rules as they are", () => {
    const party = withOption(SPEC, start(), "preset", "party");
    expect(withOption(SPEC, party, "preset", "custom")).toMatchObject({ preset: "custom", jumpIn: true });
  });

  it("parses back to the same settings (the server clamps what the form sends)", () => {
    const party = withOption(SPEC, start(), "preset", "party");
    expect(parseSettings(SPEC, party)).toEqual(party);
  });
});

describe("summaries", () => {
  it("names the preset and no rules when the preset is played as written", () => {
    const party = withOption(SPEC, start(), "preset", "party");
    expect(summarizeRules(SPEC, party, "solo")).toEqual([]);
    expect(summarizeSetup(SPEC, party, "solo")).toEqual(["Party", "500 points"]);
  });

  it("once a preset is tweaked it reads as Custom, listing what is on", () => {
    const party = withOption(SPEC, start(), "preset", "party");
    const tweaked = withOption(SPEC, withOption(SPEC, party, "jumpIn", false), "stacking", "same");
    expect(tweaked.preset).toBe("custom");
    expect(summarizeRules(SPEC, tweaked, "solo")).toEqual(["Draw to match on", "Stacking Same card"]);
    expect(summarizeSetup(SPEC, tweaked, "solo")).toEqual(["Custom", "500 points", "Draw to match on", "Stacking Same card"]);
  });

  it("under custom, lists what differs from the defaults", () => {
    const custom = withOption(SPEC, start(), "drawToMatch", true);
    expect(custom.preset).toBe("custom");
    expect(summarizeRules(SPEC, custom, "solo")).toEqual(["Draw to match on"]);
  });

  it("a game without summary: changes lists everything, as before", () => {
    const plain: GameSetupSpec = { ...SPEC, summary: undefined };
    expect(summarizeSetup(plain, start(), "solo")).toHaveLength(SPEC.options.length);
  });
});
