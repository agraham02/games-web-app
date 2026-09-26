"use client";

/**
 * The rest of the disclosure ladder. See POLICY.md for which rung to
 * reach for — the short version is: pick the lowest one that works.
 */

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
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
 * Which edge a sheet slides in from — the edge its button sits on, so a
 * panel arrives from where it was asked for. A bottom sheet also rises
 * over the player's own hand, which a side drawer (on anything wider than
 * a phone) does not.
 */
export type SheetSide = "bottom" | "left" | "right";

/** Whole class strings, not built from parts: Tailwind reads source statically. */
const SHEET_PLACEMENT: Record<SheetSide, { className: string; hidden: { x?: string; y?: string } }> = {
  bottom: {
    className:
      "inset-x-0 bottom-0 max-h-[70%] rounded-t-sheet border-t shadow-[0_-8px_40px_rgb(0_0_0/0.5)]",
    hidden: { y: "100%" },
  },
  right: {
    className:
      "inset-y-0 right-0 w-[min(22rem,88vw)] rounded-l-sheet border-l shadow-[-8px_0_40px_rgb(0_0_0/0.5)]",
    hidden: { x: "100%" },
  },
  left: {
    className:
      "inset-y-0 left-0 w-[min(22rem,88vw)] rounded-r-sheet border-r shadow-[8px_0_40px_rgb(0_0_0/0.5)]",
    hidden: { x: "-100%" },
  },
};

/**
 * On-demand detail, as a drawer from the edge its button sits on.
 *
 * While it is open the rest of the screen dims, and tapping that dimmed
 * area — or the X, or Esc — closes it. It used to dim nothing, so the
 * table stayed readable behind it; the user asked for the dim instead,
 * because a drawer that leaves the table fully lit reads as a second
 * layer of table rather than as something you opened and can put away.
 * It still asks nothing of the player: there is no decision in it, only
 * reference, and one tap anywhere puts it away (POLICY.md, rung 5).
 */
export function InfoSheet({
  open,
  title,
  onClose,
  side = "bottom",
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** The edge it slides in from — put it on the side its button is on. */
  side?: SheetSide;
  children: React.ReactNode;
}) {
  const placement = SHEET_PLACEMENT[side];
  const shown = placement.hidden.x !== undefined ? { x: 0 } : { y: 0 };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="backdrop"
          aria-hidden
          data-testid="sheet-backdrop"
          className="absolute inset-0 z-2150 bg-felt-950/60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={TRANSITIONS.ui}
          onClick={onClose}
        />
      ) : null}
      {open ? (
        <motion.aside
          key="sheet"
          aria-label={title}
          className={`absolute z-2200 overflow-y-auto border-brass-400/30 bg-linear-to-b from-felt-800/95 to-felt-900 p-4 backdrop-blur-lg ${placement.className}`}
          initial={placement.hidden}
          animate={shown}
          exit={placement.hidden}
          transition={TRANSITIONS.ui}
        >
          <header className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-[15px] tracking-wide text-brass-300">
              {title}
            </h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full text-bone-400 ring-1 ring-bone-50/14 hover:bg-bone-50/8 hover:text-bone-50"
            >
              <X size={16} />
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
