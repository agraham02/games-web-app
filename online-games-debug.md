# Online games — debugging log

Condensed record of bugs found while playtesting the online (room) versions
of the games, what caused them, and how they were fixed. Newest game last.
Read this before debugging an online table; CLAUDE.md holds the architecture
these notes refer to.

## Before you debug: rule out the environment

- **A stale dev server is the first suspect.** `npm run dev` is `tsx watch
  server.ts`. Two copies of it running (one in a forgotten terminal) fight
  over port 3000: on every server-file change one restart loses with
  "Another next dev server is already running", and the survivor keeps
  serving OLD server code to a NEW client. Symptoms look like real bugs (a
  trick card vanishing). Find them with
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` filtered on
  `tsx`/`server.ts`, stop them, run ONE `npm run dev`.
- **Git Bash mangles `taskkill /PID`** into a file path. Use
  `taskkill //PID <n> //F`, or PowerShell's `Stop-Process`.
- **A server restart drops every room.** Hard-refresh both windows and make
  a new room after one.
- **Two players = two origins or two profiles.** Two tabs on `localhost` are
  one identity (see CLAUDE.md, "A seat belongs to a person").
- **Check it is not a rule.** A Spades hand dealt face down to one player
  only is blind-bid eligibility (team trails by 100+), not a bug.

## Spades

### Opening deal played twice (online only, round 1 only)
- **Cause:** `useOnlineRuntime`'s frame effect queued whatever frame it was
  handed and had no cleanup; React StrictMode runs effects twice on mount,
  and the frame present at mount is the opening deal.
- **Fix:** remember the last frame taken (`received` ref) and skip it by
  identity.
- **Tests:** `useOnlineRuntime.test.tsx` "deals once under StrictMode";
  offline checked separately in `useGameRuntime.games.test.tsx` (it was
  fine).

### Last card of a trick blank / not animating; tricks never flew to the winner
- **Cause:** `projectEvents` (session/redact.ts) judged a piece's
  visibility only at the two ENDS of a batch. The 4th card goes hidden hand
  → trick → face-down won pile in one reduce, so it was concealed: other
  viewers got a stand-in drawn face up (a blank card face), and the mover's
  own card was renamed to a stand-in their store never held, so
  `applyEvent`'s `moveTo` silently did nothing. The three cards already on
  the trick (face up before, face down after) had the same fate on
  `collect`.
- **Fix:** `projectEvents` tracks what the viewer can identify DURING the
  batch — face up before it, or played face up in it — and forgets it all
  at a `shuffle`. `play` gained a required `faceUp` (BS plays face down; a
  default would have leaked it). The server ships meta for every piece a
  frame names (`piecesNamed`), or a card shown mid-batch has no face.
- **Tests:** redact.test.ts "every event aims at a piece the viewer's table
  is holding" (all games, whole matches; fails on the old code with the
  exact report); router.test.ts "sends the face of every card it plays face
  up".
- **Follow-up — a back lingered in the hand after the last card flew.** An
  `unmask` put the real card in the stand-in's slot but left the stand-in
  there for the batch's reconcile to drop. Invisible when the batch ends
  right after the play (cards 1–3); the last card's batch goes on through
  `HOLD.trick` and the collect, so the spare back sat in the hand for
  seconds. `unmask` now carries `replaces` (the stand-in's id, named by
  `projectEvents`) and `applyEvent` swaps the two in one write. Test:
  router.test.ts replays real frames through the store and checks the
  hand is one card shorter the moment a card leaves it.
- **Follow-up — the last card landed UNDER the rest of the trick.** z-index
  is `zone base + index`, and `reindex` bucketed trick cards by seat, so
  each was index 0 of its own bucket and all shared one z; stacking fell to
  DOM order. Cards 1–3 were reordered by the reconcile after their own
  play; the 4th is collected in the same batch and never was. `bucketKey`
  now treats the trick as one pile in play order (seat only sets the lean),
  which is also what Spades' own `placements` already said. Test:
  applyEvent.test.ts "the trick is one pile".
- **Follow-up — the collect never flew.** A batch goes idle when its last
  event is APPLIED, animations still running, and `settle` adopted the
  frame's board right then. Offline that is harmless (same ids). Online the
  settled board holds the won trick as face-down stand-ins, so the real
  cards were unmounted 20ms into a 580ms flight. `settle` now adopts the
  game state at once but defers the store `reset` by `tailMs(events)` (new,
  in choreographer.ts) when it would remove a piece the batch named; `pump`
  flushes a pending reset before the next batch touches the store. Test:
  useOnlineRuntime.test.tsx "a trick, online". Pre-existing since the
  collect started naming real cards — not caused by the trick-pile change,
  which was measured identical.
