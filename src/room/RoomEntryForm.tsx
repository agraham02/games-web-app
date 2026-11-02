"use client";

/**
 * The one form for getting into a room: on the home screen, behind a
 * shared link, and after a way in did not work.
 *
 * There were three — the home screen's, `/room`'s and the invitation's —
 * and a person could meet all three in one evening (follow a link, get
 * turned away, go home to make their own room). Each had its own heading,
 * its own louder button and its own wording for the same missing name, the
 * room screen kept a second copy of the code's sanitiser with the length
 * written in as 4, and only one of them could show why a join failed.
 *
 * What differs is `mode`:
 *
 *  - `home` — make a room, or join one by code. The primary button follows
 *    the code: a whole code makes Join the one Enter presses.
 *  - `invite` — the code came from a link, so the form is about joining
 *    THAT room; making your own is a quiet link.
 *  - `retry` — like `home`, under the reason the last attempt did not work
 *    (`notice`), which stays until the next attempt rather than being a
 *    toast over the form.
 *
 * What it does with a name and a code is the caller's: the home screen
 * hands an intent to the room screen (`entry.ts`); the room screen sends it.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MOVE_CODE_LENGTH } from "@/session/protocol";
import { CODE_LENGTH } from "@/session/room";
import { Collapse } from "@/ui/motion";
import { Button } from "@/ui/primitives/Button";
import { CodeInput, TextField, cleanCode } from "@/ui/primitives/TextField";
import { readSavedName, saveName } from "./entry";

export type RoomEntryMode = "home" | "invite" | "retry";

export interface RoomEntryFormProps {
  mode: RoomEntryMode;
  /** The code to start on — an invitation's, or one worth asking again. */
  initialCode?: string;
  /** Why the last way in did not work, above everything else (`retry`). */
  notice?: string;
  /** The server's answer about one field — a name already taken, a code
   * with no room behind it. Shown under that field until the next try. */
  errors?: { name?: string; code?: string; pin?: string };
  onMake: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  /**
   * Moving to this device from one already in the room: the room's code (the
   * field above) and the digits that device showed. Without it the form has
   * no such option. It needs no name — the seat has one.
   */
  onClaim?: (code: string, pin: string) => void;
  /**
   * Something else on the screen is the one thing to do — the home
   * screen's "go back to your room" — so none of these buttons is brass.
   */
  quiet?: boolean;
}

export function RoomEntryForm({
  mode,
  initialCode,
  notice,
  errors,
  onMake,
  onJoin,
  onClaim,
  quiet = false,
}: RoomEntryFormProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(() => cleanCode(initialCode));
  /** The field an attempt stopped at, for its message and its focus. */
  const [missing, setMissing] = useState<"name" | "code" | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // Moving from another device. Open from the start when the last try at it
  // was refused: its answer belongs under the digits.
  const [moving, setMoving] = useState(Boolean(errors?.pin));
  const [pin, setPin] = useState("");

  useEffect(() => {
    // After mount, not in a lazy initializer: the page is prerendered, and
    // a filled field in the browser against an empty one in the HTML is a
    // hydration mismatch on a controlled input.
    const saved = readSavedName();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setName(saved);
  }, []);

  const named = name.trim().length > 0;
  const complete = code.length === CODE_LENGTH;
  /** Join is the primary action: an invitation, or a whole code typed. */
  const joinFirst = mode === "invite" || complete;

  const stopAt = (field: "name" | "code") => {
    setMissing(field);
    (field === "name" ? nameRef : codeRef).current?.focus();
  };
  const make = () => {
    if (!named) return stopAt("name");
    saveName(name);
    onMake(name.trim());
  };
  const join = () => {
    if (!named) return stopAt("name");
    if (!complete) return stopAt("code");
    saveName(name);
    onJoin(code, name.trim());
  };
  const move = () => {
    if (!complete) return stopAt("code");
    if (pin.length !== MOVE_CODE_LENGTH) return;
    onClaim?.(code, pin);
  };
  const loud = quiet ? "ghost" : "primary";
  // Enter presses the primary button, whichever that is right now.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (moving) move();
    else if (joinFirst) join();
    else make();
  };

  const nameError =
    errors?.name ?? (missing === "name" && !named ? "A name is needed to play in a room" : undefined);
  const codeError =
    errors?.code ?? (missing === "code" && !complete ? `A room code is ${CODE_LENGTH} letters` : undefined);

  return (
    <form noValidate onSubmit={submit} className="flex w-full flex-col gap-4">
      <Collapse open={Boolean(notice)}>
        <p
          role="status"
          className="rounded-lg bg-destructive/10 px-4 py-3 text-sm leading-relaxed text-bone-100 ring-1 ring-destructive/40"
        >
          {notice}
        </p>
      </Collapse>

      <TextField
        ref={nameRef}
        label="Your name"
        value={name}
        onChange={setName}
        placeholder="Ada"
        maxLength={20}
        autoComplete="nickname"
        error={nameError}
      />

      {mode === "invite" ? (
        <>
          <Button type="submit" tone={loud} className="w-full">
            Join room {code}
          </Button>
          <button
            type="button"
            className="self-center text-xs text-bone-400 underline-offset-4 hover:text-bone-200 hover:underline"
            onClick={make}
          >
            or make a room of your own
          </button>
        </>
      ) : (
        <>
          {/* Both buttons stay where they are and trade weight, so the one
              under a finger never moves. */}
          <Button
            type={joinFirst ? "button" : "submit"}
            tone={joinFirst ? "ghost" : loud}
            className="w-full"
            onClick={joinFirst ? make : undefined}
          >
            Make a room
          </Button>

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-bone-50/12" />
            <span className="eyebrow">or join one</span>
            <span className="h-px flex-1 bg-bone-50/12" />
          </div>

          <CodeInput ref={codeRef} value={code} onChange={setCode} onEnter={join} error={codeError} />
          <Button
            type={joinFirst ? "submit" : "button"}
            tone={joinFirst ? loud : "ghost"}
            className="w-full"
            disabled={!complete}
          >
            Join room
          </Button>
        </>
      )}

      {onClaim ? (
        <>
          <button
            type="button"
            aria-expanded={moving}
            className="self-center text-xs text-bone-400 underline-offset-4 hover:text-bone-200 hover:underline"
            onClick={() => setMoving((m) => !m)}
          >
            {moving ? "Never mind" : "Already playing on another device?"}
          </button>
          <Collapse open={moving}>
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed text-bone-400">
                On that device, open Settings and choose Play on another device. Type the room code above and the
                four digits it shows.
              </p>
              <TextField
                label="Code from your other device"
                value={pin}
                onChange={(v) => setPin(v.replace(/\D/g, "").slice(0, MOVE_CODE_LENGTH))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="0000"
                maxLength={MOVE_CODE_LENGTH}
                error={errors?.pin}
              />
              <Button
                type="submit"
                tone={loud}
                className="w-full"
                disabled={!complete || pin.length !== MOVE_CODE_LENGTH}
              >
                Continue here
              </Button>
            </div>
          </Collapse>
        </>
      ) : null}
    </form>
  );
}
