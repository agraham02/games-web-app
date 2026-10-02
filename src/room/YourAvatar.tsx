"use client";

/**
 * Your own avatar in the roster, which is also where you set your photo
 * (the user, 2026-09-29: optional, for this room session only).
 *
 * Tapping it opens the device's own picker — a phone's offers the camera —
 * and the picture is cropped and shrunk here before anything is sent
 * (`photoFromFile`). The camera badge says it can be tapped; it is the one
 * avatar in the list that can.
 */

import { Camera } from "lucide-react";
import { useRef, useState } from "react";
import { photoUrl } from "@/session/photo";
import type { MemberView } from "@/session/protocol";
import { announce } from "@/ui/disclosure";
import { Avatar } from "@/ui/primitives/Avatar";
import { photoFromFile, savePhoto } from "./photo";

export function YourAvatar({
  member,
  colour,
  onPhoto,
}: {
  member: MemberView;
  colour: string;
  onPhoto: (image: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File) => {
    setBusy(true);
    try {
      const image = await photoFromFile(file);
      savePhoto(image);
      onPhoto(image);
    } catch {
      // Most often an HEIC from an iPhone's library, on a browser that
      // cannot decode one.
      announce("That picture could not be read — try a JPEG or PNG", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={member.photo ? "Change your photo" : "Add a photo"}
        title={member.photo ? "Change your photo" : "Add a photo"}
        disabled={busy}
        onClick={() => input.current?.click()}
        className="relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brass-400 disabled:opacity-60"
      >
        <Avatar name={member.name} colour={colour} src={member.photo ? photoUrl(member.photo) : null} />
        <span
          aria-hidden
          className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-brass-400 text-felt-950 ring-1 ring-felt-950/60"
        >
          <Camera size={10} strokeWidth={2.5} />
        </span>
      </button>
      <input
        ref={input}
        type="file"
        // No `capture`: every device gets its own picker, and a phone's
        // already offers the camera beside the library (the user's call).
        accept="image/*"
        className="hidden"
        data-testid="photo-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared, so choosing the same picture again still fires.
          e.target.value = "";
          if (file) void pick(file);
        }}
      />
    </>
  );
}

/** "Remove photo", for your own row once you have one. */
export function RemovePhoto({ onPhoto }: { onPhoto: (image: string | null) => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        savePhoto(null);
        onPhoto(null);
      }}
      className="ml-1 text-bone-300 underline-offset-2 hover:text-bone-100 hover:underline"
    >
      Remove photo
    </button>
  );
}