- **Side fix:** Spades' partner exchange used to flash the two passed cards
  face up to opponents — `play.faceUp` is now corrected per viewer while the
  card is still where the play put it.

### Trick overlapped the top seat's hand on a laptop screen
- **Cause:** the `trick` zone was centred on `play`, which clears the top
  POD but not the cards fanned below it. Fine on a tall desktop, colliding
  at laptop heights (and phone landscape).
- **Fix:** trick centred on and bounded by `pileRegion` (already clear of
  pods and hands); each card's offset toward its player is clamped to stay
  inside the trick box.
- **Tests:** layout.test.ts "trick — stays clear of every opponent's hand",
  including 1536×730 and 1366×650 laptop windows.

### Blind bidding was decided by whoever bid first
- **Was:** the team's first bidder chose look/blind for both partners, so a
  bot bidding first overrode its human partner.
- **Now:** a `blindVote` action open to BOTH partners at once when the
  team's first bid comes up (a multi-seat window, like Rummy's claim).
  People's votes are firm, bots' defer: one person with a bot decides alone;
  two people agreeing decide; two people disagreeing → coin hashed from the
  position (`hashString`, replays from the seed); two bots → the first
  bidder's vote. `completeAction` stamps the real seat and `defer: false` on
  every submitted vote, so a client cannot vote as a bot or as someone
  else. A bot that is not its team's first bidder draws no random number
  (its vote can never count), which keeps the seeded bot tests on their
  original sequence.
- **Tests:** rules.test.ts "the team votes on going blind".

### Blind Nil exchange cards leaked in the state
- **Cause:** `playerView` passed `exchange.given` through untouched, so
  opponents and spectators were sent the two cards a Blind Nil bidder
  passed to their partner. The events were already hidden; the state was
  not.
- **Found by:** the whole-match leak test, once the vote shifted the seeded
  game into an exchange.
- **Fix:** `playerView` masks `given` for anyone off the giver's team
  (spectator seat −1 checked explicitly).

## Dominoes (and BS)

### A re-dealt tile popped into its new hand instead of flying
- **Where:** round 2 onward. Tiles the viewer watched on the line (in BS, a
  revealed card) are swept, shuffled and dealt face down to an opponent.
- **Cause:** at the shuffle the viewer must lose track of them, so after
  it they were renamed to slot stand-ins — which their table never held,
  so the deal was a silent no-op and the tile appeared at the reconcile.
- **Fix:** a new `mask` event in front of the `shuffle`: "drop these real
  ids, add N stand-ins in that pile", deliberately UNPAIRED. The forgotten
  pieces then take stand-ins in the order the deal names them, so no event
  links a real id to a destination. `mask` blocks the queue 300ms so it
  cannot pull tiles out of the sweep still landing; the server ships
  face-down meta for the new stand-ins; and the online table's deferred
  board swap now counts stand-ins, so the last dealt tiles are not cut off
  mid-flight either.
- **Tests:** redact.test.ts no-op test now covers Dominoes and BS with the
  exemption removed (and asserts masks actually happen); "makes a shuffled
  pile anonymous without saying which stand-in is which" deals two tiles
  in both orders and gets identical events; router.test.ts "gives the
  stand-ins a re-deal hands out a face-down face" on a real Dominoes room.

## Left Right Center

### The roll and the chips it decides looked simultaneous (or rushed)
- **Cause:** two clocks. The chips waited behind a bare `pause` (300ms),
  while the dice overlay tumbled on its own timer (270ms) keyed off
  `lastAction` — which lands when a turn ARRIVES, so a bot's dice tumbled
  during its `think`, and a person's new dice first waited for the last
  roll's exit (`AnimatePresence mode="wait"`) while the chips already flew.
- **Fix:** a cosmetic `dice` event (the `slam` pattern) replaces the
  `pause` in front of a roll's moves. The choreographer blocks on it for
  `DURATION.diceTumble + DURATION.diceRead` (0.6s + 0.45s); applying it
  fires `emitDice` (fx.ts), and the overlay tumbles off that, with its
  tick count DERIVED from `diceTumble` so the two cannot drift. New dice
  mount over the old ones instead of waiting for them to leave. Obeys skip,
  speed and reduced motion; the server's bot pacing counts it via
  `playbackMs`.
- **Tests:** choreographer.test.ts "dice" (chips wait tumble + read);
  lrc/rules.test.ts (dice first, then moves); app/play/lrc/table.test.tsx
  (overlay tumbles at once and has settled by the end of the tumble).
- **Status:** confirmed by playtest in a browser, 2026-09-24. Spades and
  Dominoes likewise; the online pass continues with the remaining games.

## Poker

**Status:** confirmed by playtest, 2026-09-25.

