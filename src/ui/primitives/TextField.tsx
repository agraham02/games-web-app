"use client";

/**
 * Text input, and the four-letter code field.
 *
 * Worth noting that before this file the app contained no text input of any
 * kind — every `<input>` in it was a range slider. That is what a
 * single-player game against bots gets you: nothing to name, nobody to
 * name it to.
 */

import { useId, type InputHTMLAttributes, type Ref } from "react";
import { CODE_LENGTH } from "@/session/room";
import { cn } from "@/lib/utils";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  ref?: Ref<HTMLInputElement>;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  className = "",
  ref,
  ...rest
}: TextFieldProps) {
  const noteId = useId();
  return (
    <label className={cn("flex w-full flex-col gap-1.5", className)}>
      <span className="eyebrow">{label}</span>
      <input
        {...rest}
        ref={ref}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg bg-felt-950/60 px-3.5 py-3 font-sans text-base text-bone-50 ring-1 ring-bone-50/16 outline-none placeholder:text-bone-600 focus:ring-2 focus:ring-brass-400 aria-invalid:ring-destructive/70"
      />
      {error ? (
        <span id={noteId} className="text-xs font-semibold text-destructive">
          {error}
        </span>
      ) : hint ? (
        <span id={noteId} className="text-xs text-bone-400">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/**
 * A join code as the server will accept it: upper case, letters only, at
 * most `CODE_LENGTH` of them.
 *
 * The one sanitiser. The room screen used to keep its own copy with the
 * length written in as 4, beside this field's — two rules for one code.
 */
export function cleanCode(raw: string | undefined): string {
  return (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, CODE_LENGTH);
}

/**
 * The join code, as one box per letter.
 *
 * A single text field would work and would be worse: a code is read aloud
 * off somebody else's screen one letter at a time, and per-character boxes
 * match how it is actually being transcribed. It is a single `<input>`
 * underneath with the boxes drawn behind it, because four real inputs means
 * four focus states, four paste behaviours and a backspace problem.
 *
 * The next box is ringed only while the field has focus. Ringed always, it
 * read as a field demanding to be filled on a screen where joining is the
 * second choice.
 */
export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Enter, whether or not the code is whole — the caller decides what a
   * short one means. Inside a form it replaces the form's own Enter, which
   * would press the form's primary button: making a room, while the player
   * was typing a code to join one.
   */
  onEnter?: () => void;
  label?: string;
  error?: string;
  ref?: Ref<HTMLInputElement>;
}

export function CodeInput({ value, onChange, onEnter, label = "Room code", error, ref }: CodeInputProps) {
  const cells = Array.from({ length: CODE_LENGTH }, (_, i) => value[i] ?? "");
  const errorId = useId();

  return (
    <div className="flex w-full flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <div className="group relative">
        <input
          ref={ref}
          value={value}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={CODE_LENGTH}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          // Cleaned on the way in, so the field cannot hold something the
          // server would only reject later.
          onChange={(e) => onChange(cleanCode(e.target.value))}
          onKeyDown={(e) => {
            if (!onEnter || e.key !== "Enter") return;
            e.preventDefault();
            onEnter();
          }}
          // Invisible but genuinely focused and on top: the boxes below are
          // decoration, and the caret lives here.
          className="absolute inset-0 z-10 w-full cursor-text bg-transparent text-transparent caret-transparent outline-none"
        />
        <div className="pointer-events-none flex gap-2">
          {cells.map((char, i) => (
            <div
              key={i}
              className={cn(
                "flex h-14 flex-1 items-center justify-center rounded-lg bg-felt-950/60 font-display text-2xl text-bone-50 ring-1 ring-bone-50/16",
                error && "ring-destructive/60",
                i === value.length && "group-focus-within:ring-2 group-focus-within:ring-brass-400",
              )}
            >
              {char}
            </div>
          ))}
        </div>
      </div>
      {error ? (
        <span id={errorId} className="text-xs font-semibold text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
