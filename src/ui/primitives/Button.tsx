"use client";

/**
 * The button, finally in one place.
 *
 * Until multiplayer there were about fifteen of these, each a copy-pasted
 * Tailwind class string, and that was tolerable because every one of them
 * lived on a setup screen a person saw once per game. A lobby has a dozen
 * on screen at once — start, kick, promote, approve, deny, shuffle, leave —
 * and fifteen slightly different opinions about padding would be obvious.
 *
 * The three tones are the three jobs the app actually has, and they come
 * straight off the existing screens rather than being invented here: brass
 * gradient for the one thing this screen is FOR, a ghost for everything
 * else, and a red-tinted ghost for the ones you cannot take back.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonTone = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const TONES: Record<ButtonTone, string> = {
  primary:
    "bg-linear-to-b from-brass-300 to-brass-500 text-felt-950 font-extrabold shadow-e2 " +
    "hover:from-brass-200 hover:to-brass-400",
  ghost:
    "bg-bone-50/6 text-bone-200 font-semibold ring-1 ring-bone-50/16 " +
    "hover:bg-bone-50/12 hover:text-bone-50",
  // Tinted rather than filled: a destructive action should be findable
  // without shouting over the primary one it usually sits beside.
  danger:
    "bg-[color-mix(in_oklab,var(--color-loss)_18%,transparent)] text-bone-100 font-semibold " +
    "ring-1 ring-[var(--color-loss)] hover:bg-[color-mix(in_oklab,var(--color-loss)_28%,transparent)]",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs rounded-md",
  md: "px-6 py-3.5 text-sm rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  tone = "ghost",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      // Dimmed and still there, per the disclosure policy's "dim, don't
      // hide": a control that vanishes when unavailable makes the layout
      // jump and teaches nobody why it went.
      className={`inline-flex items-center justify-center gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
