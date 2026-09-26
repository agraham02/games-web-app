/**
 * One labelled control on a setup screen — the single header style every
 * game shares.
 *
 * Setup screens used to caption their controls three different ways (a
 * centred eyebrow, a bold row with the value at the right, a bold centred
 * line) and, worse, used a slider, a stepper or a button row for the same
 * KIND of question from one game to the next. The header matches
 * `DifficultyPicker`'s, since that is already on five screens.
 *
 * The rule for which control to use, so the next setting is not a fresh
 * debate:
 *
 * - a small bounded count (players)      → `SeatsSlider`
 * - an open-ended number (a score, chips) → `NumberStepper`
 * - a few named alternatives              → a button row
 * - an on/off rule                        → `Toggle`
 * - how good the bots are                 → `DifficultyPicker`
 */
export interface SetupFieldProps {
  label: string;
  /** Shown at the right of the header — for a control with no number of its own. */
  value?: React.ReactNode;
  /** One line under the control saying what it changes. */
  hint?: React.ReactNode;
  children?: React.ReactNode;
}

export function SetupField({ label, value, hint, children }: SetupFieldProps) {
  return (
    <div className="flex w-full flex-col gap-2">
      <span className="flex items-center justify-between text-xs font-bold text-bone-200">
        {label}
        {value !== undefined ? <span className="tnum text-brass-300">{value}</span> : null}
      </span>
      {children}
      {hint ? <span className="text-center text-[11px] text-bone-500">{hint}</span> : null}
    </div>
  );
}

export interface SeatsSliderProps {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}

/** The player-count control: a slider with the count in the header. */
export function SeatsSlider({ value, min, max, onChange }: SeatsSliderProps) {
  return (
    <SetupField label="Players" value={value}>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Players"
        className="w-full accent-brass-400"
      />
    </SetupField>
  );
}
