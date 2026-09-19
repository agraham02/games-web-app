import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Several real browsers, one real server.
 *
 * The spec asks for this layer specifically, and the reason is worth
 * restating: every other test in this repo can pass while the thing is
 * unusable. The engine tests are pure. The ws harness talks to the server
 * with no UI in front of it. The jsdom tests render the room against a
 * fake socket. None of them can tell whether four people actually see a
 * coherent table.
 *
 * Each player is a separate browser CONTEXT, not a separate tab: identity
 * lives in `localStorage`, so two tabs of one context are one person, and
 * the whole point here is that they are not.
 */

/** A player: their own storage, their own socket, their own seat. */
async function player(context: BrowserContext, name: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/room");
  await page.getByLabel(/your name/i).fill(name);
  return page;
}

async function hostRoom(page: Page): Promise<string> {
  await page.getByRole("button", { name: /make a room/i }).click();
  // The lobby shows the code in display type; it is also the URL.
  await expect(page).toHaveURL(/\/room\/[A-Z]{4}$/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

async function join(page: Page, code: string): Promise<void> {
  await page.getByLabel(/room code/i).fill(code);
  await page.getByRole("button", { name: /join room/i }).click();
  await expect(page.getByText(code, { exact: true })).toBeVisible();
}

test.describe("a room, in real browsers", () => {
  test("two people meet in a lobby and both see the roster", async ({ browser }) => {
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);

    const bo = await player(two, "Bo");
    await join(bo, code);

    // Each sees both names — the roster is broadcast, not local.
    //
    // `exact` matters more than it looks: a name shows up three times on
    // this screen — as a roster row, as the two-letter avatar, and inside
    // the "Bo joined" toast. That the toast exists at all is the announce
    // composition working end to end, which nothing else here observes.
    for (const page of [ada, bo]) {
      // Scoped to the roster: a sonner toast is also an <li>, so "Bo"
      // matches both the row and the "Bo joined" notice otherwise.
      const roster = page.getByRole("list", { name: "Room members" });
      await expect(roster.getByRole("listitem").filter({ hasText: "Ada" })).toBeVisible();
      await expect(roster.getByRole("listitem").filter({ hasText: "Bo" })).toBeVisible();
    }
    // And only the host is offered the controls.
    await expect(ada.getByRole("button", { name: /leave room/i })).toBeEnabled();
    await expect(bo.getByRole("button", { name: /anyone with the code/i })).toBeDisabled();

    await one.close();
    await two.close();
  });

  test("one person on their own is sent to the solo table instead", async ({ browser }) => {
    // A room game with a single human is the offline game plus a round
    // trip per bot turn. The server refuses it; what this checks is the
    // half a server cannot — that the screen SAYS so, and offers the
    // thing it is steering them towards rather than just going dead.
    const one = await browser.newContext();
    const ada = await player(one, "Ada");
    await hostRoom(ada);

    await ada.getByRole("button", { name: "Dominoes" }).click();
    await expect(ada.getByRole("button", { name: /start dominoes/i })).toBeDisabled();
    await expect(ada.getByText(/needs 2 people/i)).toBeVisible();
    await expect(ada.getByRole("link", { name: /play dominoes solo/i })).toHaveAttribute(
      "href",
      "/play/dominoes",
    );

    await one.close();
  });

  test("a started game deals both players a table, and neither sees the other's hand", async ({
    browser,
  }) => {
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "Spades" }).click();
    await ada.getByRole("button", { name: /start spades/i }).click();

    // Both land on a table rather than the lobby.
    for (const page of [ada, bo]) {
      await expect(page.getByRole("button", { name: /step away/i })).toBeVisible();
    }

    // The load-bearing assertion, and made against the real DOM rather
    // than the wire: every piece carries its id as `data-fx`, and a
    // concealed one is an anonymous stand-in (prefixed `#`). So the ids
    // this browser is actually holding are readable straight off the page.
    //
    // A Spades deal is 52 cards. One hand of thirteen should be nameable
    // and thirty-nine should not — which is the redaction, observed from
    // outside the process that performed it.
    for (const page of [ada, bo]) {
      await expect
        .poll(async () => page.locator("[data-fx]").count(), { timeout: 20_000 })
        .toBeGreaterThan(40);

      const ids = await page.locator("[data-fx]").evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-fx") ?? ""),
      );
      const named = ids.filter((id) => !id.startsWith("#"));
      const concealed = ids.filter((id) => id.startsWith("#"));

      expect(named.length).toBeLessThanOrEqual(13);
      expect(concealed.length).toBeGreaterThanOrEqual(39);
    }

    // And the two browsers can name disjoint sets of cards: nobody is
    // holding anybody else's hand.
    const nameable = async (page: Page) =>
      (await page.locator("[data-fx]").evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-fx") ?? ""),
      )).filter((id) => !id.startsWith("#"));
    const adaCards = new Set(await nameable(ada));
    for (const card of await nameable(bo)) {
      expect(adaCards.has(card)).toBe(false);
    }

    await one.close();
    await two.close();
  });

  test("stepping away hands the seat to a bot, and coming back reclaims it", async ({
    browser,
  }) => {
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "Spades" }).click();
    await ada.getByRole("button", { name: /start spades/i }).click();
    await expect(bo.getByRole("button", { name: /step away/i })).toBeVisible();

    // Nothing on Ada's table claims anybody has gone yet.
    const away = ada.locator('[aria-label*="stepped away"]');
    await expect(away).toHaveCount(0);

    await bo.getByRole("button", { name: /step away/i }).click();
    // Back in the lobby, with the game still running for everyone else.
    await expect(bo.getByRole("button", { name: /join the game/i })).toBeVisible();
    await expect(ada.getByRole("button", { name: /step away/i })).toBeVisible();

    /*
      And Ada's table says so — WITHOUT the game having to advance first.
      This is the assertion that found the real bug: `botSeats` rides on a
      frame, frames come from the game moving, and the table is very often
      parked on the person still sitting there. Bo's pod stayed looking
      exactly like Bo for as long as Ada declined to move, which is
      precisely as long as she was waiting to be told what was going on.

      Nothing below a real browser saw it: the server was right, the
      redaction was right, and every unit test asserted on a frame that in
      practice never arrived.
    */
    await expect(away).toHaveCount(1);
    await expect(ada.getByText("Away", { exact: true })).toBeVisible();

    await bo.getByRole("button", { name: /join the game/i }).click();
    await expect(bo.getByRole("button", { name: /step away/i })).toBeVisible();
    // And it clears again on the way back in, for the same reason.
    await expect(away).toHaveCount(0);

    await one.close();
    await two.close();
  });

  test("a refresh mid-game puts you back at the same table", async ({ browser }) => {
    // The whole of reconnection, from the outside: same context means the
    // same token in `localStorage`, and the server recognises it.
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "Spades" }).click();
    await ada.getByRole("button", { name: /start spades/i }).click();
    await expect(bo.getByRole("button", { name: /step away/i })).toBeVisible();

    await bo.reload();

    // Straight back to the table, without re-entering a code or a name.
    await expect(bo.getByRole("button", { name: /step away/i })).toBeVisible();
    await expect(bo).toHaveURL(new RegExp(`/room/${code}$`));

    await one.close();
    await two.close();
  });

  test("the leader can end the game and everyone returns to the lobby", async ({ browser }) => {
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "Spades" }).click();
    await ada.getByRole("button", { name: /start spades/i }).click();
    await expect(bo.getByRole("button", { name: /step away/i })).toBeVisible();

    await ada.getByRole("button", { name: /^end game$/i }).click();

    for (const page of [ada, bo]) {
      await expect(page.getByRole("button", { name: /start spades/i })).toBeVisible();
    }

    await one.close();
    await two.close();
  });


  test("Rummy deals both players a real table, and the dealer is asked", async ({ browser }) => {
    // Rummy was the last game to go online and the only one that needed
    // its RULES changed to get there, so it gets a browser test of its
    // own. Two things are checked that nothing below this layer can see:
    // that a second person actually gets a table drawn for them, and that
    // the hand they are holding is their own.
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "Rummy 500" }).click();
    await ada.getByRole("button", { name: /start rummy 500/i }).click();

    for (const page of [ada, bo]) {
      await expect(page.getByRole("button", { name: /step away/i })).toBeVisible();
    }

    // Whoever is dealing is asked for a hand size, and that is a real
    // turn now whoever holds it — a bot dealer answers on its own, a
    // human dealer is offered the stepper. Which of the four it is comes
    // from a genuine random cut, so this waits for a Deal button to
    // appear on EITHER page and presses it, or for neither to need one.
    //
    // Counting pieces is not enough to know the deal happened, and that
    // is the trap this test fell into first: before a deal Rummy places
    // all 52 cards in the stock, face down. Fifty-two anonymous
    // stand-ins look exactly like a full table until you ask how many of
    // them anybody can name.
    const dealt = async (page: Page) =>
      (
        await page
          .locator("[data-fx]")
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-fx") ?? ""))
      ).some((id) => !id.startsWith("#"));

    for (let tick = 0; tick < 40; tick++) {
      if (await dealt(ada)) break;
      for (const page of [ada, bo]) {
        const deal = page.getByRole("button", { name: /^Deal$/ });
        if (await deal.isVisible().catch(() => false)) await deal.click();
      }
      await ada.waitForTimeout(500);
    }

    for (const page of [ada, bo]) {
      await expect
        .poll(async () => page.locator("[data-fx]").count(), { timeout: 25_000 })
        .toBeGreaterThan(20);
    }

    // And the redaction holds, read straight off the DOM: a concealed
    // piece renders as an anonymous stand-in, so the ids each browser can
    // actually name are the cards it is entitled to.
    //
    // Disjointness is the WRONG assertion here, unlike in Spades where a
    // hand is the only thing face up. Rummy has real public cards — the
    // top of the discard, and every meld on the board — and both players
    // are supposed to be able to name those. Asserting no overlap failed
    // on the upcard, correctly.
    //
    // What must hold is that each player has cards of their own that the
    // other cannot name, and that no card is private to both.
    const nameable = async (page: Page) =>
      new Set(
        (
          await page
            .locator("[data-fx]")
            .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-fx") ?? ""))
        ).filter((id) => !id.startsWith("#")),
      );

    const adaCards = await nameable(ada);
    const boCards = await nameable(bo);
    const onlyAda = [...adaCards].filter((id) => !boCards.has(id));
    const onlyBo = [...boCards].filter((id) => !adaCards.has(id));

    expect(onlyAda.length, "Ada should hold cards Bo cannot see").toBeGreaterThan(0);
    expect(onlyBo.length, "Bo should hold cards Ada cannot see").toBeGreaterThan(0);
    // The two private sets are disjoint by construction; this states it,
    // because the failure that matters is one hand appearing in both.
    for (const card of onlyBo) {
      expect(adaCards.has(card), `${card} was private to Bo and visible to Ada`).toBe(false);
    }

    await one.close();
    await two.close();
  });

  test("the pod that lights is the seat being waited on, not the last one to move", async ({
    browser,
  }) => {
    /*
      Reported from a real room: a player's turn indicator lagged. It moved
      to them when they drew or passed, but the turn had been theirs since
      the player before them finished.

      Every game lit its pods from `lastAction` — "who just moved" — which
      is a complete answer offline, where every seat with a pod is a bot
      and a bot's turn OPENS with a `think` event. A human emits nothing
      until they act, so the glow stayed on the previous player.

      Observed from the OTHER player's screen, because that is the only
      place it is visible: your own pod is never drawn.
    */
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "Dominoes" }).click();
    await ada.getByRole("button", { name: /start dominoes/i }).click();
    for (const page of [ada, bo]) {
      await expect(page.getByRole("button", { name: /step away/i })).toBeVisible();
    }

    // The authoritative answer to "whose turn is it", per the same
    // reasoning the ws harness uses: a client's view is derived and could
    // itself be the thing that is wrong.
    // Through the page's own request context rather than bare `fetch`, so
    // it follows `baseURL` — the e2e server is not on the port the dev
    // server uses, and a hardcoded one silently talks to whatever else is
    // listening there.
    const table = async () => {
      const res = await ada.request.get(`/debug/room/${code}`);
      return (await res.json()) as {
        game: { seatOwner: (string | null)[] };
        members: Record<string, { name: string; session: string }>;
        table: { currentSeat: number | null } | null;
      };
    };

    const first = await table();
    const seatOf = (name: string) =>
      first.game.seatOwner.indexOf(
        Object.values(first.members).find((m) => m.name === name)!.session,
      );
    const seats: Record<string, number> = { Ada: seatOf("Ada"), Bo: seatOf("Bo") };

    // Wait for the table to park on one of the two people. Nothing is
    // driven: bots play their own turns and then it is a person's move,
    // which is exactly the state being tested.
    let turn: number | null = null;
    let onTurn: "Ada" | "Bo" | null = null;
    await expect
      .poll(
        async () => {
          turn = (await table()).table?.currentSeat ?? null;
          onTurn = turn === seats.Ada ? "Ada" : turn === seats.Bo ? "Bo" : null;
          return onTurn;
        },
        { timeout: 30_000 },
      )
      .not.toBeNull();

    // Let the move that handed them the turn finish being shown: while it
    // is still playing, the mover's pod is correctly the lit one.
    const watcher = onTurn === "Ada" ? bo : ada;
    await watcher.waitForTimeout(2500);
    expect((await table()).table?.currentSeat, "they should still be on turn").toBe(turn);

    /*
      "Lit" is the highlighted branch's full-strength ring. Not a
      box-shadow test: every pod carries `ring-brass-400/20` at rest, which
      is also a box-shadow, so that check calls every pod lit and passes
      against any bug at all. It did, when it was written that way.
    */
    const lit = await watcher.evaluate(() =>
      [...document.querySelectorAll("div.backdrop-blur-md.rounded-xl")]
        .filter((el) => el.classList.contains("ring-brass-400"))
        .map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    );

    expect(lit, `exactly one pod should be lit, saw ${JSON.stringify(lit)}`).toHaveLength(1);
    expect(lit[0]).toContain(onTurn!);

    await one.close();
    await two.close();
  });

  test("a private room holds a newcomer until the leader lets them in", async ({ browser }) => {
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);

    await ada.getByRole("button", { name: /anyone with the code/i }).click();
    await expect(ada.getByRole("button", { name: /approval needed/i })).toBeVisible();

    const bo = await player(two, "Bo");
    await bo.getByLabel(/room code/i).fill(code);
    await bo.getByRole("button", { name: /join room/i }).click();

    await expect(bo.getByText(/waiting to be let in/i)).toBeVisible();
    await expect(ada.getByText(/asking to join/i)).toBeVisible();

    await ada.getByRole("button", { name: /let in/i }).click();
    // Admitted, and the lobby appears without them doing anything else.
    await expect(bo.getByText(code, { exact: true })).toBeVisible();

    await one.close();
    await two.close();
  });
});
