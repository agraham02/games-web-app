"use client";

/**
 * The room's chat: a drawer from the right, in the lobby and at the table
 * (the user, 2026-09-29). Rung 5 of POLICY.md — opened on purpose, dims what
 * is behind it, and a tap outside puts it away.
 *
 * What was said scrolls; what you are about to say does not. The composer
 * is pinned to the sheet's foot and lifted above the on-screen keyboard
 * (`useKeyboardInset`), with the quick replies in one sideways row directly
 * above the field, so a one-tap answer never needs the keyboard at all.
 *
 * During a partnership hand you are in, only the table-safe quick replies
 * can be sent (`ChatMode`): the field is disabled with the reason as its
 * placeholder, and the other replies are dimmed, not hidden — the row does
 * not rearrange itself under a thumb that learned where things are.
 */

import { SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  CHAT_MAX_CHARS,
  QUICK_REPLIES,
  charCount,
  chatTextProblem,
  cleanChatText,
  type ChatMessage,
  type ChatMode,
} from "@/session/chat";
import { InfoSheet } from "@/ui/disclosure";
import { Button } from "@/ui/primitives/Button";
import { tintFor } from "../Roster";
import { useKeyboardInset } from "./useKeyboardInset";
import { edgeFade, useSidewaysScroll } from "./useSidewaysScroll";

/** Past this few characters left, the composer says how many. */
const COUNT_FROM = 20;

export interface ChatSheetProps {
  open: boolean;
  onClose: () => void;
  messages: readonly ChatMessage[];
  /** Your session, so your own lines read "You". */
  you: string;
  mode: ChatMode;
  onSend: (said: { text: string } | { quick: string }) => void;
}

export function ChatSheet({ open, onClose, messages, you, mode, onSend }: ChatSheetProps) {
  const inset = useKeyboardInset(open);
  return (
    <InfoSheet
      open={open}
      title="Chat"
      side="right"
      layer="page"
      onClose={onClose}
      inset={inset}
      footer={<Composer mode={mode} onSend={onSend} />}
    >
      <Log messages={messages} you={you} />
    </InfoSheet>
  );
}

function Log({ messages, you }: { messages: readonly ChatMessage[]; you: string }) {
  const end = useRef<HTMLDivElement>(null);
  const last = messages.at(-1)?.id;
  // The newest line in view whenever one arrives, as any chat does.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [last]);

  if (messages.length === 0) {
    return <p className="py-6 text-center text-sm text-bone-400">Nothing said yet. Say hello.</p>;
  }
  return (
    <>
      <ol aria-label="Messages" className="flex flex-col gap-2 pb-1">
        {messages.map((m) => (
          <li key={m.id} className="text-sm leading-snug break-words text-bone-100">
            <span
              className="mr-1.5 font-semibold"
              style={{
                color: m.session === you ? undefined : tintFor(m.session),
              }}
            >
              {m.session === you ? "You" : m.name}
            </span>
            {m.text}
          </li>
        ))}
      </ol>
      <div ref={end} />
    </>
  );
}

function Composer({ mode, onSend }: { mode: ChatMode; onSend: ChatSheetProps["onSend"] }) {
  const [draft, setDraft] = useState("");
  const locked = mode === "quick-only";
  const text = cleanChatText(draft);
  const left = CHAT_MAX_CHARS - charCount(text);
  const sendable = !locked && chatTextProblem(text) === null;
  const { ref: rowRef, edges } = useSidewaysScroll<HTMLDivElement>();
  const fade = edgeFade(edges);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={rowRef}
        role="group"
        aria-label="Quick replies"
        // Sideways, and the table must not take the swipe (`usePanZone`).
        data-pan-ignore
        // Snaps under a finger only: a mouse wheel's small steps and a mouse
        // drag would each be snapped back to where they started
        // (`useSidewaysScroll`). `scroll-px-4`: snapping otherwise lines the
        // first reply up with the row's edge rather than its padding.
        className="-mx-4 flex touch-pan-x scroll-px-4 gap-1.5 overflow-x-auto px-4 pb-1 select-none [scrollbar-width:none] pointer-coarse:snap-x"
        // Whichever end has more replies beyond it fades out, so a row cut
        // off at the sheet's edge reads as one that goes on.
        style={{ maskImage: fade, WebkitMaskImage: fade }}
      >
        {QUICK_REPLIES.map((q) => {
          const off = locked && !q.tableSafe;
          return (
            <button
              key={q.id}
              type="button"
              disabled={off}
              onClick={() => onSend({ quick: q.id })}
              className="shrink-0 snap-start rounded-full bg-bone-50/8 px-3 py-1.5 text-sm whitespace-nowrap text-bone-100 ring-1 ring-bone-50/14 hover:bg-bone-50/14 disabled:brightness-50 disabled:grayscale"
            >
              {q.text}
            </button>
          );
        })}
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!sendable) return;
          onSend({ text });
          setDraft("");
        }}
      >
        <input
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={locked}
          placeholder={locked ? "No table talk until the hand is over" : "Say something"}
          enterKeyHint="send"
          autoComplete="off"
          // 16px, or iOS zooms the page in on focus.
          className="min-w-0 flex-1 rounded-lg bg-felt-950/60 px-3 py-2.5 text-base text-bone-50 ring-1 ring-bone-50/14 outline-none placeholder:text-bone-500 focus:ring-2 focus:ring-brass-400 disabled:opacity-60"
        />
        <Button
          type="submit"
          tone="primary"
          size="sm"
          aria-label="Send"
          disabled={!sendable}
          className="h-10 px-3"
        >
          <SendHorizontal size={16} aria-hidden />
        </Button>
      </form>
      {/* Locked, the field's own placeholder already says why and until
          when; a note under it said the same thing again. */}
      {!locked && left <= COUNT_FROM ? (
        <p
          className={`text-right text-[11px] ${left < 0 ? "text-loss" : "text-bone-400"}`}
          aria-live="polite"
        >
          {left < 0 ? `${-left} too many` : `${left} left`}
        </p>
      ) : null}
    </div>
  );
}
