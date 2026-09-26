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
- **Follow-up — drawers, not bottom sheets.** Settings and Hands slide in
  from the right, the side their buttons are on, and dim the rest of the
  screen; tapping the dim, the X or Esc closes them. Built into the shared
  `InfoSheet` (`side` prop), and POLICY.md's rung 5 updated to match.

## Rummy 500

### Four aces could not be melded, and "Create meld" took them into the hand
- **Seen:** two aces taken off the discard pile with two more in hand;
  "Create meld" put all four in the hand instead of melding, and melding
  them from the hand was then refused as not allowed.
- **Cause:** one bug, both halves. The move check (`validate`) was
  `validateByEnumeration(legalActions)`, and Rummy's `legalActions` lists
  ONE meld per starting card — enough for a bot, nowhere near every valid
  meld. The pickup bar sends two moves (pickup, then meld); the pickup was
  on the list, four aces was not. Offline too: the session runs the same
  check. The same trap CLAUDE.md records for Poker and BS.
- **Fix:** Rummy's own `validate`: a new meld is checked by SHAPE (turn,
  phase, in hand, no duplicates, a real set or run, includes the pickup's
  owed card) — the same checks `reduceLayNewMeld` makes; everything else
  stays on the list, which is complete for those actions.
- **Tests:** rummy rules.test.ts "the move check accepts every valid meld"
  (fails with `illegal-action` on the old check).

### A bot won the "Rummy!" race while the ring still had time on it
- **Seen:** two people, two bots. The claimer pressed "Rummy!" inside the
  ring and the card went to a bot anyway. Another time the window "went by
  really fast", faster on one screen than the other.
- **Cause:** a bot's claim was made after the table's flat 900ms beat, and
  its reaction time (1.1–5.5s) was a `think` inside the claim's OWN frame,
  so it played on screen after the server had already given it the card.
  A press was only in time within about 900ms of the ring appearing,
  whatever the ring said. Offline had the same flaw, since the offline
  runtime uses the same session loop.
  Second cause, for two people: a person's ring was the soonest rival's
  reaction time, and the other PERSON counted as a rival, so a ring could
  be ~1s against somebody who was never going to arrive then.
- **Fix:**
  - Rummy's `turnHold` makes a bot wait out its reaction time BEFORE it
    claims (`claimHoldMs`), and the claim's `think` is now 0.
  - `claimDeadlineMs` takes `isBot`, so rings race bots only. The session
    passes `isLive` to `deadline?()` for this (a new optional argument),
    and the client passes `frame.botSeats` through `RummyView.isBot`.
  - A pass records `elapsed` on the window, so a bot after a person who
    let the card go does not start its whole reaction time again.
- **Tests:** GameSession.test.ts "the claim race" (a press 50ms before the
  bot's time wins; the bot claims at its time; no restart after a pass;
  two people race the bot, not each other). Also rules.test.ts claim tests.
- **Known gap:** offline, the browser scales a hold by its speed setting
  and drops it under reduced motion, so at any speed but 1x (or with
  reduced motion on) a bot arrives sooner than the ring shows.
- **Not changed, by the rules:** the discarder cannot call Rummy on their
  own discard. Pagat's 500 Rum: "Any player other than the one who just
  discarded may call 'Rummy!'".

### The claim toast said "Seat 3 claimed"
- A seat with no name is a bot's. The online toast fell back to "Seat N"
  while the pods say "Bot N". It says "Bot N" now (`useOnlineRuntime`).
  Worth knowing when reading a report: that toast meant a BOT got the
  card, not the person who pressed.

### Nobody else could see the dealer choosing the deal size
- The table parks on the dealer while they choose, and other players saw
  nothing. Their hand-zone header now says "<name> choosing how many
  cards to deal".

### "Create meld" was offered for three kings that were all on the pile
- **Rule:** a meld made from a pickup must use at least one card you
  already held. `legalDrawDepths` enforced it for the pickup, so pressing
  was refused, but the button did not check it, and the meld itself was
  never checked. Someone holding one king could take three off the pile,
  lay those, and keep their own.
- **Fix:** `usesHandCard` in `state.ts`, enforced by `reduceLayNewMeld`,
  `validate` and `mandatoryMelds` (so bots follow it too). The pickup bar
  disables the button and says "use a card from your hand".
- **Tests:** rules.test.ts "a pickup's meld needs a card from the hand".

## BS

**Status:** committed 2026-09-25 (83fd8c2), after a code review. The last
game of the online pass.

