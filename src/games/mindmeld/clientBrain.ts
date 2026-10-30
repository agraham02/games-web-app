"use client";

/**
 * Loads Mind Meld's real brain in the browser, for a game played alone.
 *
 * Online the server runs every bot, so only the solo page needs it. It fetches
 * the two files the build script wrote (1.6 MB, cached by the browser for ever
 * once seen), installs the brain, and says when it is ready; until then the
 * small built-in brain stands in, which is why a slow or failed load costs a
 * worse partner and never a game.
 */

import { useEffect, useState } from "react";
import { installBrain } from "./brain";
import { vectorBrainFrom } from "./vectorBrain";

let loading: Promise<boolean> | null = null;

/** Fetches and installs the brain once per page; true if it arrived. */
export function loadClientBrain(): Promise<boolean> {
  loading ??= (async () => {
    try {
      const [vocab, vectors] = await Promise.all([
        fetch("/mindmeld/vocab-v1.json").then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))),
        fetch("/mindmeld/vectors-v1.bin").then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
      ]);
      installBrain(vectorBrainFrom(vocab, vectors));
      return true;
    } catch {
      return false;
    }
  })();
  return loading;
}

/** "idle" until asked, then "loading" and "ready" (or "failed", which plays on the stand-in). */
export function useBrain(): "loading" | "ready" | "failed" {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let live = true;
    void loadClientBrain().then((ok) => {
      if (live) setState(ok ? "ready" : "failed");
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}
