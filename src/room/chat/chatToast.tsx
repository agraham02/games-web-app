"use client";

/**
 * Something somebody said in the lobby, popped up where toasts go (the
 * user, 2026-10-01: "In the lobby, show the chat messages as a toast,
 * instead of us having to open the chat window to see the messages as they
 * come").
 *
 * The lobby only. At the table what people say goes on their pod
 * (`SeatBubbles`), and the toast lane there is the game's own news — chat
 * was never to be a toast at the table. Tapping it opens the chat, where
 * it can be answered. The name is tinted as it is in the log.
 */

import { MessageCircle } from "lucide-react";
import { toast } from "sonner";
import type { ChatMessage } from "@/session/chat";
import { bubbleMs } from "@/table/SeatBubbles";
import { tintFor } from "../Roster";

/** Chat toasts still up, so they can be put away together. */
const showing = new Set<string | number>();

/**
 * Puts every chat toast away: the chat has been opened, the table has come
 * up, or the room screen is gone. Not just tidiness — sonner replays any
 * toast still up into the next `Toaster` to mount, and the table mounts its
 * own, so a "Good luck!" from the lobby would arrive at the table as a toast.
 */
export function dismissChatToasts() {
  for (const id of showing) toast.dismiss(id);
  showing.clear();
}

export function chatToast(message: ChatMessage, onOpen: () => void) {
  const id = toast.custom(
    (id) => (
      <button
        type="button"
        aria-label={`${message.name}: ${message.text}. Open the chat`}
        onClick={() => {
          toast.dismiss(id);
          onOpen();
        }}
        className="flex max-w-[min(22rem,calc(100vw-1.5rem))] items-start gap-2 rounded-2xl bg-felt-950/90 px-3.5 py-2 text-left text-[13px] leading-snug text-bone-50 shadow-e2 ring-1 ring-brass-400/30 backdrop-blur-md"
      >
        <MessageCircle size={14} strokeWidth={2.25} aria-hidden className="mt-0.5 shrink-0 text-brass-300" />
        <span className="line-clamp-3 min-w-0 wrap-break-word">
          <span className="mr-1.5 font-semibold" style={{ color: tintFor(message.session) }}>
            {message.name}
          </span>
          {message.text}
        </span>
      </button>
    ),
    {
      duration: bubbleMs(message.text),
      onAutoClose: (t) => showing.delete(t.id),
      onDismiss: (t) => showing.delete(t.id),
    },
  );
  showing.add(id);
}
