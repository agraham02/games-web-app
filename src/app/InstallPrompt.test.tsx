// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { captureInstallPrompt, INSTALL_PROMPT_KEY } from "./installCapture";
import { DISMISSED_KEY, InstallPrompt, QUIET_FOR_MS, type BeforeInstallPromptEvent } from "./InstallPrompt";

/**
 * The home page's install prompt, with the inline capture script that feeds
 * it running for real: the two halves share a key and an event name, and a
 * test of either alone would pass while they drifted apart.
 */

const IPHONE_SAFARI_26 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1";

const realUserAgent = navigator.userAgent;

function asBrowser(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
}

/** What Chromium fires when it would install the site. */
function offerFromBrowser(outcome: "accepted" | "dismissed" = "accepted") {
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome, platform: "web" }),
  }) as BeforeInstallPromptEvent & { prompt: ReturnType<typeof vi.fn> };
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("the install prompt", () => {
  beforeAll(() => {
    captureInstallPrompt();
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY] = null;
    window.localStorage.clear();
    asBrowser(realUserAgent);
    vi.unstubAllGlobals();
  });

  it("offers Install when the browser can install, and hands the question back to it", async () => {
    render(<InstallPrompt />);
    expect(screen.queryByText("Install Table Games")).toBeNull();

    const event = offerFromBrowser();
    // Ours to show: the browser's own mini-bar is held back.
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));

    expect(event.prompt).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText("Install Table Games")).toBeNull());
  });

  it("catches an offer made before the page was drawn", async () => {
    // The whole reason for the inline script: the event can come first.
    offerFromBrowser();
    render(<InstallPrompt />);
    expect(await screen.findByText("Install Table Games")).toBeTruthy();
  });

  it("gives iPhone users the steps instead, since nothing can start it for them", async () => {
    asBrowser(IPHONE_SAFARI_26);
    render(<InstallPrompt />);
    expect(screen.queryByText("Add Table Games to your Home Screen")).toBeNull();
    expect(await screen.findByText("Add Table Games to your Home Screen", {}, { timeout: 3000 })).toBeTruthy();
    // Safari 26 keeps Share behind the ••• button.
    expect(screen.getByText("•••")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("points other iPhone browsers straight at Share", async () => {
    asBrowser(IPHONE_CHROME);
    render(<InstallPrompt />);
    expect(await screen.findByText("Add Table Games to your Home Screen", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText("•••")).toBeNull();
    expect(screen.getByLabelText("Share")).toBeTruthy();
  });

  it("says nothing inside the installed app", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(display-mode: standalone)" }));
    render(<InstallPrompt />);
    offerFromBrowser();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Install Table Games")).toBeNull();
  });

  it("stays away for a month once turned down, then asks again", async () => {
    const { unmount } = render(<InstallPrompt />);
    offerFromBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByText("Install Table Games")).toBeNull());
    unmount();

    // Another visit, the offer made again: still quiet.
    render(<InstallPrompt />);
    offerFromBrowser();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Install Table Games")).toBeNull();

    // A month on, it may ask once more.
    window.localStorage.setItem(DISMISSED_KEY, String(Date.now() - QUIET_FOR_MS - 1000));
    offerFromBrowser();
    expect(await screen.findByText("Install Table Games")).toBeTruthy();
  });

  it("stays quiet after the browser's own dialog is declined", async () => {
    render(<InstallPrompt />);
    offerFromBrowser("dismissed");
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(window.localStorage.getItem(DISMISSED_KEY)).not.toBeNull());
  });
});
