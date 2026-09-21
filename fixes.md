# Open list — multiplayer

What is known to be wrong, or known to be missing, and not yet done.
Anything fixed is deleted rather than ticked; git has the history and
`continue.md` has the narrative. Ordered by what would actually hurt a
launch, not by how interesting it is.

Last swept: 2026-09-20, against the whole of `src/server`, `src/session`,
`src/room` and the six games' table shells.

---

## Worth doing before this grows past a friend group

### A room is one process, and nothing shares it
Rooms are live in-memory objects with timers and open sockets, so the app
is capped at **one instance** and `render.yaml` must never gain
autoscaling. Two players given the same code could land on different
instances and never meet. The real fix is a shared store (Redis) or
sticky routing — a rewrite of the room layer, not a config flag. At ~10
players it is not worth it; at 100 it is the first thing to do.

### No Origin check on the WebSocket upgrade
`wsServer.ts` checks the path and nothing else, so any page anywhere can
open a socket and create rooms. Low impact today because identity is a
`localStorage` token rather than a cookie, so a cross-origin page cannot
present somebody else's credential — it can only make noise. Worth
closing if the URL is ever handed out publicly.

### No ceiling on rooms per process, or rooms per session
Members per room are capped (`MAX_ROOM_MEMBERS`) and the identity table
is capped (`MAX_IDLE_IDENTITIES`), but nothing stops one client opening
sockets and creating rooms until memory runs out. The rate limit is
per-connection, so N sockets is N × the budget. Same reasoning as the
Origin check: fine among friends, not fine on a public URL.

### `reqId` idempotency is promised and not implemented
`protocol.ts`'s header says a retry "is recognisable rather than being
applied twice". It is parsed, it is echoed on errors, and nothing
anywhere dedupes on it. Either implement it or stop promising it — the
comment is currently a lie a future reader will rely on.

---

## Known imprecision, deliberately left

### A window's serial cost is by design
Several live seats each get their own full window, so at six seats a
single play can park the table for a while. This is deliberate and
documented at `ChallengeWindow.pending`: by the time you are asked, the
seats ahead of you have already had their turn, so being beaten to a
window happens by being further down the list rather than by running out
of a clock somebody else set. Capping it table-wide would be a different
game. Revisit only if real play at 5–6 seats is reported as slow.

### `safeLastAction` is a substring heuristic
`RoomRuntime` refuses to forward a `lastAction` whose JSON contains
`"<id>"` for any face-down piece. An action embedding a piece id inside a
longer string, or naming a piece with no entry in the placement map,
slips through. Low risk given the current action shapes, but it is a
guess, not a guarantee.

### `onClose` can run twice
A heartbeat-failed socket gets `router.onClose(peer)` and then
`terminate()`, which fires the close handler again. Benign — the second
`detach` early-returns — but unguarded.

### `openSeats` is documented as absent when no game runs
It is always set, and `[]` when there is no game. Doc-only mismatch.

---

## Testing gaps

### No WebKit
`playwright.config.ts` runs chromium and a chromium **phone profile**
(`Pixel 7`), which covers the short-viewport branch, the pannable fans
and Rummy's rotate prompt. Mobile Safari has its own failure modes and is
a plausible target for a phone-first table game. Left out deliberately
rather than half-done.

### The browser layer never seats more than four
The harness now runs four humans at a partnership table, four at a
six-seat BS table and ten in one room. The e2e layer tops out at four
contexts, which is the interesting case for redaction but not for
pacing. A ten-browser test is probably not worth the wall-clock.

### `router.test.ts` runs spades only
Every `gameId` in that file is `"spades"`, so BS's race-heavy shape never
reaches the router/liveness layer in a unit test. It is covered at the
session layer and in the harness; this is a gap in the cheapest layer,
not an uncovered behaviour.

---

## Smaller things seen in passing

### "Claiming one aces"
BS's claim bar reads `Claiming {countWord} {rankPlural}`, which is right
for every count but one. Needs a singular, seen in a real browser.

### `CATCH_UP_FRAMES` against BS's 120ms beat
`useOnlineRuntime` trims a backlog of 2 frames and then `skip()`s to the
present. BS asks the driver for 120ms between window answers, so a table
with several live seats produces frames faster than that threshold was
tuned for. Not observed misbehaving in a two-player browser session —
measure at 5–6 seats before changing the constant.

### A spectator pays for a hand strip nobody owns
`geometry.ts` computes `handZone` without consulting `watching`, so a
spectator loses ~130–165px of table height to an empty band and the seat
ring is squeezed to match. Touches shared layout for all six games, which
is why it was not done in a pass aimed at correctness.

### BS's `PeekRail` is not reserved in the geometry
Neither shell passes `bottomZone` for BS, so `reserved.bottom` is 0 and
the rail's own fallback height never fires. It rests over un-reserved
felt near the bottom seat pods. Rummy reserves its sheet explicitly and
is the model.

### Rummy's selection is not cleared on an unmount it did not initiate
`clearSelection()` is wired to the two exit buttons, so the leader ending
the game or a kick unmounts the component with its store patches still
applied. The room-level `held` is now cleared on a game or round change;
Rummy's staged pickup is owned separately and deliberately (see
`RummyOnline`'s own note) and was not folded in.

### Destructive room actions have no confirmation
"End the game for everyone" ends it mid-hand for the whole table, and
kick and "Leave room" are one tap each. No dialog, no undo. Deliberate so
far — the room is small and the actions are the leader's — but it is the
kind of thing a first playtest with strangers turns into a complaint.
