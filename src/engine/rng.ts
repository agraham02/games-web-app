/**
 * Deterministic PRNG.
 *
 * Every shuffle, every bot decision and every dealt hand runs through
 * a seeded generator so a game is fully reproducible from its seed.
 * That buys three things this project needs:
 *
 *   - tests can assert on exact deals
 *   - a bug report is a seed plus an action list, not a video
 *   - replay / undo can re-derive state instead of storing snapshots
 *
 * Never call Math.random() anywhere in engine or bot code.
 */

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform pick. Throws on an empty array rather than returning undefined. */
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates. Returns a new array; does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
  /** The seed this generator was created from. */
  readonly seed: number;
}

/**
 * mulberry32 — 32-bit, fast, and good enough for card shuffling.
 * Not cryptographically secure; nothing here needs that.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive: number): number => {
    if (maxExclusive <= 0) {
      throw new RangeError(`rng.int requires a positive bound, got ${maxExclusive}`);
    }
    return Math.floor(next() * maxExclusive);
  };

  return {
    seed,
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("rng.pick called on an empty array");
      }
      return items[int(items.length)]!;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

/**
 * A seed for a fresh game. This is the ONE place a non-deterministic
 * value enters the system — everything downstream derives from it.
 */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * FNV-1a, returned as a non-negative 31-bit integer. The one place this
 * codebase derives "randomness" from data rather than from an `Rng` —
 * used only where a reducer's purity forbids threading a live generator
 * in, since `reduce(state, action)` receives no rng by design.
 *
 * Hash a key built from facts already ON the state (seed, round, seat,
 * piece id) and the result is a pure function of the position, so a
 * replay reproduces it exactly — which is the property that threading a
 * real generator through `reduce` would have given up.
 *
 * Callers: Rummy's in-`reduce` deal shuffle and its bot claim reaction
 * times; Dominoes' Caribbean slam roll.
 */
export function hashString(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}
