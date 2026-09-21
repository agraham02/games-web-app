import { expect, test, type Page } from "@playwright/test";

/**
 * The room, on a phone.
 *
 * This app is phone-first — the geometry has a `SHORT_VIEWPORT_H` branch,
 * the fans pan rather than shrink past a floor, and one game refuses to
 * lay out at all below a certain height and asks to be turned. None of
 * that had ever been opened in a browser at phone size: every existing
 * spec runs at Desktop Chrome's viewport, so the entire short-viewport
 * half of the layout was reachable only by hand.
 *
 * Deliberately a small file. The point is the VIEWPORT, so it covers the
 * paths whose behaviour actually changes with it and leaves the rest to
 * the desktop suite rather than running everything twice.
 */

async function player(page: Page, name: string): Promise<void> {
  await page.goto("/room");
  await page.getByLabel(/your name/i).fill(name);
}

test.describe("on a phone", () => {
  test("the entry screen fits, and the whole of it can be reached", async ({ page }) => {
    // `body` is `overflow: hidden` on both axes so the table can own its
    // pan gestures, which means a page taller than the viewport is simply
    // unreachable unless it brought its own scroll container. That is a
    // real bug this app has had before, and it only shows up when the
    // viewport is genuinely short.
    await player(page, "Ada");

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows, "the page scrolls sideways on a phone").toBe(false);

    // The control at the bottom of the flow is reachable, not cut off.
    const join = page.getByRole("button", { name: /join room/i });
    await join.scrollIntoViewIfNeeded();
    await expect(join).toBeVisible();
  });

  test("two people can still make and join a room", async ({ browser }) => {
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await one.newPage();
    const bo = await two.newPage();

    await player(ada, "Ada");
    await ada.getByRole("button", { name: /make a room/i }).click();
    await expect(ada).toHaveURL(/\/room\/[A-Z]{4}$/);
    const code = new URL(ada.url()).pathname.split("/").pop()!;

    await player(bo, "Bo");
    await bo.getByLabel(/room code/i).fill(code);
    await bo.getByRole("button", { name: /join room/i }).click();

    // Each sees the other, on a screen this size.
    await expect(bo.getByText(code, { exact: true })).toBeVisible();
    await expect(ada.getByText("Bo").first()).toBeVisible({ timeout: 15_000 });

    await one.close();
    await two.close();
  });

  test("Rummy asks to be turned rather than laying out badly", async ({ page }) => {
    // The deliberate decision recorded in the architecture notes: a
    // side-rail layout for Rummy was built, measured and scrapped, and a
    // rotate prompt kept instead. Nothing verified the prompt actually
    // appears, so the fallback for the one game that refuses to lay out
    // was itself untested.
    // Started at a normal phone size, because the prompt is an OVERLAY
    // over a running game rather than a branch of the setup screen - the
    // table keeps playing underneath so that turning the phone cannot
    // throw away somebody's score.
    await page.goto("/play/rummy");
    await page.getByRole("button", { name: /deal in/i }).click();

    // Now turn it sideways, where Rummy has no room to lay out.
    await page.setViewportSize({ width: 740, height: 360 });

    await expect(
      page.getByRole("heading", { name: /rotate your device|make the window taller/i }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
