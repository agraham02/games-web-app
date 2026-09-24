/**
 * Motion vocabulary for the neo-felt direction: weighted and settled.
 * Pieces have mass — nothing bounces, things arrive.
 *
 * Durations mirror the tokens in globals.css. They live here in seconds
 * because that is what Motion consumes.
 */

import type { Transition } from "motion/react";

export const DURATION = {
    deal: 0.38,
    play: 0.3,
    collect: 0.42,
    flip: 0.3,
    ui: 0.2,
    count: 0.9,
    /**
     * A `sweep` (many pieces gathered to a shared pile at once, e.g. a
     * spent domino chain and every hand at round end) is deliberately
     * short and barely scales with how many pieces are in it — see
     * `choreograph`'s "sweep" case. It is a different GESTURE from `play`
     * or `deal`, not a slower or faster version of one: a real player
     * clearing a table gathers everything in roughly one motion regardless
     * of whether it is 6 tiles or 26, and the choreographer should not
     * make the player wait proportionally longer for the bigger pile
     * before the next, ordinarily-paced deal is allowed to start.
     */
    sweep: 0.16,
    /**
     * LRC's dice: how long they tumble, and then how long they sit still
     * to be read before any chip they decided moves. The choreographer
     * holds the queue for both; the dice overlay tumbles for the first.
     */
    diceTumble: 0.6,
    diceRead: 0.45,
    /**
     * Caribbean dominoes' slam, start to settled — the tile rising toward
     * the viewer, the drop, and the board's rattle afterwards. Longer than
     * any other single-piece gesture because it deliberately is one: the
     * whole point is that it interrupts the rhythm of ordinary play.
     */
    slam: 0.78,
    /**
     * The slam that ENDS a round — the going-out tile, ~80% likely to
     * slam (see `SLAM_CHANCE.goingOut`). Longer than an ordinary slam on
     * top of growing bigger (`SLAM_KEYFRAMES_FINAL`): the moment itself is
     * bigger, so the beat to read it in has to grow with it, not stay
     * fixed while the motion inside it gets busier. Raised again on
     * request (1.05 -> 1.25) alongside the keyframes below — the round's
     * last tile earning a beat that's noticeably its own, not just a
     * bigger `slam`.
     */
    slamFinal: 1.35,
} as const;

/**
 * Deliberate pauses BEFORE a step starts — distinct from DURATION, which
 * is how long a step itself takes once it begins. `trick` is the beat
 * between a trick's 4th card landing and the `collect` event actually
 * starting to sweep it toward the winner's pod: without it, `collect`'s
 * offset was 0, so the sweep began the instant the last card's `play`
 * animation finished — nowhere near enough time to actually read who
 * played what, let alone who won.
 */
export const HOLD = {
    trick: 0.9,
} as const;

export const STAGGER = {
    deal: 0.065,
    collect: 0.04,
    meld: 0.05,
    /** See DURATION.sweep — capped low deliberately, not a per-piece pace. */
    sweep: 0.012,
    /**
     * A whole-hand reveal (Spades: a Blind Nil look, a blind numeric bid
     * locking in, a team blind bid pulling the partner's hand up too) is
     * a single flourish, not 13 independent flips — without a same-run
     * stagger here `choreograph`'s "flip" case fell back to `beatOf`'s
     * per-event pace (~216ms/card), stretching a full hand's reveal past
     * 2.5s. Tighter than `deal` on purpose: a reveal is one gesture the
     * eye reads as a sweep, not cards individually arriving.
     */
    flip: 0.05,
} as const;

/** Overshoot-free spring: damping is high enough that it never rebounds. */
export const SETTLE: Transition = {
    type: "spring",
    stiffness: 260,
    damping: 30,
    mass: 0.9,
};

export const EASE_OUT_QUINT = [0.22, 1, 0.36, 1] as const;

export const TRANSITIONS = {
    deal: SETTLE,
    play: { duration: DURATION.play, ease: EASE_OUT_QUINT },
    collect: { duration: DURATION.collect, ease: EASE_OUT_QUINT },
    flip: { duration: DURATION.flip, ease: EASE_OUT_QUINT },
    ui: { duration: DURATION.ui, ease: "easeOut" },
    /** Resize and reflow: instant, because it is not a game event. */
    reflow: { duration: 0 },
} satisfies Record<string, Transition>;

/* ============================================================
   The slam
   ============================================================ */

