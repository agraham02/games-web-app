"use client";

import { useRef, useState } from "react";

/**
 * A big centred number with +/- either side, rather than a wall of
 * buttons — one number to read, not thirteen.
 *
 * The end buttons disable (dim, and stop responding) exactly at
 * `min`/`max`, so there is never a tap that silently does nothing.
 *
 * Started life inside Spades' bid pad and moved here once Rummy's setup
 * controls became a second consumer. `step` is why it needed the move:
 * a bid steps by 1, a win threshold by 25, and copying the component to
 * change one number is how two subtly different steppers end up in the
 * same app.
 */
export interface NumberStepperProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** How much one press moves the value. Default 1. */
  step?: number;
  /**
   * What is being counted, for the buttons' aria-labels — "tricks",
   * "cards", "points". Renders as "Fewer tricks" / "More tricks".
   */
  label?: string;
  /**
   * Whether the value may be changed at all.
   *
   * Distinct from the range ends, which each button already guards for
   * itself: this is "not right now, by anybody". Without it a caller
   * could only gate its `onChange`, which leaves two buttons that look
   * exactly as pressable as ever and quietly do nothing.
   */
  disabled?: boolean;
  /** Why it cannot be changed, as a tooltip on both buttons. */
  title?: string;
  /** How the number reads — "$125" rather than "125" for a bet. */
  format?: (value: number) => string;
  /**
   * `sm` for a stepper that has to share a row with other controls — a
   * setup screen has the height for the big number, a betting bar that
   * must fit between the board and the hand does not.
   */
  size?: "md" | "sm";
  /**
   * Tapping the number turns it into a field to type any value in range.
   * For a figure the buttons cannot reach every value of in sensible time:
   * a poker raise steps by the big blind, and without this $160 was simply
   * not a raise anyone could make (reported 2026-09-28).
   */
  editable?: boolean;
  /**
   * Step to multiples of `step` rather than by `step` from wherever the
   * value is: $154 goes up to $160, then $180, instead of $174 and $194.
   * The range's own ends are still reachable, clamped as always.
   */
  snap?: boolean;
}

export function NumberStepper({
  value,
  min,
  max,
  onChange,
  step = 1,
  label = "value",
  disabled = false,
  title,
  format,
  size = "md",
  editable = false,
  snap = false,
}: NumberStepperProps) {
  const small = size === "sm";
  const lower = snap ? Math.ceil(value / step) * step - step : value - step;
  const higher = snap ? Math.floor(value / step) * step + step : value + step;
  // What is being typed, while the number is a field; null when it is not.
  const [draft, setDraft] = useState<string | null>(null);
  // Escape closes the field without its value. The field's removal can
  // still fire a blur, and that blur must not commit what Escape dropped.
  const cancelled = useRef(false);
  const commit = () => {
    if (draft === null || cancelled.current) return;
    const typed = Number.parseInt(draft.replace(/[^0-9]/g, ""), 10);
    // Out of range is clamped to it rather than refused: a player who types
    // more than they have means all of it.
    if (Number.isFinite(typed)) onChange(Math.min(max, Math.max(min, typed)));
    setDraft(null);
  };
  const figure = `tnum min-w-[2ch] px-1 text-center font-display ${small ? "text-2xl" : "text-4xl"} font-extrabold text-brass-300`;
  const button =
    `flex ${small ? "h-9 w-9" : "h-11 w-11"} shrink-0 items-center justify-center rounded-full bg-bone-50/6 text-xl font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300 disabled:pointer-events-none disabled:opacity-30`;

  return (
    <div className="flex items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, lower))}
        disabled={disabled || value <= min}
        title={title}
        aria-label={`Fewer ${label}`}
        className={button}
      >
        −
      </button>
      {/* Sized to its CONTENT, with a floor — not a fixed width.
          A fixed width has to be wrong at one end or the other: wide
          enough for "250" leaves a lake of space around "5", and narrow
          enough to suit "5" makes "250" overflow into the buttons, which
          is what it did. `min-w` keeps a one-digit value from collapsing
          the row, and `tnum` keeps digits equal width so the number does
          not jitter as it counts. */}
      {draft !== null ? (
        <input
          // Focused the moment it appears: the tap that opened it was the
          // request to type.
          autoFocus
          type="text"
          inputMode="numeric"
          enterKeyHint="done"
          aria-label={`Type the number of ${label}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              cancelled.current = true;
              setDraft(null);
            }
          }}
          className={`${figure} rounded-lg bg-felt-950/60 ring-1 ring-brass-400/50 outline-none`}
          style={{ width: `${Math.max(3, String(max).length + 1)}ch` }}
        />
      ) : editable && !disabled ? (
        // Dotted underline: the number is also a control, and says so.
        <button
          type="button"
          onClick={() => {
            cancelled.current = false;
            setDraft(String(value));
          }}
          aria-label={`${format ? format(value) : value} — tap to type the number of ${label}`}
          className={`${figure} underline decoration-brass-400/45 decoration-dotted decoration-2 underline-offset-4`}
        >
          {format ? format(value) : value}
        </button>
      ) : (
        <span className={figure}>{format ? format(value) : value}</span>
      )}
      <button
        type="button"
        onClick={() => onChange(Math.min(max, higher))}
        disabled={disabled || value >= max}
        title={title}
        aria-label={`More ${label}`}
        className={button}
      >
        +
      </button>
    </div>
  );
}
