/**
 * Checking that an action off a socket is one the seat may actually take.
 *
 * `GameSession.submit` gates on `legalActions(state, seat)` being
 * non-empty — "may this seat act at all" — and deliberately not on
 * `currentSeat`, because Rummy's claim race entitles several seats at
 * once. What that gate cannot answer is whether the action that ARRIVED
 * is one of them, and online it is arbitrary JSON: `reduce` would
 * otherwise take a stranger's word for which card is in their hand.
 *
 * For four of the five games the legal set is finite and small enough to
 * enumerate, so membership of `legalActions` is both the correct answer
 * and — more usefully — the SAME answer the UI's own action bar is built
 * from. A button and a gate that read the same function cannot disagree
 * about what is allowed, which is the property that stops this drifting.
 *
 * Poker is the exception and does not use this: it returns
 * `{t:"bet", to: range.min}` as one representative of a continuous range,
 * so membership would refuse every bet but the minimum. It validates the
 * range by hand instead.
 */

/**
 * Deep equality with key order ignored.
 *
 * Ordinary `JSON.stringify` comparison is wrong here for a reason that
 * only bites over a wire: object key order follows insertion, and a
 * client is free to send `{card, t}` where the engine builds `{t, card}`.
 * Both are the same action and only one would match. Arrays keep their
 * order, because in an action they always mean something (`cards` pairs).
 */
export function sameAction(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;

  // NaN is never equal to itself, and an action carrying one is exactly
  // the input this whole module exists to refuse.
  if (typeof a === "number") return Number.isFinite(a) && a === b;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameAction(item, b[i]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && sameAction(left[key], right[key]),
  );
}

/**
 * Builds a `GameDefinition.validate` from the game's own `legalActions`.
 *
 * `reason` names the game so a refused action says something useful in a
 * log; the client is told only that the move was refused.
 */
export function validateByEnumeration<S, A>(
  legalActions: (state: S, seat: number) => A[],
): (state: S, seat: number, action: A) => string | null {
  return (state, seat, action) =>
    legalActions(state, seat).some((legal) => sameAction(legal, action))
      ? null
      : "illegal-action";
}
