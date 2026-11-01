// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultSetup,
  forgetSetup,
  isDefaultSetup,
  readSavedSetup,
  resetSavedSetupCache,
  sanitizeSetup,
  saveSetup,
  useSavedSetup,
} from "./savedSetup";

beforeEach(() => {
  window.localStorage.clear();
  resetSavedSetupCache();
});

describe("sanitizeSetup", () => {
  it("returns the defaults for anything that is not an object", () => {
    for (const junk of [null, undefined, 7, "x", [], true]) {
      expect(sanitizeSetup("bs", junk)).toEqual(defaultSetup("bs"));
    }
  });

  it("clamps hostile values to the spec's own ranges", () => {
    const got = sanitizeSetup("bs", {
      settings: { target: 9999, windowMs: Infinity },
      seats: 400,
      difficulty: "godlike",
    });
    expect(got.settings.target).toBe(9);
    expect(got.settings.windowMs).toBe(defaultSetup("bs").settings.windowMs);
    expect(got.seats).toBe(6);
    expect(got.difficulty).toBe("steady");
  });

  it("takes an option added since the save from its default", () => {
    const got = sanitizeSetup("rummy", { settings: {}, seats: 3, difficulty: "sharp" });
    expect(got.settings.target).toBe(defaultSetup("rummy").settings.target);
    expect(got.seats).toBe(3);
    expect(got.difficulty).toBe("sharp");
  });

  it("takes an option added since the save from the preset the save names", () => {
    // Saved before "Pairs are just pairs" existed: Crazy turns it on.
    const crazy = sanitizeSetup("chromaly", { settings: { preset: "crazy", doubles: true }, seats: 4 });
    expect(crazy.settings.plainPairs).toBe(true);
    // A preset that leaves it off, and an explicit save, are both kept.
    expect(sanitizeSetup("chromaly", { settings: { preset: "caribbean" } }).settings.plainPairs).toBe(false);
    expect(sanitizeSetup("chromaly", { settings: { preset: "crazy", plainPairs: false } }).settings.plainPairs).toBe(false);
  });

  it("never takes a volatile option (money) from a save", () => {
    const got = sanitizeSetup("poker", { settings: { buyIn: 10000, bigBlind: 50 }, seats: 4, difficulty: "steady" });
    expect(got.settings.buyIn).toBe(0);
    expect(got.settings.bigBlind).toBe(50);
    expect(sanitizeSetup("lrc", { settings: { chipValue: 100 } }).settings.chipValue).toBe(0);
  });

  it("keeps a ruleset's seat bounds: Caribbean is four-handed whatever was saved", () => {
    const got = sanitizeSetup("dominoes", { settings: { mode: "caribbean" }, seats: 2 });
    expect(got.seats).toBe(4);
  });
});

describe("saving", () => {
  it("round-trips through storage and the cache", () => {
    saveSetup("rummy", { settings: { target: 300 }, seats: 3, difficulty: "sharp" });
    expect(readSavedSetup("rummy")).toMatchObject({ settings: { target: 300 }, seats: 3, difficulty: "sharp" });
    resetSavedSetupCache();
    expect(readSavedSetup("rummy")?.settings.target).toBe(300);
  });

  it("ignores an unknown game id and corrupt JSON", () => {
    expect(readSavedSetup("nonsense")).toBeNull();
    window.localStorage.setItem("table-games:setup:bs", "{not json");
    resetSavedSetupCache();
    expect(readSavedSetup("bs")).toBeNull();
  });

  it("keepDifficulty leaves the solo difficulty alone (the lobby's save)", () => {
    saveSetup("rummy", { settings: { target: 200 }, seats: 4, difficulty: "sharp" });
    saveSetup("rummy", { settings: { target: 400 }, seats: 5, difficulty: "casual" }, { keepDifficulty: true });
    expect(readSavedSetup("rummy")).toMatchObject({ settings: { target: 400 }, seats: 5, difficulty: "sharp" });
  });

  it("forgetting a game goes back to the defaults", () => {
    saveSetup("bs", { settings: { target: 2 }, seats: 3, difficulty: "casual" });
    forgetSetup("bs");
    expect(readSavedSetup("bs")).toBeNull();
    expect(window.localStorage.getItem("table-games:setup:bs")).toBeNull();
  });

  it("still works when storage refuses", () => {
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(() => saveSetup("bs", { settings: { target: 2 }, seats: 3, difficulty: "casual" })).not.toThrow();
      expect(readSavedSetup("bs")?.settings.target).toBe(2);
    } finally {
      window.localStorage.setItem = setItem;
    }
  });
});

describe("isDefaultSetup", () => {
  it("is true for the defaults and false after any change", () => {
    expect(isDefaultSetup("bs", defaultSetup("bs"))).toBe(true);
    expect(isDefaultSetup("bs", { ...defaultSetup("bs"), difficulty: "sharp" })).toBe(false);
    expect(isDefaultSetup("bs", { ...defaultSetup("bs"), seats: 5 })).toBe(false);
  });
});

describe("useSavedSetup", () => {
  it("starts on the defaults, remembers a change, and follows storage", () => {
    const { result } = renderHook(() => useSavedSetup("rummy"));
    expect(result.current[0]).toEqual(defaultSetup("rummy"));
    act(() => result.current[1]({ ...result.current[0], seats: 5 }));
    expect(result.current[0].seats).toBe(5);

    // A second mount of the same game (the next visit) sees it.
    const again = renderHook(() => useSavedSetup("rummy"));
    expect(again.result.current[0].seats).toBe(5);
  });

  it("keeps the value stable between renders, so a game built from it is not rebuilt", () => {
    const { result, rerender } = renderHook(() => useSavedSetup("rummy"));
    const first = result.current[0];
    rerender();
    expect(result.current[0]).toBe(first);
  });
});

describe("server render", () => {
  it("draws the defaults even when the device has a save, so hydration matches", () => {
    saveSetup("rummy", { settings: { target: 300 }, seats: 6, difficulty: "sharp" });
    function Probe() {
      const [value] = useSavedSetup("rummy");
      return <p>{`${value.seats}/${value.settings.target}/${value.difficulty}`}</p>;
    }
    const html = renderToString(<Probe />);
    const d = defaultSetup("rummy");
    expect(html).toContain(`${d.seats}/${d.settings.target}/${d.difficulty}`);
  });
});