### A bot's call was made before its pod finished "thinking" (found before playtest)
- **Found by** checking BS for Rummy's claim-race flaw, since BS runs the
  same shape of race after every play. Not yet seen in a playtest.
- **Cause:** a bot answered a window after the 120ms `WINDOW_BEAT_MS` and
  spent its reaction time (0.2–1.8s then, 1–3s now) as a `think` inside its own frame,
  which plays after the answer is made. Every seat still in the queue
  has a live "BS!" button, so a person pressing while a bot ahead of them
  still looked undecided lost to a call already in.
- **Fix:** BS's `turnHold(state, seat)` returns the rest of that bot's
  reaction time (at least 120ms), and a window answer's `think` is 0. A
  decline records `elapsed` on the window, so a window costs its longest
  reaction time rather than the sum. The GameSession test harness now
  uses the game's own `turnHold`, as both real drivers do.
- **Tests:** GameSession.test.ts "lets a person beat a bot ahead of them
  while that bot is still reacting" (fails on the old timing); bs
  rules/bots tests updated.

### "BS!" and "Let it go" stayed up after a bot had called
- **Cause:** the bar reads `live.state`, the last state the table FINISHED
  showing. A bot's call is made on the server first and then animated
  (the reveal), and for that whole animation the old state still had the
  window open. Rummy's claim bar had the same gap during a bot's claim.
- **Fix:** `GameRuntime.latest`, the newest state the viewer has been
  told about (online: the newest frame; offline: set as each frame
  arrives). BS's `canCall` and Rummy's claim bar require the window in
  both, so the buttons go the moment the move is made.
- **Tests:** barMode.test.ts "takes the challenge down the moment somebody
  else has called".
- A bot calling before the person's ring ends is by design in BS: the
  ring is 10s and the seats ahead answer in turn.

### Clicking cards to play threw "Cannot update a component (`Piece`) while rendering `RoomScreen`"
- **Cause:** `setHeld(prev => togglePlayCard(prev, id))`, and the toggle
  patched the table store. React may run a state updater during render,
  so that was a store write during render (and in development updaters run
  twice). Spades' Blind Nil exchange had the identical pattern, online
  and offline.
- **Fix:** the toggles are pure; `useHeldMarks` (src/table) syncs the
  store's marks from the held list in an effect, and re-applies them after
  each batch resets the store. It replaced BS's own `useHeldLift`.
- **Tests:** useHeldMarks.test.tsx.

### A card picked to play barely looked picked
- BS only lifted it 18px (`selected`). Rummy lifts AND rings it
  (`selected` + `highlighted`); BS now does the same.

### BS had Dominoes' slam
- On ~38% of plays, on going out, and on a caught liar. The user wants
  the slam on plays to be Dominoes' alone, and is fine with one when a
  liar is caught, so that is the only slam BS keeps.

### The hand woke up during somebody else's challenge window
- **Cause:** the piece layer makes the hand live (full size, tappable)
  on `live.isHeroTurn`. In a window, `currentSeat` names the first seat in
  the answer queue, which is sometimes the viewer, so their hand came
  alive for a turn where they could only call or let it go ("sometimes":
  only when first in the queue).
- **Fix:** `GameHost`'s optional `handActive(live)`, defaulting to
  `isHeroTurn`. Both BS shells pass `canPlay`, so the hand is live only
  when the viewer may play.

### The bottom sheet (pile history) is gone
- The user's call: BS does not need Rummy's sheet. It also covered the
  bottom of the pile and part of the hand-to-pile flight path, which is
  the likeliest reason plays looked un-animated.
