"use client";

/**
 * Text input, and the four-letter code field.
 *
 * Worth noting that before this file the app contained no text input of any
 * kind — every `<input>` in it was a range slider. That is what a
 * single-player game against bots gets you: nothing to name, nobody to
 * name it to.
 */

import type { InputHTMLAttributes } from "react";
import { CODE_LENGTH } from "@/session/room";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  className = "",
  ...rest
}: TextFieldProps) {
  return (
    <label className={`flex w-full flex-col gap-1.5 ${className}`}>
      <span className="eyebrow">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg bg-felt-950/60 px-3.5 py-3 font-sans text-base text-bone-50 ring-1 ring-bone-50/16 outline-none placeholder:text-bone-600 focus:ring-2 focus:ring-brass-400"
      />
      {error ? (
        <span className="text-xs font-semibold" style={{ color: "var(--color-loss)" }}>
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-bone-400">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * The join code, as one box per letter.
 *
 * A single text field would work and would be worse: a code is read aloud
 * off somebody else's screen one letter at a time, and per-character boxes
 * match how it is actually being transcribed. It is a single `<input>`
 * underneath with the boxes drawn behind it, because four real inputs means
 * four focus states, four paste behaviours and a backspace problem.
 */
export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  label?: string;
  error?: string;
}

export function CodeInput({ value, onChange, onSubmit, label = "Room code", error }: CodeInputProps) {
  const cells = Array.from({ length: CODE_LENGTH }, (_, i) => value[i] ?? "");

  return (
    <div className="flex w-full flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <div className="relative">
        <input
          value={value}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={CODE_LENGTH}
          aria-label={label}
          // Uppercased on the way in, and non-letters dropped, so the field
          // cannot hold something the server would only reject later.
          onChange={(e) =>
            onChange(
              e.target.value
                .toUpperCase()
                .replace(/[^A-Z]/g, "")
                .slice(0, CODE_LENGTH),
            )
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.length === CODE_LENGTH) onSubmit?.();
          }}
          // Invisible but genuinely focused and on top: the boxes below are
          // decoration, and the caret lives here.
          className="absolute inset-0 z-10 w-full cursor-text bg-transparent text-transparent caret-transparent outline-none"
        />
        <div className="pointer-events-none flex gap-2">
          {cells.map((char, i) => (
            <div
              key={i}
              className={`flex h-14 flex-1 items-center justify-center rounded-lg bg-felt-950/60 font-display text-2xl text-bone-50 ring-1 ${
                i === value.length ? "ring-2 ring-brass-400" : "ring-bone-50/16"
              }`}
            >
              {char}
            </div>
          ))}
        </div>
      </div>
      {error ? (
        <span className="text-xs font-semibold" style={{ color: "var(--color-loss)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
