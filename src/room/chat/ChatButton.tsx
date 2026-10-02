"use client";

import { MessageCircle } from "lucide-react";
import { Button } from "@/ui/primitives/Button";

/**
 * Opens the chat. An icon, like Settings beside it (the user, 2026-09-29):
 * two words side by side crowded a phone's corner. The count is messages
 * from other people since the chat was last open: at the table the one
 * sign of them besides the bubbles on pods, since chat there is never a
 * toast (in the lobby it is — `chatToast`).
 */
export function ChatButton({ unread, onClick }: { unread: number; onClick: () => void }) {
  const label = unread > 0 ? `Chat, ${unread} new` : "Chat";
  return (
    <Button size="sm" aria-label={label} title="Chat" onClick={onClick} className="relative">
      <MessageCircle size={16} aria-hidden />
      {unread > 0 ? (
        <span
          aria-hidden
          className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brass-400 px-1 text-[10px] leading-none font-extrabold text-felt-950 ring-1 ring-felt-950/60"
        >
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </Button>
  );
}
