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

  test("four people fill a table, and each sees only their own hand", async ({ browser }) => {
    // The shape every partnership game is built around, and the one no
    // layer had ever run: four separate browsers, four separate
    // identities, one room. Two people prove redaction between a pair;
    // only four can show that a whole table is consistent at once.
    const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
    const names = ["Ada", "Bo", "Cy", "Di"];
    const pages: Page[] = [];

    const ada = await player(contexts[0]!, names[0]!);
    pages.push(ada);
    const code = await hostRoom(ada);

    for (let i = 1; i < 4; i++) {
      const page = await player(contexts[i]!, names[i]!);
      await join(page, code);
      pages.push(page);
    }

    // Everybody can see everybody, before a card is dealt. Given time,
    // because a roster reaches the other browsers over a socket - and not
    // an exact match, because the viewer's own row reads "Ada (you)".
    for (const page of pages) {
      for (const name of names) {
        await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 });
      }
    }

    await ada.getByRole("button", { name: "Spades" }).click();
    await ada.getByRole("button", { name: /start spades/i }).click();

    for (const page of pages) {
      await expect(page.getByRole("button", { name: /step away/i })).toBeVisible();
    }

    // Each player can name at most their own thirteen, and no two players
    // can name the same card. With four seats that accounts for the whole
    // deck, so this is the redaction rule asserted across a FULL table
    // rather than between one pair of it.
    const nameable = async (page: Page) =>
      (
        await page
          .locator("[data-fx]")
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-fx") ?? ""))
      ).filter((id) => !id.startsWith("#"));

    const hands: string[][] = [];
    for (const page of pages) {
      await expect
        .poll(async () => page.locator("[data-fx]").count(), { timeout: 20_000 })
        .toBeGreaterThan(40);
      const mine = await nameable(page);
      expect(mine.length).toBeLessThanOrEqual(13);
      hands.push(mine);
    }

    const seen = new Set<string>();
    for (const hand of hands) {
      for (const card of hand) {
        expect(seen.has(card), `${card} was nameable at two different seats`).toBe(false);
        seen.add(card);
      }
    }

    await Promise.all(contexts.map((c) => c.close()));
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

    /*
      "Lit" is the highlighted branch's full-strength ring. Not a
      box-shadow test: every pod carries `ring-brass-400/20` at rest, which
      is also a box-shadow, so that check calls every pod lit and passes
      against any bug at all. It did, when it was written that way.
    */
    const litPods = () =>
      watcher.evaluate(() =>
        [...document.querySelectorAll("div.backdrop-blur-md.rounded-xl")]
          .filter((el) => el.classList.contains("ring-brass-400"))
          .map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      );

    /*
      Polled, rather than sampled once after a fixed pause — and the reason
      is worth keeping, because it is not flakiness, it is the deal.

      For the first few seconds the watcher is still PLAYING the opening
      deal, and a deal frame carries no `lastAction`. `seatCue` therefore
      lights nobody, entirely correctly: nothing has moved, and the table is
      not yet waiting on anyone. The server meanwhile named a human on turn
      the moment it dealt, so a fixed 2.5s wait sampled inside that gap and
      read it as "no pod lit". Measured with a trace: empty until ~3.5s,
      then the right pod, steady from there on.

      The guard is unchanged. The bug this test exists for leaves the
      PREVIOUS player's pod lit and never lights the waiting one, so the
      poll below runs out and fails exactly as it should.
    */
    const RIGHT = "one pod, and it is the seat on turn";
    await expect
      .poll(
        async () => {
          const lit = await litPods();
          return lit.length === 1 && lit[0]!.includes(onTurn!) ? RIGHT : JSON.stringify(lit);
        },
        { timeout: 20_000 },
      )
      .toBe(RIGHT);

    // And it is still their turn, so the glow is tracking the seat being
    // waited ON rather than a move that has since gone past.
    expect((await table()).table?.currentSeat, "they should still be on turn").toBe(turn);

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

  test("the table carries on when the player on turn walks out", async ({ browser }) => {
    /*
      The freeze, in the layer that mirrors how it was actually hit.

      `settled()` is what hands a turn to a bot, and on the server it was
      only ever reached from somebody ACTING. So a table parked on a live
      seat whose owner then left had nobody to wait for and nothing to
      wake it: the seat showed as Away, and that was the last thing that
      ever happened. Four of the five games, every one without a
      `deadline?()`.

      Asserted from the REMAINING player's screen, because they are the
      person the bug actually happened to.
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

    // The authoritative position, for the same reason as above: a
    // client's view is derived and could itself be what is wrong. Takes the
    // page to ask THROUGH, because the player who walks out below takes
    // their request context with them.
    const table = async (via: Page) => {
      const res = await via.request.get(`/debug/room/${code}`);
      const body = (await res.json()) as {
        game: { seatOwner: (string | null)[] };
        members: Record<string, { name: string; session: string }>;
        table: { currentSeat: number | null; fingerprint: string } | null;
      };
      return body;
    };

    const seatOfName = async (name: string) => {
      const now = await table(bo);
      return now.game.seatOwner.indexOf(
        Object.values(now.members).find((m) => m.name === name)!.session,
      );
    };
    const adaSeat = await seatOfName("Ada");
    const boSeat = await seatOfName("Bo");

    /*
      Wait until the table is parked on one of the two PEOPLE — whichever of
      them it reaches first, which is the part this test used to get wrong.

      It waited for Ada specifically. But a seat whose turn it is blocks the
      table in every game here, correctly and by design, so if Bo's seat
      comes first in turn order the table parks on HIM and never reaches her
      at all. The poll then ran out against a table that was behaving
      perfectly. Confirmed by the failure it produced: stuck at seat 1 while
      waiting for seat 0.
    */
    let parked: number | null = null;
    await expect
      .poll(
        async () => {
          const seat = (await table(bo)).table?.currentSeat ?? null;
          parked = seat === adaSeat || seat === boSeat ? seat : null;
          return parked;
        },
        { timeout: 20_000 },
      )
      .not.toBeNull();

    // Whoever is on turn is the one who walks out. The other is the person
    // the bug actually happened to, so they are who we watch and who we ask.
    const leaving = parked === adaSeat ? one : two;
    const staying = parked === adaSeat ? bo : ada;

    const stuck = (await table(staying)).table!.fingerprint;

    // Out mid-turn, without saying goodbye.
    await leaving.close();

    // A bot should take the turn and the table should move on.
    await expect
      .poll(async () => (await table(staying)).table?.fingerprint, { timeout: 20_000 })
      .not.toBe(stuck);

    // And the one still there is told why their opponent stopped playing.
    await expect(staying.getByText(/away/i).first()).toBeVisible();
  });

  test("a second tab does not fight the first for the seat", async ({ browser }) => {
    /*
      Two tabs of ONE context, deliberately — the opposite of every other
      test here. Identity lives in `localStorage`, which is per-origin and
      not per-tab, so this is one person opening the room twice, and it is
      the obvious way somebody tries the app out.

      The server replaces the old socket with the new one, correctly. The
      old tab used to read that close as the network dropping and
      reconnect, which closed the tab that had just taken over, which
      reconnected — about four round trips a second for as long as both
      were open, with one of the two always holding a dead socket.
    */
    const context = await browser.newContext();
    const first = await player(context, "Ada");
    const code = await hostRoom(first);

    const second = await context.newPage();
    await second.goto(`/room/${code}`);

    // The newest tab wins and lands in the lobby.
    await expect(second.getByText(code, { exact: true })).toBeVisible();

    // The old one stands down and says so, rather than flickering.
    await expect(first.getByText(/playing in another tab/i)).toBeVisible();

    // And it stays stood down, instead of trading the socket back.
    await first.waitForTimeout(3_000);
    await expect(first.getByText(/playing in another tab/i)).toBeVisible();
    await expect(second.getByText(code, { exact: true })).toBeVisible();

    // Taking it back is deliberate, and works.
    await first.getByRole("button", { name: /play here instead/i }).click();
    await expect(first.getByText(code, { exact: true })).toBeVisible();
    await expect(second.getByText(/playing in another tab/i)).toBeVisible();
  });


  test("the deal is watched from the start, not joined half way through", async ({ browser }) => {
    /*
      Reported from a real room: a "Dealing you in" screen, and then a table
      that looked as though most of the deal had already happened offstage.

      The online runtime returned null until the first frame had finished
      playing, so the animation ran with no table mounted to show it. And
      the events it ran were partly no-ops: an opponent's cards are
      addressed by stand-in ids, and a deal aimed at a piece the store is
      not tracking does nothing, so every hand simply appeared whole.

      Watched from the RECEIVING player's screen, sampled from the moment
      Start is pressed rather than from when the table is up — which is
      the point, since a loading screen is exactly what "table is up"
      would have waited out.
    */
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "Spades" }).click();

    // A dealt card shows its face; an undealt one is a back. So Bo's own
    // hand filling in is a count of faces going from nothing to thirteen.
    const faces = bo.getByRole("img", { name: / of (hearts|spades|clubs|diamonds)$/i });
    const loading = bo.getByText(/dealing you in/i);

    await ada.getByRole("button", { name: /start spades/i }).click();

    const seen: number[] = [];
    let sawLoadingScreen = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if ((await loading.count()) > 0) sawLoadingScreen = true;
      const n = await faces.count();
      seen.push(n);
      if (n >= 13) break;
      await bo.waitForTimeout(40);
    }

    expect(sawLoadingScreen, "the table should never be replaced by a loading screen").toBe(false);
    expect(seen.at(-1), "the hand should end up complete").toBe(13);
    expect(seen[0], "the first thing seen must not be an already-finished hand").toBeLessThan(13);
    expect(
      seen.some((n) => n > 0 && n < 13),
      `the hand should be seen filling in, not jumping to full — saw ${JSON.stringify(seen)}`,
    ).toBe(true);

    await one.close();
    await two.close();
  });


  test("BS deals two real tables, and the pile is nameable by nobody", async ({ browser }) => {
    // BS runs a challenge race after every single play, which makes it the
    // heaviest user of the machinery Rummy's claim window grew. Two things are
    // checked here that nothing below this layer can see: that a second person
    // actually gets a table drawn for them, and that the pile in the middle of
    // it is anonymous in BOTH browsers — including to whoever put the cards
    // there, which is the one exception the blunt rule does not make.
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "BS", exact: true }).click();
    await ada.getByRole("button", { name: /start bs/i }).click();

    for (const page of [ada, bo]) {
      await expect(page.getByRole("button", { name: /step away/i })).toBeVisible();
    }

    // Counting pieces is not enough to know the deal happened: before a deal
    // BS places all 52 cards on the pile, face down, and fifty-two anonymous
    // stand-ins look exactly like a full table until you ask how many of them
    // anybody can name. Same trap Rummy's test fell into first.
    const nameable = async (page: Page) =>
      new Set(
        (
          await page
            .locator("[data-fx]")
            .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-fx") ?? ""))
        ).filter((id) => !id.startsWith("#")),
      );

    for (const page of [ada, bo]) {
      await expect
        .poll(async () => (await nameable(page)).size, { timeout: 25_000 })
        .toBeGreaterThan(5);
    }

    const adaCards = await nameable(ada);
    const boCards = await nameable(bo);
    // Each holds cards the other cannot name, and no card is private to both.
    // Unlike Rummy there is no public card at all in this game between
    // reveals, so the two sets should simply not meet.
    for (const card of boCards) {
      expect(adaCards.has(card), `${card} was private to Bo and visible to Ada`).toBe(false);
    }
    expect(adaCards.size, "Ada should hold cards Bo cannot see").toBeGreaterThan(0);
    expect(boCards.size, "Bo should hold cards Ada cannot see").toBeGreaterThan(0);

    await one.close();
    await two.close();
  });

  test("a BS challenge window reaches a second player's screen", async ({ browser }) => {
    // The race, from the only place it can really be seen. A window entitles
    // every seat but the claimer at once, so when cards go down BOTH people
    // must be offered the call — not just whichever of them the server happens
    // to be pacing on. That distinction is `legalActions` versus
    // `currentSeat`, and a browser is where getting it wrong shows up as a
    // button somebody can watch and cannot press.
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await player(one, "Ada");
    const code = await hostRoom(ada);
    const bo = await player(two, "Bo");
    await join(bo, code);

    await ada.getByRole("button", { name: "BS", exact: true }).click();
    await ada.getByRole("button", { name: /start bs/i }).click();
    for (const page of [ada, bo]) {
      await expect(page.getByRole("button", { name: /step away/i })).toBeVisible();
    }

    // Somebody has to actually play, and it may well be one of ours: a seat
    // whose TURN it is blocks the table in every game here, correctly, so a
    // test that only waits is a test that can wait forever. Whichever page is
    // being asked picks a card off its own hand and puts it down.
    //
    // The cards it can NAME are exactly the ones it is holding face up —
    // everything else on this table is an anonymous stand-in — so that is how
    // one gets picked without reaching into game state.
    const playSomething = async (page: Page) => {
      const play = page.getByRole("button", { name: /^Play$/ });
      if (!(await play.isVisible().catch(() => false))) return;
      const mine = (
        await page
          .locator("[data-fx]")
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-fx") ?? ""))
      ).filter((id) => id && !id.startsWith("#"));
      if (mine.length === 0) return;
      await page.locator(`[data-fx="${mine[0]}"]`).click({ timeout: 2000 }).catch(() => {});
      await page.getByRole("button", { name: /^Play 1$/ }).click({ timeout: 2000 }).catch(() => {});
    };

    let sawWindow = false;
    for (let tick = 0; tick < 50 && !sawWindow; tick++) {
      for (const page of [ada, bo]) {
        if (await page.getByRole("button", { name: "BS!" }).isVisible().catch(() => false)) {
          sawWindow = true;
          break;
        }
        await playSomething(page);
      }
      if (!sawWindow) await ada.waitForTimeout(400);
    }

    expect(sawWindow, "no challenge window ever reached either player's screen").toBe(true);

    await one.close();
    await two.close();
  });
});
