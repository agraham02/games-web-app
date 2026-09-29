"use client";

/**
 * How somebody gets into this room: the code, large, and the link.
 *
 * The lobby used to show the code with a copy button that copied the four
 * letters — which the other person then had to type into a form somewhere.
 * The link is what gets sent in a message: it opens the room's own
 * invitation. Share, where the browser has it, hands the link to the
 * phone's own share sheet; Copy is always there, because Share is not
 * everywhere (and never on an insecure origin, which is exactly where this
 * gets tested — a phone hitting a laptop's dev server).
 *
 * The lobby shows it on top; a table's Settings sheet shows it compact, so
 * somebody can be invited mid-game.
 */

import { Check, Link2, Share } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/ui/primitives/Button";

export function InviteCard({ code, compact = false }: { code: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  // After mount: the server has no `navigator`, and a button that appears
  // only in the browser would be a hydration mismatch.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  const link = () => `${window.location.origin}/room/${code}`;

  const copy = () => {
    // Best effort: clipboard access is refused on insecure origins. The
    // code is on screen in large type either way.
    void navigator.clipboard
      ?.writeText(link())
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const share = () => {
    void navigator
      .share({ title: "Join my table", text: `Room ${code}`, url: link() })
      .catch(() => {
        /* Dismissed, or refused: nothing to say. */
      });
  };

  return (
    <div className={`flex w-full flex-col items-center ${compact ? "gap-2" : "gap-3"}`}>
      <span className="eyebrow">Room code</span>
      <span
        className={`font-display tracking-[0.3em] text-brass-300 ${compact ? "text-2xl" : "text-4xl"}`}
      >
        {code}
      </span>
      <div className="flex gap-2">
        <Button size="sm" onClick={copy} aria-label={`Copy the link to room ${code}`}>
          {copied ? <Check size={12} /> : <Link2 size={12} />}
          {copied ? "Copied" : "Copy link"}
        </Button>
        {canShare ? (
          <Button size="sm" onClick={share}>
            <Share size={12} /> Share
          </Button>
        ) : null}
      </div>
    </div>
  );
}
