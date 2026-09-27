"use client";

/**
 * The home page's invitation to install the site as an app: full screen,
 * one tap from the home screen, no browser bars around the table.
 *
 * Two ways in, because the platforms disagree:
 *
 * - **Chromium** (Android, Chrome and Edge on a desktop) can install on
 *   request. It says so by firing `beforeinstallprompt`, which
 *   `installCapture.ts` keeps from before React loads; the Install button
 *   hands it back to the browser, which asks its own question.
 * - **iOS and iPadOS** never let a page start that. They get the steps
 *   instead: Share, then Add to Home Screen (behind ••• in Safari 26).
 *
 * Anything else sees nothing; nor does the app once it is installed.
 * Dismissed, it stays away for a month (`QUIET_FOR_MS`): installing costs
 * room on a phone, so declining is a real choice, and asking every visit
 * would be nagging.
 *
 * Stuck to the bottom of the page's scroll box rather than laid over it: it
 * is the last thing on the page, so scrolled to the end nothing is under
 * it, and on a phone the room form stays in the first screen above it.
 */

import { AnimatePresence, motion } from "motion/react";
import { Share, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useState, useSyncExternalStore } from "react";
import { TRANSITIONS } from "@/motion/presets";
import { Button } from "@/ui/primitives/Button";
import { INSTALL_PROMPT_KEY, INSTALL_READY_EVENT } from "./installCapture";

/** Chromium's event; not in TypeScript's DOM types. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export const DISMISSED_KEY = "table-games.install-dismissed";
/** How long a "not now" lasts. */
export const QUIET_FOR_MS = 30 * 24 * 60 * 60 * 1000;
/** iOS has no event to wait for; a beat after the page lands, not with it. */
export const IOS_DELAY_MS = 1200;

type Offer = "button" | "ios" | null;

function heldEvent(): BeforeInstallPromptEvent | null {
  const held = (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY];
  return (held as BeforeInstallPromptEvent | null | undefined) ?? null;
}

function subscribeHeld(onChange: () => void): () => void {
  window.addEventListener(INSTALL_READY_EVENT, onChange);
  window.addEventListener("appinstalled", onChange);
  return () => {
    window.removeEventListener(INSTALL_READY_EVENT, onChange);
    window.removeEventListener("appinstalled", onChange);
  };
}

const onClient = () => () => {};

/** Already running as an installed app, on any platform. */
function isInstalled(): boolean {
  const app = ["standalone", "fullscreen", "minimal-ui"].some(
    (mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches,
  );
  return app || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone, iPod, or an iPad (which asks for desktop pages as a Mac). */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * Safari 26 moved Share behind the ••• button. Other iOS browsers keep it
 * in view (Chrome's is in the address bar), as Safari did before 26.
 */
function shareIsBehindMenu(): boolean {
  const ua = navigator.userAgent;
  if (/CriOS|FxiOS|EdgiOS/.test(ua)) return false;
  const version = /Version\/(\d+)/.exec(ua);
  return version !== null && Number(version[1]) >= 26;
}

function recentlyDismissed(): boolean {
  try {
    const at = Number(window.localStorage.getItem(DISMISSED_KEY));
    return at > 0 && Date.now() - at < QUIET_FOR_MS;
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    /* Not kept past this page; it is still gone for now. */
  }
}

export function InstallPrompt() {
  // `false` on the server and through hydration, then `true`: everything
  // below reads the browser, which the server does not have.
  const client = useSyncExternalStore(onClient, () => true, () => false);
  const held = useSyncExternalStore(subscribeHeld, heldEvent, () => null);
  const [iosReady, setIosReady] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!isIOS()) return;
    const timer = window.setTimeout(() => setIosReady(true), IOS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const offer: Offer =
    !client || closed || isInstalled() || recentlyDismissed()
      ? null
      : held
        ? "button"
        : iosReady && isIOS()
          ? "ios"
          : null;

  const dismiss = () => {
    rememberDismissal();
    setClosed(true);
  };

  const install = async () => {
    if (!held) return;
    setClosed(true);
    // The browser's own dialog takes it from here. The event is good for
    // one prompt only, so it is dropped whatever the answer.
    await held.prompt();
    const { outcome } = await held.userChoice;
    (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY] = null;
    if (outcome === "dismissed") rememberDismissal();
  };

  return (
    <AnimatePresence>
      {offer ? (
        <motion.aside
          key="install"
          aria-label="Install Table Games"
          className="sticky bottom-0 z-10 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0, transition: TRANSITIONS.uiEnter }}
          exit={{ opacity: 0, y: 16, transition: TRANSITIONS.uiExit }}
        >
          <div className="mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-felt-900/95 p-3 shadow-e2 ring-1 ring-brass-500/40 backdrop-blur-md">
            <Image src="/icons/icon-192.png" alt="" width={44} height={44} className="shrink-0 rounded-xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm leading-tight font-extrabold text-bone-50">
                {offer === "ios" ? "Add Table Games to your Home Screen" : "Install Table Games"}
              </span>
              <span className="text-xs leading-snug text-bone-400">
                {offer === "ios" ? (
                  shareIsBehindMenu() ? (
                    <>
                      Tap <b className="text-bone-200">•••</b>, then <b className="text-bone-200">Share</b>, then{" "}
                      <b className="text-bone-200">Add to Home Screen</b>.
                    </>
                  ) : (
                    <>
                      Tap <Share size={12} aria-label="Share" className="inline align-[-1px] text-bone-200" />{" "}
                      <b className="text-bone-200">Share</b>, then <b className="text-bone-200">Add to Home Screen</b>.
                    </>
                  )
                ) : (
                  "Full screen, one tap from your home screen."
                )}
              </span>
            </div>
            {offer === "button" ? (
              <Button tone="primary" size="sm" onClick={() => void install()}>
                Install
              </Button>
            ) : null}
            <button
              type="button"
              onClick={dismiss}
              aria-label="Not now"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-bone-400 ring-1 ring-bone-50/14 hover:bg-bone-50/8 hover:text-bone-50"
            >
              <X size={16} />
            </button>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
