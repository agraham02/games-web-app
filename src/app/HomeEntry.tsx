"use client";

/**
 * The two ways into a room, on the home screen itself.
 *
 * The home page used to offer one brass button among seven ghosts, and
 * that button went to a screen where the real choice was made. So the
 * shortest path to the thing this app is FOR — other people — was three
 * taps and a page that looked like a menu of single-player games.
 *
 * Joining resolves to `/room/<code>`, which is the same URL somebody would
 * paste from a text message. That is deliberate: there is exactly one way
 * a code turns into a room, and the entry screen there already prefills
 * both the code (from the URL) and the name (from the last visit), so
 * arriving by either route lands in the same place with the same fields
 * filled in.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/ui/primitives/Button";
import { CodeInput } from "@/ui/primitives/TextField";
import { CODE_LENGTH } from "@/session/room";

export function HomeEntry() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const complete = code.length === CODE_LENGTH;

  const join = () => {
    if (!complete) return;
    router.push(`/room/${code}`);
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <Button
        tone="primary"
        className="w-full py-4 text-base"
        onClick={() => router.push("/room")}
      >
        Make a room
      </Button>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-bone-50/12" />
        <span className="eyebrow">or join one</span>
        <span className="h-px flex-1 bg-bone-50/12" />
      </div>

      <CodeInput value={code} onChange={setCode} onSubmit={join} />
      <Button className="w-full" disabled={!complete} onClick={join}>
        Join room
      </Button>
    </div>
  );
}
