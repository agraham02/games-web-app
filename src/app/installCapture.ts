/**
 * The half of the install prompt that has to run before React does.
 *
 * Chromium offers a site for installing by firing `beforeinstallprompt`,
 * once, whenever it decides to: often during page load. A listener added
 * in an effect can arrive after it, and the chance is gone until the next
 * visit. So this runs as an inline script in the root layout's `<head>`
 * (serialised with `toString()`, the way next-themes does it), keeps the
 * event where `InstallPrompt` can find it, and says it is there.
 *
 * It also registers the service worker (`public/sw.js`). Chromium only
 * fires the event for a site whose service worker handles fetches.
 *
 * SELF-CONTAINED on purpose: no imports, no outside names, no async. Only
 * this function's own source reaches the page.
 */
export function captureInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Ours to show, not the browser's own mini-bar.
    event.preventDefault();
    (window as unknown as { __installPrompt?: Event | null }).__installPrompt = event;
    window.dispatchEvent(new Event("installpromptready"));
  });
  window.addEventListener("appinstalled", () => {
    (window as unknown as { __installPrompt?: Event | null }).__installPrompt = null;
  });
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
        // No worker, no Install button; the site works exactly as before.
      });
    });
  }
}

/** Where `captureInstallPrompt` keeps the event, and what it fires. */
export const INSTALL_PROMPT_KEY = "__installPrompt";
export const INSTALL_READY_EVENT = "installpromptready";