### No deal animation on the first hand
- **Cause:** `setup` placed no cards at all, and `moveTo` does nothing to a
  piece the table is not tracking — so the first hand's hole cards had no
  pile to fly from and simply appeared, offline and online. Long listed as
  a known gap in CLAUDE.md.
- **Fix:** `setup` parks all 52 cards face down in the stub (`cardOwner`
  "deck"). The order is not the shuffle, and face-down cards reach clients
  only as stand-ins, so it tells nobody anything.
- **Tests:** Poker joined useOnlineRuntime.test.tsx's per-game opening-deal
  suite (fails on the old `setup`).

### Burn and board dealt all at once
- **Cause:** a street was burn → move → flip → move → flip…, every step
  with a zero gap, so the burn, the three flop cards and their flips all
  started in the same frame.
- **Fix:** `advanceStreet` puts a `pause` (which blocks the queue) after the
  burn and after each card lands and each flip: burn is seen, then the
  board comes one card at a time (a flop ~2.1s, turn/river ~0.9s). All-in
  runouts get the same pacing.
- **Tests:** poker rules.test.ts "dealing the board", timed with
  `gapAfter` — the clock the table really plays by.

### The betting panel was confusing
- **Was:** a big gold Bet/Raise button over small grey Fold/Check/Call, a
  slider for the amount, and no sign of the current bet or of what you had
  already put in — so "Call $50" after a raise to $100 read as "the bet is
  $50".
- **Now:** a strip showing **Current bet**, **Your bet** and the pot; one
  row of equal-weight buttons (Fold · Check/Call · Bet/Raise to); Call says
  "Call $50 · matches $100"; the amount is a −/+ `NumberStepper` stepping
  by the big blind (it gained a `format` prop for "$"), with ½ pot / Pot /
  All in as quick fills. "Raise to $X" is kept — it is the standard
  wording, and it matches "Current bet $X".
- **Follow-up — "Your bet $0" on the flop.** Correct, but unlabelled: it is
  THIS street's bet (each street starts at 0; earlier chips are in the
  pot). The figure now carries a "Total bet $X" subtitle for the hand.
  The call button's "matches $X" shows only when you already have chips
  in this round — otherwise it just repeats the call amount. The user is
  new to poker, and asked for the whole panel to be as unambiguous as
  possible: prefer saying one thing once, plainly.
- **Follow-up — pod text cut off.** "$4837 · bet $362" is wider than a
  96px pod, so the bet was truncated. `SeatView.meta` may now be a list of
  lines, and poker puts stack and bet on separate lines — the same height
  a Spades partner pod already has, so the layout needed no change.
- **Tests:** app/play/poker/table.test.tsx.

### Community row overlapped the top seats' cards on a laptop
- **Cause:** the same mistake as Spades' trick. Poker's centre chain
  (community → pot → stub/burn) was anchored to `play`, which clears the
  pods but not the cards fanned out of them. On laptop heights the row sat
  in the top seats' hole cards; on phones its ends reached the side
  seats'.
- **Fix:** the community box is bounded by `pileRegion` (top clamped below
  the top hands, width inside the side hands) and centred on it; the pot
  and stub follow from its bottom as before. The layout squeezes the gaps
  first, then shrinks the cards, when five do not fit.
- **Tests:** layout.test.ts "poker's centre — stays clear of every
  opponent's hand" (2–10 seats, phones and laptop sizes).