/**
 * When the tile actually hits the table, as a fraction of its own
 * DURATION — shared by both tiers, since it is a proportion of the
 * gesture, not an absolute moment. The board's rattle is delayed to
 * exactly this point in whichever duration is playing — a shake that
 * starts with the swing rather than the impact reads as the table
 * wobbling on its own.
 */
const SLAM_IMPACT = 0.62;

export const SLAM_LAND_MS = DURATION.slam * SLAM_IMPACT * 1000;
/** See `SLAM_LAND_MS` — the going-out tile's own impact moment. */
export const SLAM_FINAL_LAND_MS = DURATION.slamFinal * SLAM_IMPACT * 1000;

/**
 * The slammed piece. Purely RELATIVE keyframes, played on a wrapper
 * INSIDE the positional root — the root owns absolute x/y/scale and its
 * own spring (which is what actually carries the tile from the hand to
 * the board), and these compose over the top of it. Nothing here fights
 * that, exactly as `Flipper`'s rotateY already doesn't.
 *
 * Reads as: lift toward the viewer, hang for a beat at the top of the
 * arc, then come down hard and overshoot into the table before settling.
 * `times` puts the impact at SLAM_IMPACT so the rattle lands with it.
 */
export const SLAM_KEYFRAMES = {
    scale: [1, 1.9, 1.9, 0.88, 1],
    rotate: [0, -4, -4, 2, 0],
};

export const SLAM_TIMING = {
    duration: DURATION.slam,
    times: [0, 0.3, 0.48, SLAM_IMPACT, 1],
    ease: "easeOut" as const,
};

/**
 * The tile that ENDS a round — deliberately bigger on every axis than
 * `SLAM_KEYFRAMES`, not just scaled up: a taller rise (`scale` peaks
 * higher), a harder overshoot on landing (drops further below 1 before
 * settling), and more wobble, so the very last tile of a round reads as
 * a genuinely different, louder event rather than one more ordinary
 * slam. `SLAM_TIMING`'s `times` fractions still apply — only the
 * DURATION they're stretched over changes (`slamFinal`), so the beat
 * shape stays identical while the whole gesture takes longer.
 *
 * Raised again on request: peak scale 2.6 -> 3.0 and the landing
 * overshoot dips further below 1 (0.78 -> 0.72), paired with
 * `slamFinal`'s own duration bump so the bigger motion has the extra
 * room it needs to actually read rather than feeling rushed.
 */
export const SLAM_KEYFRAMES_FINAL = {
    scale: [1, 3.0, 3.0, 0.72, 1],
    rotate: [0, -9, -9, 5, 0],
};

export const SLAM_TIMING_FINAL = {
    ...SLAM_TIMING,
    duration: DURATION.slamFinal,
};

/**
 * Every tile already on the board, jolted by the impact. Started as the
 * same numbers as the meld-rejection shake on Rummy's board sheet (one
 * shake in the app rather than two that nearly match); raised from
 * ±4/±3px to ±7/±5px on request — a played tile's rattle needed to read
 * as a real slam's impact, not a nudge, which the smaller Rummy amount
 * (a refusal, not a physical impact) doesn't need to sell.
 */
export const SHAKE_KEYFRAMES = {
    x: [0, -7, 7, -5, 5, 0],
    y: [0, 3, -2, 2, 0, 0],
};

export const SHAKE_TIMING = {
    duration: 0.35,
    ease: "easeOut" as const,
};

/** The board's rattle when the ROUND-ENDING tile lands — bigger again,
 * matching `SLAM_KEYFRAMES_FINAL`'s own jump over the ordinary slam.
 * Raised alongside it on the same request (±11/±5px -> ±13/±6px, a
 * touch longer to settle). */
export const SHAKE_KEYFRAMES_FINAL = {
    x: [0, -13, 13, -9, 9, 0],
    y: [0, 6, -4, 4, 0, 0],
};

export const SHAKE_TIMING_FINAL = {
    duration: 0.52,
    ease: "easeOut" as const,
};

/** Honoured by the choreographer, by <Piece>'s slam, and — via
 * `MotionConfig reducedMotion="user"` in the root layout — by every
 * motion component's transform animations. */
export function prefersReducedMotion(): boolean {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * True on a device with a real mouse — a genuine hover state that
 * previews without committing. False on touch-primary devices (no
 * pointer that can rest over something without acting on it), which is
 * what PieceLayer's hand-card hover uses to decide whether a tap should
 * preview-then-confirm (touch) or act immediately (mouse, since hover
 * already did the previewing). `(pointer: fine)` alongside `(hover:
 * hover)` rules out a mouse-emulated hover on a coarse touchscreen.
 */
export function supportsHover(): boolean {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}
