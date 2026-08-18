"use client";

/**
 * An optional rule, on or off, with a line saying what it does.
 *
 * Written for Spades' jokers/deuces options and lifted out of that page
 * when Caribbean dominoes needed the same control for its key-tile and
 * six-love rules. A setup screen's optional-rule row should look and
 * behave identically in every game — a player who has learned one has
 * learned all of them — which is the whole argument for it living here
 * rather than being reimplemented per page.
 *
 * The hint is required, not optional. An optional rule whose name is its
 * only explanation ("Six love") is a rule nobody turns on.
 */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /**
   * For a rule that isn't available under the current settings. It stays
   * VISIBLE and readable rather than vanishing — a control that
   * disappears takes its own explanation with it, so the player never
   * learns the option exists, let alone what would unlock it. Pair this
   * with a `hint` that says why (POLICY.md: "dim, don't hide").
   */
  disabled?: boolean;
}) {
  const on = checked && !disabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex flex-col gap-0.5 rounded-lg px-3.5 py-2.5 text-left ring-1 ${
        on ? "bg-brass-400/18 ring-brass-400/60" : "bg-bone-50/5 ring-bone-50/12"
      } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
    >
      <span className="flex items-center justify-between">
        <span className={`text-sm font-bold ${on ? "text-brass-300" : "text-bone-200"}`}>
          {label}
        </span>
        <span
          className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
            on ? "justify-end bg-brass-400" : "justify-start bg-bone-50/15"
          }`}
        >
          <span className="h-4 w-4 rounded-full bg-felt-950" />
        </span>
      </span>
      <span className="text-[11px] text-bone-500">{hint}</span>
    </button>
  );
}