- **Layout work from here on is collected in `layout-ui-ux.md`** for one
  dedicated PR (user's request, 2026-09-25), including the audit of the
  other games' centre zones.

### Announcements named the wrong people online
- **Cause:** poker baked names into its announcement TEXT with a
  `seatLabel` helper — "You" for seat 0, a bot name for everyone else. The
  other games pass `actor` + `selfText` and let each viewer's screen name
  the mover. So online every player saw seat 0's moves as "You folds", and
  people were called by bot names; offline it read "You checks".
- **Fix:** every poker announcement carries `actor`/`selfText` (with the
  amounts: "calls $20"); `seatLabel` is gone. A split pot, which has no one
  actor, says "The pot is split".
- **Tests:** poker rules.test.ts "announcements" — across a whole bot
  match, no announcement names anybody in its text.

### The end-of-hand summary was misleading
- **Was:** it showed `result.deltas`, which is the PAYOUT (documented,
  wrongly, as net) — +50 to a winner who had put in 20, +0 to players who
  were down. A losing hand mucked at the showdown read "folded". Nothing
  said why the hand was won.
- **Fix:** `PokerHandResult` gained `net` (payout minus what the seat put
  in) and `showdownSeats`; `deltas` keeps its payout meaning (tests rely on
  it) with a corrected doc. The scorecard shows `net`, "lost" for a beaten
  hand, names hands the viewer can see ("won · Pair of 10s"), titles a
  showdown "You win with Pair of 10s", and explains a walkover in a note.
  `describeHand`/`describeBest` in hand.ts do the naming.
- **Tests:** poker table.test.tsx "the end-of-hand summary" (the net
  column sums to zero), hand.test.ts "describeHand / describeBest".

### "lost · Full house, Jacks and NaNs", and "Round 1" every hand
- **NaN:** poker's `playerView` does not DROP a hand a viewer may not see;
  it keeps it, owner and all, under placeholder ids (`??0`, `??1`). The
  summary checked only that a seat had two cards, parsed the placeholders,
  and named a hand from the board plus garbage. Now `isHiddenCard` (exported
  from poker rules) gates it: a mucked loser reads just "lost". Worth
  remembering for any code that reads another seat's cards off a view.
- **Round 1:** `extractRound` read only a `round` field and fell back to 1;
  poker's field is `hand`. So every hand was "Round 1", which also made a
  CORRECT +/- look wrong next to a stack that had moved in earlier hands
  (the user's screenshot: +40 on a stack of 2050 — right, after an earlier
  +10). It now reads `hand` too.
- The game itself scored the hand correctly throughout; both were display.
- **Tests:** poker table.test.tsx "the summary, read from a player's own
  view" (fails with "NaN" on the old code); session/structural.test.ts.

### A showdown win was not explained
- **Was:** at a showdown against players who mucked (bots always do), the
  summary said "You win with …" and "lost", and nothing else — and mucking
  made no announcement at all, so it read as though they had folded.
- **Now:** every showdown gets a "Why you won" / "Why Mia won" note —
  "Your Three Jacks beats Mia's Two pair…" for hands shown, and "Mia didn't
  show their cards. At the end, a player who can't win may keep them
  hidden — so theirs lost to yours." for hands kept hidden. Mucking
  announces "doesn't show — their hand lost" (only losers are ever offered
  a muck, so that is always true). Names, never guessed pronouns.
- **Tests:** poker table.test.tsx (the mucked-loser test checks the note;
  a visible loser gets "beats"), rules.test.ts announcements. Checked live.

### The betting panel covered the board
- At 1536×780 it sat over the flop. On wide screens it is now one ~96px
  row just above the hand. Clear at 1536×780; the tighter 1366×650 case is
  open in `layout-ui-ux.md`.

### In-game settings, and Hints (user's design, 2026-09-25)
- A SHARED mechanism, not a poker one: `src/table/gameSettings.tsx` (a
  `GameSetting` list, a per-device `useGameSettings` store on
  `useSyncExternalStore`, and `SettingsSheet`). A game opts in by passing
  `settings` to `GameHost`/`GameHostView`, which then shows a Settings
  button in a shared top-right row (online tables pass their Step away /
  End game through `corner` so the two share one row), and hands the
  values to the table content as `children(live, settings)`.
- Poker is the first user: `POKER_SETTINGS` = Hints, on by default.
  - Hints on: a line under each choice ("give up this hand", "match the
    bet to stay in"...), and the hero's badge spelled out ("Big blind").
  - Always on (user's call): "Your hand · Pair of 10s" in the panel and
    above the cards; the winning hand in the summary; "Total bet" only
    when it differs from this round's bet.
  - Always available: a "Table words" glossary in the Hands sheet.
- **Tests:** table/gameSettings.test.tsx; poker table.test.tsx "hints,
  and what is always shown". Checked live in a browser.

## Open gaps (known, not yet fixed)

- None known in the games playtested so far (Spades, Dominoes, LRC, Poker).
  Rummy and BS have not had their online playtest yet.
- The centre-zone audit in Poker's layout note above, deferred to the
  larger layout pass.


## Techniques that worked

- **Replay real server frames through the client store.** Drive a room
  in-process with `Router` + `RoomRegistry` + `TestClock` (router.test.ts
  shows how, including players choosing moves from their own frame's
  redacted state), then `learnMeta` → `applyEventToTable` per event →
  `reset` per frame, exactly as `useOnlineRuntime` does. Separates "the data
  is wrong" from "the drawing is wrong" in minutes.
- **jsdom cannot judge motion.** A rendered `SpadesOnline` in jsdom left the
  viewer's own trick cards at their hand position on old and new code
  alike, so Motion's animated values there are not evidence. Use it for
  "is the node there, with a face", and a real browser for where it ends
  up.
- **Compare against HEAD in a worktree** to tell a regression from a
  pre-existing behaviour. If you link `node_modules` into it with a
  junction, remove the junction with `cmd /c rmdir` BEFORE deleting the
  worktree; a recursive delete through a junction deletes the real
  `node_modules`.
- **Prove a new test against the old code** by swapping the one file back
  (`git show HEAD:path > path`), running it, and restoring.
- **Whole-match tests find what targeted ones cannot.** The exchange leak
  existed all along; only a changed random sequence walked into it.
