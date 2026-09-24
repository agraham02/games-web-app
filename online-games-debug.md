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

## Open gaps (known, not yet fixed)

- **Dominoes and BS, rounds 2+:** a piece face up before the batch (a tile
  on the line, a revealed BS card) is swept, shuffled and dealt face down to
  an opponent. After the shuffle it must be anonymous, and the stand-in it is
  renamed to is one the table never held, so that deal pops instead of
  flying. Excused by name in redact.test.ts's no-op test — remove the
  exemption when fixing.
- **Poker's first deal** has no pile to fly from, offline or online
  (CLAUDE.md, "An animation needs a table…").

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
