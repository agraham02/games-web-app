"use client";

/**
 * The rest of the disclosure ladder. See POLICY.md for which rung to
 * reach for — the short version is: pick the lowest one that works.
 */

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Toaster, toast } from "sonner";
import { TRANSITIONS } from "@/motion/presets";
import type { Tone } from "@/engine/types";

export { PeekRail } from "./PeekRail";

/* ============================================================
   Rung 3 — EventToast
   ============================================================ */

/** Mount once inside the table surface. */
export function GameToaster() {
  return (
    <Toaster
      position="top-center"
      offset={12}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex items-center gap-2 rounded-full bg-felt-950/85 px-3.5 py-2 text-[12px] font-semibold text-bone-50 ring-1 ring-brass-400/30 backdrop-blur-md shadow-e2",
        },
      }}
    />
  );
}

/**
 * What a bot just did. Never blocks, never demands acknowledgement.
 * Note the tone rule from POLICY.md: bot successes are `info`, because
 * the app should not celebrate against the player.
 */
export function announce(text: string, tone: Tone = "info") {
  const dot =
    tone === "good"
      ? "bg-win"
      : tone === "bad"
        ? "bg-loss"
        : "bg-brass-400";

  toast.custom(
    () => (
      <div className="flex items-center gap-2 rounded-full bg-felt-950/85 px-3.5 py-2 text-[12px] font-semibold text-bone-50 shadow-e2 ring-1 ring-brass-400/30 backdrop-blur-md">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {text}
      </div>
    ),
    { duration: 2200 },
  );
}

/* ============================================================
   Rung 5 — InfoSheet (non-modal)
   ============================================================ */

/**
 * On-demand detail. Deliberately non-modal: it dims nothing and traps
 * nothing, so the table stays readable behind it.
 */
export function InfoSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          className="absolute inset-x-0 bottom-0 z-2200 max-h-[70%] overflow-y-auto rounded-t-sheet border-t border-brass-400/30 bg-linear-to-b from-felt-800/95 to-felt-900 p-4 shadow-[0_-8px_40px_rgb(0_0_0/0.5)] backdrop-blur-lg"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={TRANSITIONS.ui}
        >
          <header className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-[15px] tracking-wide text-brass-300">
              {title}
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[11px] font-semibold text-bone-400 hover:text-bone-50"
            >
              Close
            </button>
          </header>
          {children}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

/* ============================================================
   Rung 6 — BlockingDialog
   ============================================================ */

/**
 * The only rung that stops play, so it is the only one built on the
 * native <dialog> element: `showModal()` gives a real focus trap, Esc
 * handling, inert background and correct screen-reader semantics for
 * free — all things a hand-rolled overlay gets wrong.
 *
 * Reserve this for a decision the player must make before the game can
 * continue. Anything a bot did is a toast.
 */
export function BlockingDialog({
  open,
  title,
  onDismiss,
  children,
}: {
  open: boolean;
  title: string;
  /** Omit to make the dialog non-dismissible (a forced decision). */
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        if (!onDismiss) e.preventDefault();
        else onDismiss();
      }}
      className="m-auto w-[min(26rem,90vw)] rounded-2xl border border-brass-400/25 bg-linear-to-b from-felt-800 to-felt-900 p-5 text-bone-50 backdrop:bg-felt-950/70 backdrop:backdrop-blur-sm"
    >
      <h3 className="mb-1 font-display text-lg tracking-wide text-brass-300">
        {title}
      </h3>
      <span className="rule-brass mb-4 block" />
      {children}
    </dialog>
  );
}