- A replay of real server frames through the client store (two people,
  two bots, 44 plays, 9 of them the viewer's) found every `play` event
  aimed at a piece the table held and moved it to the pile, so the data
  is right. If a play still looks un-animated with the sheet gone, it is
  a drawing problem. Ask whose plays (yours or others') and check in a
  real browser; jsdom cannot judge motion.

### Plays "sometimes" never flew from the hand to the pile (still, after the sheet went)
- **Cause (online, any game, BS worst):** when a batch ends, the settled
  board can rename a piece still in flight (a card played face down into
  the pile becomes the pile's stand-in), so adopting it is delayed by the
  flight's `tail`. But the NEXT batch adopted it at once, in `pump`. So the
  flight survived only when nothing was queued behind it. BS answers every
  play with a quick frame (a person's "Let it go"), so the card was swapped
  out mid-air: about 20ms of a 400ms+ flight.
- **Fix:** `pump` waits while a reset is pending, and the pending reset's
  timer starts the next batch. Catch-up (`CATCH_UP_FRAMES`) still flushes
  at once.
- **Tests:** useOnlineRuntime.test.tsx "still lets them finish when the
  next frame is already waiting" (20ms on the old code).

### Other players' cards never flew to the pile (only your own did) — found in Chrome
- **Seen, measured in two real browsers:** your cards flew ~450px to the
  pile; every other player's moved 6–27px (their hand closing up) and
  never left the hand. The one exception was a card from the LAST slot of
  a hand.
- **Cause:** you cannot see an opponent's cards, so their stand-ins are
  named by SLOT ("#hand:2:-:3"). The online runtime delays adopting the
  settled board only while a piece in flight would VANISH from it, and
  checked that by name. After a play from the middle of a hand the name
  survives, for the card that slid into the gap, so the board was adopted
  the instant the play was applied and the card was pulled straight back.
  jsdom tests sampling the store every 20ms never saw it: the move and the
  snap-back happened inside one timer callback.
- **Fix, three parts, all in `useOnlineRuntime.ts`:**
  - A piece counts as in flight when the batch left it anywhere the
    settled board does not, not only when its name is gone.
  - `adopt()`: a stand-in whose settled place differs from where it is
    drawn gets `Placement.jump`, so it snaps there instead of flying BACK
    out of the pile under its reused name. Kept while the piece stays put,
    because the next settle can land in the same tick and drop it before a
    render; `moveTo` clears it.
  - After a jump, the next batch waits `JUMP_BEAT_MS` (60ms) so the jump is
    drawn before the piece moves again (a person playing twice quickly,
    under the same slot name, had the card start at the pile).
- **Tests:** useOnlineRuntime.test.tsx "lets another player's card fly to
  the pile before the board is adopted" (subscribes to the store rather
  than sampling; 0ms on the pile on the old code, and asserts the jump).
- **Verified in Chrome** (two isolated contexts, 16 plays): every card
  reaches the pile, none flies back, none is drawn under the top card.

### A small (hand-sized) card sat on top of the pile
- **Seen:** a half-size card back on the pile, sometimes for many
  seconds. Caught in Chrome: an opponent's stand-in whose store placement
  was back in the hand (`jump` set) but drawn at the pile, at hand scale.
- **Cause:** the jump was an instant TRANSITION. The card's flight to the
  pile (a spring) was often still running when it jumped, and Motion 13
  kept running the old x/y/rotate animation after the jump; only scale
  took. `{ duration: 0 }` and `{ type: false }` both failed this way.
- **Fix:** `Placement.jump` is a NUMBER, new per adoption that jumps, and
  the piece's element is keyed on it, so a jump remounts the piece at its
  new place (`initial={false}`) and the old animation goes with the old
  element. It is never cleared by a move (clearing changed the key and
  remounted the card straight onto the pile, so its next play never
  flew); the next jump replaces it. The hold before the next batch is
  released by an effect after the jump has been COMMITTED; a fixed 60ms
  beat lost the race when the page was busy.
- **Verified in Chrome:** across several 2.5-minute runs, no hand card
  sat on the pile for more than 3s (it was 18s before).

### Catch-up skipped plays in ordinary BS play
- `CATCH_UP_FRAMES` (2) counted frames. BS sends a burst of frames that
  show nothing after every play (each "Let it go", each bot's decline),
  so the next play was often skipped: applied instantly, with no flight.
  Now it also needs `CATCH_UP_MS` (2.5s) of real playback queued.
- **Tests:** useOnlineRuntime.test.tsx "does not skip a play queued behind
  a burst of empty frames" (1ms on the pile on the old rule).
- In Chrome, flights reaching the pile went from 63/67 to 72/73. The rare
  remaining miss, seen with a DOM-querying sampler running every frame in
  dev mode, could not be tied to a cause; watch for it.

### A played card landed under the pile's top card
- **Cause:** a `play` kept the player's seat on the piece (for the trick's
  lean), and pieces are bucketed by zone AND seat, so the card became
  index 0 of a pile of its own: z 300 against the pile top's 326. The
  trick had already been special-cased for the same reason.
- **Fix:** `applyEvent`'s `play` keeps the seat only when going to the
  trick. Only `trick`, `hand` and `collected` read a seat, and a play
  never goes to the other two. Also affects Rummy's discard and board.
- **Tests:** applyEvent.test.ts "joins the pile already there rather than
  starting one under it" (index 0 on the old code).

### Reloading during a round or match break showed no summary
- **Seen in Chrome:** after a reload while a round was over, the table
  showed the finished position with no summary and no way to continue
  (at match end, no Lobby button). The other player's screen had them.
- **Cause:** React StrictMode (dev) mounts, cleans up and mounts again.
  The reload's frame was settled on the first mount, which armed the
  reveal timer; the cleanup cancelled it; the remount skipped the frame as
  already received. Dev-only, but it is the build every playtest runs.
- **Fix:** the reveal is an effect keyed on the settled frame (`applied`)
  instead of a timer armed inside `settle`.
- **Tests:** useOnlineRuntime.test.tsx "shows the round's summary to
  somebody who reloads during the break" (and the match's). Verified in
  Chrome.

### Everyone saw "Next round"; only the party leader should
- **User's rule (2026-09-25):** the leader continues; everyone else sees
  "Waiting for <leader> to continue".
- **Fix:** `mayContinueRound(room, session)` in room.ts gates the
  server's `nextRound` and becomes `RoomView.youMayContinue`; the tables
  pass `continueWaitingFor(room)` to `GameHost`'s `continueWaiting`, and
  the scorecard shows that line instead of the button.
- **Never stranded:** while the leader is away from the table (stepped
  to the lobby), any seated player at it may continue. A leader who
  DISCONNECTS (a reload counts) already hands leadership to the next
  connected member and does not get it back, so after the leader reloads,
  the other player becomes leader and continues. Verified in Chrome.
- **Tests:** room.test.ts "who deals the next round";
  RoundEndScorecard.test.tsx.
- The match-end "Lobby" button is not "next game": it takes only the
  person who presses it back to the lobby. Starting the next game is
  already the leader's, from the lobby.

### The turn ring jumped across the table after a play
- During a window `seatCue` lit the seat the window was waiting on (the
  first in its answer queue), which can be anyone. The user wants the ring
  to stay on the player who made the play until the window is over; BS's
  `playerViews` does that now.

### Somebody played while BS / Let it go were still up
- By design until now: the seat on turn could play over the top of an
  open window. The user ruled it out: while a window is open, the only
  moves are BS and Let it go. `legalActions`, `validate` and `reducePlay`
  enforce it; `canPlay` is false through a window, so the hand is asleep
  and the bar offers only the challenge. Trade-off: a person who answers
  nothing holds the table until their deadline (10s online).
- The bluff-calibration harness in bots.test.ts played the bluffer into
  open windows; it now lets them go like everyone else.

### Bots called BS too fast to follow
- Reaction times were 0.22–1.8s, and a call a fifth of a second after a
  play is faster than a person can take it in. Now 1–3s
  (`REACTION_MIN`/`REACTION_MAX`), at the user's request.

### Found in the code review before committing
- **Dev scenarios lost their buttons.** Offline `replaceState` (the dev
  panel's state editor and `scenarios`) set `state` but not the new
  `latest`, and window buttons need the window open in both, so Rummy's
  "Rummy! window" scenario drew no claim bar. `replaceState` sets both.
- **Catch-up could play a frame straight after a jump.** `pump` checked
  the post-jump hold before catch-up, and catch-up's own `flushReset` can
  jump pieces; the next frame was then applied in the same render. The
  hold is checked after catch-up now.

## Open gaps (known, not yet fixed)

- None known in the games playtested so far (Spades, Dominoes, LRC, Poker,
  Rummy, BS).
- BS: a rare opponent play that still does not fly (1 in 73 in Chrome,
  under a heavy sampler in dev mode). No cause found; watch for it.
- BS: a bot further down a window's answer list waits for the rest of its
  reaction time after the seat before it, measured from that seat's
  reaction time (`ChallengeWindow.elapsed`), not the clock. A person who
  lets a play go quickly therefore brings the next bot's answer forward.
  The state has no clock to do better; it has not been noticed in play.
- Rummy: a lost claim race is only told by the toast and the claimer's
  chip on the meld. The user read a missing chip as "I got it". Offered,
  not built: the claim bar says "You got it" / "Bot 3 got there first"
  for a moment after the race.
- The centre-zone audit in Poker's layout note above, deferred to the
  larger layout pass. Rummy's pile now has measurements there too; see
  `layout-ui-ux.md`, "The table's centre runs into the seats".


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
