"use client";

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
}: NumberStepperProps) {
  const button =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-bone-50/6 text-xl font-bold text-bone-100 ring-1 ring-bone-50/14 hover:bg-brass-400/15 hover:text-brass-300 disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="flex items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - step))}
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
      <span className="tnum min-w-[2ch] px-1 text-center font-display text-4xl font-extrabold text-brass-300">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + step))}
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
