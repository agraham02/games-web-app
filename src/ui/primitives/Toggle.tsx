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
 *
 * The whole row is the switch (Base UI's, rendered as a real button), so
 * the label and the hint are its accessible name and every pixel of it is
 * the target.
 *
 * Two ways to be unpressable, and they must not look alike:
 *
 * - `unavailable` — the rule is NOT IN EFFECT under the current settings
 *   (Six love without partners). It shows off, with a hint saying why.
 * - `locked` — the rule is whatever it is, and this person may not change
 *   it (a room's settings, seen by anyone but the leader). It shows its
 *   REAL value, dimmed and read-only. These used to be one `disabled` prop
 *   that forced the switch off, so everyone but the leader was shown every
 *   locked rule as off — Teams and Key tile read OFF above a roster of
 *   Team A/B chips.
 */

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

export interface ToggleProps {
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
  unavailable?: boolean;
  /** Read-only: the real value, dimmed. See the file's doc. */
  locked?: boolean;
  /** The old name for `unavailable`, kept so existing callers read the same. */
  disabled?: boolean;
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  unavailable = false,
  locked = false,
  disabled,
}: ToggleProps) {
  const off = unavailable || Boolean(disabled);
  return (
    <SwitchPrimitive.Root
      nativeButton
      render={<button type="button" />}
      checked={checked && !off}
      onCheckedChange={(next) => onChange(next)}
      disabled={off}
      readOnly={locked}
      className={cn(
        "group flex w-full flex-col gap-0.5 rounded-lg px-3.5 py-2.5 text-left ring-1 transition-colors duration-(--duration-ui) outline-none",
        "bg-bone-50/5 ring-bone-50/12 data-checked:bg-brass-400/18 data-checked:ring-brass-400/60",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "data-disabled:cursor-not-allowed data-disabled:opacity-45",
        "data-readonly:cursor-not-allowed data-readonly:opacity-45",
      )}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-sm font-bold text-bone-200 group-data-checked:text-brass-300">
          {label}
        </span>
        <span
          aria-hidden
          className="flex h-5 w-9 shrink-0 items-center rounded-full bg-bone-50/15 px-0.5 transition-colors duration-(--duration-ui) group-data-checked:bg-primary"
        >
          <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-felt-950 transition-transform duration-(--duration-ui) data-checked:translate-x-4" />
        </span>
      </span>
      <span className="text-[11px] text-bone-500">{hint}</span>
    </SwitchPrimitive.Root>
  );
}
