# Table Games — architecture

Web app hosting six table games, alone against bots or in a room with
other people: Dominoes (Block & Draw, and the Caribbean game), Spades,
Rummy 500, Poker (NL Hold'em), Left Right Center, BS (Cheat). Priority is
UI/UX — real-table motion, distinct phase screens, and Rummy's board
information shown without clutter.

**Status: all six games are real**, with full rules, bots and play
screens, and **all six run online in a room**. Rummy needed its rules
changed rather than its wiring to get there — see "A claim is a race"
below. BS came after that work and cost almost nothing as a result, but
it runs the same race after EVERY play rather than once every twelve
rounds, which is a load the machinery had never taken — see "A race every
turn". The shared layer is additionally exercised through `/lab`.

```
npm run dev      # server + app on one port: /play/rummy, /room, /lab/seats
npm run check    # typecheck + lint + test
npm run harness  # adversarial WebSocket scenarios (needs `npm run dev`)
npm run e2e      # real browsers, one real server (starts its own, port 3210)
npm run measure  # how much of the screen each table uses, by what (docs/table-layout-rethink.md)
```

`npm run dev` boots `server.ts`, not `next dev`: rooms are live objects
with timers and open sockets, so the app needs a process that stays up.
That rules out serverless deploys — it runs anywhere Node runs, and
`README.md` covers where. Two consequences worth knowing before touching
the server: it caps the app at ONE instance (a second would hold a second,
invisible set of rooms), and `tsx` and `cross-env` are runtime
dependencies rather than dev ones, because the server is TypeScript that
is never compiled. Moving either back to `devDependencies` breaks every
production install.

## The decisions everything rests on

### 1. The engine emits events, not just state

`reduce(state, action) -> { state, events[] }`.

A snapshot cannot drive a table animation. If you only diff state you
have to guess whether three cards moved because they were dealt,
collected as a trick, or swept to a discard — and each looks completely
different. The event list says which.

Bot deliberation is a real event (`{t:"think", seat, ms}`), not a
`setTimeout` in a component. That is most of what makes an opponent
feel like a person.

A cosmetic flourish is an event too. Caribbean dominoes' **slam**
(`{t:"slam", piece, shake[]}`) rides immediately before the `move` that
relocates the same tile, so the two play as one gesture — and because it
goes through the queue it obeys `skip()`, the speed multiplier and
reduced motion for nothing. Two things it must carry to work: a real
`duration` in `choreograph` (an event with no `case` gets `0` and the
next event stomps it in the same frame), and its own `shake` list, since
only the engine knows which pieces were already down — a shake that
reached into a hand would be badly wrong.

Whether it fires is decided in `reduce` by hashing the position
(`hashString` in [engine/rng.ts](src/engine/rng.ts)), never by
`Math.random()`, so a seed replays a match's slams as exactly as it
replays its deals. Reach one on demand from `DevPanel`'s `scenarios`,
or fire the raw pair at `/lab/motion`.

### 2. One flat piece layer; cards never reparent

Every card, tile and chip renders **once**, in
[PieceLayer.tsx](src/table/PieceLayer.tsx). A card "in your hand" and
the same card "in the trick" are the same DOM node at different
transforms.

- no reparenting → no unmount/remount, no lost animation state
- no z-index fights between a Hand and a Trick component
- one source of truth for position → a resize is just a recompute
- **only `transform` and `opacity` animate** → runs on the compositor

Every piece renders at one fixed base size and `scale` does the rest,
so moving a card between zones of different sizes never touches layout.

**Motion's `layoutId` shared-element transitions are deliberately not
used.** They cannot animate SVG, they are disabled during window
resize, and 52 simultaneous transitions across mounting and unmounting
components is fragile in a way this is not. This is also why card faces
are HTML+CSS ([CardFace.tsx](src/ui/primitives/CardFace.tsx)) rather
than SVG or image assets.

### 3. One engine, two drivers

`GameSession` ([session/GameSession.ts](src/session/GameSession.ts)) is
the turn loop with no React in it: it deals, reduces, runs bots and
decides whose turn is next. `useGameRuntime` drives it in a browser;
`RoomRuntime` drives it on the server. Same code, same rules, same bots.

The division that keeps it honest: **the session decides WHAT happens
next, the driver decides WHEN it is allowed to.** That is why `settled()`
is a call the driver makes rather than something the session does for
itself — a browser settles when an animation finishes, a server the
moment it has broadcast.

Two substitutions make multiplayer possible at all, and both are one
line: `setTimeout` became an injected `Clock`, and `seat === HERO` became
`isSeatLive(seat)`. Offline the latter is true for seat 0 alone, which is
exactly the old behaviour.

### Hidden information is filtered before it is sent

`placements(state, viewer)` decides what a seat may SEE;
[session/redact.ts](src/session/redact.ts) enforces what it may therefore
IDENTIFY. The rule is deliberately blunt, because a subtle one would
eventually be got wrong: **a piece drawn face-down is a piece whose
identity the viewer does not get.** No exceptions, no per-game opt-outs.

Three things have gone wrong here already, all worth knowing:

- **`playerView` leaked the future.** Poker returned `deck` and Rummy
  returned `stock` intact — the undrawn cards in order, worth more than
  any hand. Unnoticed because single-player never sends a view anywhere.
- **Concealment was judged from the wrong end.** `projectEvents` looked
  only at placements BEFORE a batch, so a card with no prior placement
  kept its real id — which is every card in an opening deal. Spades hid
  it (it places its deck first); Poker exposed it.
- **A frame carried meta for stand-ins only**, so `PieceLayer` drew
  nothing for the viewer's own face-up cards. Every unit test passed and
  the table was empty. Only a real browser caught it.

- **Both ends of a batch are not the whole batch.** The last card of a
  Spades trick goes from a hidden hand to a face-down won pile in one
  reduce, so judged by its ends it was a secret: everybody else saw a
  blank card land, and the player who led it saw nothing move, because
  its stand-in was one their table never held (`moveTo` skips those
  silently). The three cards already on the trick went the same way.
  `projectEvents` now tracks what the viewer can identify DURING the
  batch — seen before, or played face up in it, forgotten at a
  `shuffle` — which is why `play` carries a required `faceUp`: it says
  what was shown, and BS plays face down. What the viewer knew going into
  a shuffle is swapped for stand-ins by a `mask`: two UNPAIRED lists
  (real ids out, stand-ins in), handed out in the order the deal names
  them, because a pairing would say whose hand each piece went to. The
  redaction test asserts every event aims at a piece the viewer's table
  holds, across whole matches of every game.

The pattern: each was found by doing the NEXT thing (a second game, a
real browser), not by more tests on the last one.

### A claim is a race, and a race needs two things the turn loop lacks

Rummy sat out of online play longest, and not for a wiring reason. Three
places in its rules answered "the human" with seat 0: `startRound`
resolved a bot dealer's hand size inline and parked only for `HERO`,
`currentSeat` handed the turn to `HERO` outright whenever a claim window
opened, and the race itself was timed by a `setTimeout` on the play page.

The deal size was the easy one — park on the dealer, whoever it is, and
let the session run a bot for a seat nobody is at, which is what it does
for every other turn. The claim needed two genuinely new things.

**More than one seat may act at once.** `currentSeat` can only name one,
so `GameSession.submit` now gates on `legalActions(state, seat)` being
non-empty instead. For four of the six games those are the same question
— asserted across whole matches in `GameSession.test.ts`, some eight
thousand seat-turns of it — and `currentSeat` remains what the PACING
waits on. Rummy's claim window is where they diverge: it names every
eligible seat, `currentSeat` returns the soonest, and all of them are
entitled. A human three deep in the queue can still beat the bot at the
front by being quick, which is the whole mechanic.

**A live seat cannot be allowed to stall the table.** `GameDefinition`
gained `deadline?(state, seat)`: what to do for a seat that does not
answer, and how long to wait. Almost nothing needs one — a game where
everyone waits on the person whose turn it is is the normal case, and
fine. A race is not: it parks the whole table on several seats at once.
That used to be resolved by the page's own timer, which works exactly as
long as the page is the only authority; online, a backgrounded tab has
its timers throttled to about one a minute, so one player switching apps
froze the game for everybody. The client still draws its ring, but it is
a nicety now rather than the mechanism, and the two clocks are
deliberately not tuned to fire together (`CLAIM_GRACE_MS`).

**A bot waits out its reaction time BEFORE it claims** — as the session's
hold, through `turnHold?()` — never as a `think` inside the claim's own
frame. A frame's think plays after the move it rides with has already
happened, so the card was gone on the server while a person's ring still
ran, and presses inside the ring lost (found online, 2026-09). A beat
that decides who wins belongs before `reduce`. A person's ring is the
soonest BOT's time, never another person's: people beat each other by
pressing first, so `deadline?()` is handed `isLive` for this.

**The ws harness found the stall**, which is the layer that should have:
it drives real sockets with no browser behind them, so a table that only
moves because a page is running stops dead.

### A race every turn is a different load from a race a round

Rummy's claim window opens about once every twelve rounds. BS runs the
same shape — several seats entitled at once, `legalActions` as the gate,
`deadline?()` as the backstop — after **every single play**, and that
turned out to be a difference in kind rather than degree.

**A seat that answers with nothing still costs a turn.** Every entitled
seat gets its own turn in the window, and a seat that lets the play go
emits no events at all. At the driver's flat 900ms hold, three opponents
meant nearly three seconds of blank table after each play. So
`GameDefinition.turnHold?(state, seat)` — optional, shaped after
`deadline?()`, and returning `undefined` for every game but this one.

The division holds: the driver still decides WHEN. It keeps its own
measurement of how long the last frame takes to WATCH (`playbackMs` on
the server) and its own speed multiplier and reduced-motion rule; the
game only replaces the constant beat that follows. What BS asks for while
a window is open is the rest of that bot's reaction time (at least
120ms), spent BEFORE it answers, as in Rummy's claim race. A whole window
therefore costs about its longest reaction time, and it reads as a
flicker of eyes travelling round the ring, each declining seat's pod
lighting on its own through `seatCue`, for free.

**While a window is open, the only moves are BS and Let it go** — for
everyone, the seat on turn included (the user's rule, 2026-09-25). The
seat on turn used to be allowed to play over the top of an open window,
so a generous one could not hold up the table. In a playtest that read
as somebody playing while the buttons were still up. The cost is
accepted: a person who answers nothing holds the table until their
deadline (ten seconds online). While the window is open the seat ring
stays on the player who made the challengeable play, not on whoever the
window is waiting on.

**A person's own deadline is NOT capped by the fastest rival**, which is
where this deliberately parts company with Rummy. There, a seat gets at
most until the quickest bot rival reacts, and that is right for a race
happening once a round. Here it would hand a player 250ms to answer a
window that opens after every play. The seats ahead of you in the list
have already had their turn by the time you get yours, so being beaten to
it happens by being further down the list — not by running out of a
clock somebody else set.

**A reveal has to survive into the settled state.** The challenged cards
turn face up for everybody, and `placements` is the authority for FACING
— so if the position `reduce` returned said they were face down, the
redaction layer would quite correctly send them out as anonymous backs
and a challenge would turn over four blank cards. Which is why taking the
pile is its own action rather than part of the same reduce: the reveal
has to be a state anybody can be shown, not a moment inside a batch.

**The pile is face down to everybody, its own contributor included.**
Letting a player keep the identities of cards they put in themselves is
safe in the narrow sense — they already know them. It was still wrong,
and `redact.test.ts` caught it on the first run: the rule is blunt on
purpose, because a subtle one eventually gets got wrong. It costs nothing
real either way, since what is worth remembering about a pile is how much
of it is yours, and that is a count the public claim history already
gives.

**Bots must be fallible in BOTH directions**, and this is the second time
that lesson has been paid for. A bot that never misses a provable lie
means a hand holding none of the rank cannot bluff at all; a bot that
only ever lies when forced makes every claim trustworthy; a bot with a
hard cap on its bluff size makes every FAT claim trustworthy, which is a
rule a person can read off the table for free — and which had the bots'
own suspicion of big claims aimed squarely at honest ones. `bots.test.ts`
measures reachability rather than correctness for exactly this reason,
and holds the liar fixed when it measures difficulty: across a table of
one tier, "lies caught" conflates being good at catching with being good
at lying, and those two move in opposite directions.

### A move that is no choice plays itself

`GameDefinition.forcedMove?(state, seat)` names a move a live seat has no
choice about, and the session makes it for them after `FORCED_MOVE_MS`
(30s) — the user's call, 2026-09-29 (5s at first; 30s since 2026-10-01),
offline and online alike. It rides the
same deadline machinery as a game's own `deadline?()` (which wins where
both answer), submitted through `submit` so `completeAction` still rolls
LRC's dice, and keyed `forced:${seq}:${seat}` — `submit` emits a frame even
for a move that animates nothing, so the key changes exactly when the
position does and a re-settle over the same position resumes the countdown.
Online the server adds what is still playing of the frame that handed the
move over (`deadlineLeadMs`); offline the session settles after the
animation, so there is nothing to add.

**"One legal action" is not the rule, and must not become it.** A Spades
singleton in the suit led, a domino hand with one tile that fits, and a
Rummy draw where no depth of the pile fits the hand are all one legal
action — and a move that lands exactly when the wait runs out tells the
table so.
A game names only what is forced for a reason everybody can already see: a
last card, a draw or a pass, a roll, a stock draw from an EMPTY pile.
`forcedMove.test.ts` holds every game to that across real matches, and
counts the private one-move positions it met so it cannot pass vacuously.
There is no countdown on screen for the same reason. A press arriving just
after the move was made for them is dropped without a word
(`autoPlayed`, `PLAYED_FOR_YOU`) — it was the same move. So is one
arriving just after the turn timer made a move for them: the frame that
made it has already said "You ran out of time", and a refusal on top
was the same news twice, in red.

### The turn timer is a deadline the session owns

A room may time each move (the user, 2026-09-29: on in a new room at 30s,
5–60s in steps of 5, fixed for a game). `GameSession` takes the length from
the driver (`turnTimerMs`) and arms it in `scheduleDeadline` beside a forced
move's (the sooner wins) whenever the game names no deadline of its own —
Rummy's claim race, BS's window and Poker's show-or-muck keep theirs. The
clock times every move, forced or not: since forced moves went to 30s
(2026-10-01), a shorter clock runs out on a forced move like any other, with
the toast and toward going idle, and the forced wait only decides a table
whose clock is off or longer. Five things to know before touching it:

- **When it starts.** After what is still playing of the frame that handed
  the move over (`deadlineLeadMs`), plus the ready beat for a round's first
  move (`READY_BEAT_MS`, shared from `motion/choreographer.ts`) — nobody's
  seconds are spent watching a deal.
- **It is never refilled.** Keyed `turn:${seq}:${seat}` and anchored with
  the span it STARTED with: re-derived on a re-settle, a span that includes
  a shrinking lead lost the elapsed part twice (fixed for forced moves too,
  `d01f8b0`).
- **What everybody is shown ends `TURN_GRACE_MS` before the session acts**,
  so a move pressed as the ring empties still arrives. The wire carries
  time LEFT (`turnClock.endsInMs`, measured at send), never a time of day,
  and the client takes off half its smallest measured round trip (`pong`
  echoes `sent`; `RoomConnection.oneWayMs`): two machines whose clocks
  disagree still show the same ring. A late arrival is sent what is left.
- **What is played is a bot's move, made as a bot makes one** — straight to
  `reduce`, past `completeAction`, or a timed-out Spades Blind Nil vote
  would be stamped a person's firm vote and overrule their partner. Poker
  overrides it (`timeoutAction`): check if free, else fold, never chips.
  So does Spades' bidding (2026-10-02): never a nil of either kind and
  never a blind contract for somebody who is not there — the vote is
  "look" (firm only beside a bot's deferring vote, so it never overrules
  a partner who is there), a team already blind bids 6, and otherwise the
  bot's count of the hand, at least one. A `timeoutAction` is played as a
  bot's move is, so it must be legal as it stands.
  The frame leads with "ran out of time" for everybody's toast and carries
  `timedOut`.
- **Two in a row and a bot takes the seat** (`markIdle`, a server-only room
  command; `isSeatLive` is false for the idle). Two TURNS, not two clocks:
  every move has its own clock, and a Rummy turn is a draw and a discard, so
  counting clocks idled somebody after one turn away (`timedOutTurn`).
  Started on the server, so it goes through `RoomRuntime.serverCommand`,
  which re-sends the room — without that the player's own screen never
  learns it (a test caught exactly that). "I'm back" (`resume`), entering
  the game, or simply making a move gives it back; reconnecting alone does
  not. Everybody idle ends the game, like everybody leaving.

Tested in four layers: `turnTimer.test.ts` (to the millisecond; whole
matches of every game with every seat silent, which can only end if every
decision point has a move to make), `router.test.ts` (late attach, no
refill, idle, late move), `scripts/ws-harness.ts` (real sockets, including
a move landing inside the grace on a slow line), and an e2e with a 600ms
round trip through `routeWebSocket`. Existing room tests that park on a
silent player switch the timer off (`host()` in `router.test.ts`).

### The turn gate and the action gate are different questions

`GameSession.submit` asks `legalActions(state, seat)` whether this seat
may act — see the claim race above for why it is not `currentSeat`. That
answers WHO, and nothing at all about WHAT: the action is arbitrary JSON
off a socket, and `reduce` would take a stranger's word for it. Spades
would play a card out of somebody else's hand (ids are suit+rank and
guessable); poker's `Math.round("abc")` is `NaN`, `if (added <= 0)` is
false for `NaN`, and one malformed bet turned the table's money into
`NaN` for the rest of the match.

So `GameDefinition.validate?(state, seat, action)`, shaped after
`deadline?()` and just as optional. Four games share
`validateByEnumeration` ([_shared/validate.ts](src/games/_shared/validate.ts)),
which tests membership of the game's own `legalActions` — the same
function the action bar is built from, so the button and the gate cannot
disagree. **Three games cannot use it** (or not for every action), for
the same reason in different clothes — the legal set is too big to
enumerate, so `legalActions` publishes representatives and membership
would refuse everything else. Poker returns `{t:"bet", to: range.min}` as
one point on a continuous range; BS publishes one play per COUNT, because
a play is any 1-to-4 card subset of a hand and there are 1,092 of those
for thirteen cards; Rummy lists one meld per starting card, and a meld is
any valid set or run — so four aces was refused, found in a playtest. All
three check the shape of a legal action by hand instead (Rummy for
`layNewMeld` only; its other actions are fully listed).

### An animation needs a table to play on, and a pile to fly from

The online runtime used to return `null` until the first frame had
FINISHED playing, so an opening deal ran with no table mounted — the
"Dealing you in" screen, and then a table that looked as though most of
the deal had happened offstage. That was half of it. The other half was
silent: `applyEvent`'s `moveTo` does nothing (`if (!prev) return`) to a
piece the store is not tracking, and online the store was EMPTY, so every
opponent's `deal` — addressed by a slot-named stand-in the store had never
heard of — was a no-op and their hands simply appeared at the reconcile.

Offline gets the starting position for free: it resets the store to
`placements(setup())` before the deal, so every card is in a pile for its
event to leave. Online does the same through `openingPosition` — built
from the client's OWN `definition`, not shipped in the frame. That works
because a stand-in is named by SLOT (`#deck:-:-:17`), which depends only
on how many pieces the pile holds, so redacting the same undealt state
here produces the names the server used. The one wrinkle: a card dealt to
THIS player arrives as `unmask` + `deal` under its real id, so the seed
puts the real piece in that slot rather than a stand-in, or thirteen
phantom backs would sit in the deck for the length of the deal.

Three rules keep it honest:

- **The table is drawn from the first frame**, and until something has
  actually played it is a picture — `isHeroTurn`, `busy` and `animating`
  say so, or a bid panel opens over an undealt deck.
- **The deal starts when THIS player's table is up** (`READY_BEAT_MS`
  after it mounts, and never in a hidden tab, whose throttled timers
  would play it out unseen). That is what makes it per-player: the server
  broadcasts and moves on, and a slow load delays only the person
  loading. A bare position — a refresh — does not wait; there is nothing
  to watch.
- **Only the opening deal is seeded** (`dealtRound === 1`). Anything else
  a client first sees is a position, and the settle that follows adopts it.

Poker used to be the gap: it placed nothing before its first deal, so
that deal had no pile to fly from, offline or online. Its `setup` now
parks the whole deck in the stub, as BS's parks all 52 cards on the pile —
a game with a deal must place what it deals before dealing it.

**A stand-in's name is a slot, not a card.** An opponent's hidden card is
named by where it sits (`#hand:2:-:3`), so after they play from the middle
of a hand that name belongs to the card that slid into the gap. Two things
follow, both found in BS in Chrome after every unit test had passed:

- Whether a piece is still in flight is asked by POSITION, not by name:
  the settled board is adopted late while any piece the batch moved sits
  somewhere the board does not put it. Asked by name, every opponent's
  play except from the last slot was pulled back into the hand the instant
  it was applied.
- Adopting the board snaps renamed stand-ins into place (`Placement.jump`,
  set by `adopt()`) instead of animating them, or the card that just
  landed flies back out of the pile. They are identical backs, so the snap
  cannot be seen. A jump is a REMOUNT (the number is the element's key),
  not an instant transition: Motion kept the interrupted flight's x/y
  running after a zero-length transition, leaving a hand-sized card on
  the pile.

A test of this has to SUBSCRIBE to the store; a loop sampling it every
20ms never sees a move and its undoing that happen in one timer callback.

### The server paces bot turns by what the last one takes to WATCH

`RoomRuntime` used to space bot turns by a flat 900ms from the moment it
broadcast — the server never waits on a client. But a bot's `think`
(600–1000ms) rides INSIDE the frame and every client plays it out, so each
turn took longer to watch than the server allowed. The client's queue grew
by a fraction of a second per bot turn until it passed `CATCH_UP_FRAMES`,
at which point `pump` drops the backlog and `skip()`s to the present — and
a table of bots skipped most of its own animations, dice tumble included.
Offline never has this, because there the hold starts when the animation
FINISHES.

`turnHoldMs` is now `playbackMs(lastFrame.events)` plus what the GAME
asks for — `turnHold?(state, seat)`, falling back to
`DEFAULT_TURN_HOLD_MS` — which gives a client at normal speed exactly
offline's rhythm. It still waits on nobody: a slow client falls behind
and catches up by itself. BS is the only game that answers; see "A race
every turn" above.

`playbackMs` and `gapAfter` live in
[choreographer.ts](src/motion/choreographer.ts) and are the SAME rule the
browser's `drain()` plays by, extracted so the two cannot drift. Do not
use `totalDuration` for this: it reads an offset of 0 as "starts with the
previous step", so it calls a think-pause-move turn 800ms when playback
really takes 1165 — it under-counts precisely the turns that matter.

`pause` now blocks the queue. It had a duration in `choreograph` and was
documented as obeying skip and reduced motion, but `drain()` only ever
blocked on `think` and `unmask`, so LRC's beat before a roll's chips fly
existed on paper and did nothing.

### A seat belongs to a person, and a person may have two tabs

`localStorage` is per-ORIGIN, not per-tab, so a second tab is the same
identity — and `attach` replaces the old socket, correctly, because the
seat belongs to the person. A bare close is indistinguishable from the
network dropping, so the replaced tab reconnected, which closed the tab
that had just taken over, which reconnected: roughly four round trips a
second for as long as both were open, with one of the two always holding
a dead socket and a stale table.

The server sends `{t:"superseded"}` immediately before closing, and the
client treats that as a deliberate stop — it does not retry, it keeps its
cached room so the seat is still there, and it offers to take the
connection back on purpose.

The consequence for TESTING is the thing to remember: **two tabs on
`localhost` cannot be two players.** Use two origins (`next.config.ts`
allows `127.0.0.1` in dev for exactly this), two profiles, or two
devices. The e2e tests use separate browser contexts.

### A liveness change is a turn change

`settled()` is what schedules a bot's turn, and on the server it is
reached from `onFrame` — which is to say, from somebody ACTING. That is
complete only while somebody is acting. Park the table on a live seat,
let that player drop, and the four games with no `deadline?()` armed
nothing: the seat was bot-played, no bot was ever invoked, and the person
still sitting there waited forever with an Away badge for company.

`RoomRuntime.command` already diffs a live-seat signature to push that
badge; it settles on the same edge, which inherits every route the
signature covers — dropping, exiting, being kicked, coming back.

Every test passed over it, and they shared a shape: they assert the NEWS
travels (`liveSeats` flipped, a frame carrying `botSeats` was pushed) and
none asserted the game then MOVES. `TestClock.drain()` is the instrument
that catches it — a stalled table simply stops, with nothing pending.

### A room is the point; playing alone is the fallback

The home screen leads with making or joining a room and puts the six
solo tables under "or play on your own", because that ordering is the
product. It also means a room has to be a room: **`MIN_ROOM_PLAYERS`
(2) is enforced in `applyCommand`**, not only in the lobby. One human in
a room is the offline game plus a round trip per bot turn, and it is
strictly worse — so the lobby dims Start, says why, and links straight
to `/play/<gameId>`. The button is the courtesy; the guard is the rule.
Only the leader has the button at all; everyone else is told who they are
waiting on (the user's call, 2026-09-27 — a dimmed Start somebody can
never press was the one exception worth making to the lobby's
dim-don't-hide rule).

Counted over CONNECTED members, deliberately: somebody whose phone is
asleep gets a bot seat the moment the deal happens, so counting them
would admit exactly the game the rule exists to prevent.

**The site installs as an app** (the user, 2026-09-27). `app/manifest.ts`
and the icons `scripts/app-icons.ts` draws make it installable.
`public/sw.js` answers page loads only (the network, or an offline page)
and caches nothing: Chromium fires `beforeinstallprompt` only for a site
whose service worker handles fetches, and ignores an empty handler.
`installCapture.ts` runs inline in the root layout's `<head>`, before React,
because the event fires once and often during load; it keeps the event and
registers the worker. `InstallPrompt`, on the home page only, offers Install
on Chromium and the Share → Add to Home Screen steps on iOS, where nothing
can start it (••• first in Safari 26, whose user agent still says iOS
18_6). It says nothing inside the installed app, and "Not now" lasts a
month.

**The next round is the leader's to deal** (`mayContinueRound`, which gates
the server and becomes `RoomView.youMayContinue`); everyone else's
scorecard says who they are waiting on. It can never strand a table:
while the leader is not at it, any seated player there may continue, and
a leader who disconnects has already handed leadership on.

**…and it deals itself after 20s** (`AUTO_CONTINUE_MS`, the user's call,
2026-09-29, whether or not anything else is timed). The Continue button
empties a `CountdownRing` over it and presses itself at zero, and everybody
waiting sees the seconds; the end time is fixed once, as the card appears,
so peeking at the table or the leader stepping away does not restart it.
The server deals anyway `AUTO_CONTINUE_GRACE_MS` later, counted from when
the card went up on screen (the frame's playback plus `ROUND_END_HOLD_MS`,
both ends reading the same constant from `session/roundEnd.ts`) — the
backstop for a leader whose tab is hidden or gone. `syncAutoContinue`
clears it the moment a round is dealt; a leftover would deal the NEXT
round early whenever that one ended inside the old twenty seconds, which
only fast rounds reach — the test uses poker hands folded at once, because
an LRC round never ends that fast and let the bug through.

**The lobby's list is the seating plan** (`seatingPlan`): one row per
seat, seat 1 first and clockwise from there, `null` for a seat a bot
plays, then anybody past the last seat, who will watch. The leader drags
rows by a grip (Motion's `Reorder`; the grip alone, so a finger on a phone
still scrolls the list) or moves them with the arrow keys, bots included,
and `arrangeSeats` sends the whole plan; `shuffleSeats` mixes people and
bots. `seatingPlan` squares the stored plan with the room — a departure
leaves a bot seat, a newcomer takes the first bot seat, the plan follows
the game's seat count, and nobody watches while a bot sits — so none of
that needs bookkeeping. Locked while a game runs. **In a partnership game
the seat IS the team** (`teamOfSeat`: partners across, seats 0/2 against
1/3), so there is no team setting to keep in step with it; the A/B
buttons, `assignTeam` and `randomizeTeams` are gone. Leadership is still
inherited in JOIN order (`orderedMembers`), whatever the seats.

**Making or joining is one press on the home page.** The home form takes
the name too, and leaves an intent in `sessionStorage` ([entry.ts](src/room/entry.ts))
that `RoomScreen` carries out once the server is listening. Read the
intent in an EFFECT, never in a state updater: React runs updaters twice in
StrictMode, and the first run consumed it (found in Chrome; the tests now
render in StrictMode). A shared `/room/CODE` link lands on a form that is
about joining that room.

**Rejoining asks the server over HTTP** (`GET /api/rejoin`, the token in a
header — [server/rejoin.ts](src/server/rejoin.ts)), not over the socket: a
socket's `hello` ATTACHES, which would hand the seat back from the bot
while the player is still on the home page. `peekSession` looks the token
up without minting an identity, so asking creates nothing.

**Leaving the room's page hangs up.** The socket is one per tab
([connection.ts](src/room/connection.ts)), and it used to outlive the
page: after the back gesture or a link home the server still had the
player at the table, so the bots played on to their turn and a game with
nobody real left in it never ended. `RoomConnection` now closes one tick
after the last page stops listening (`closeWhenIdle`; the tick is what
StrictMode's remount and `/room` → `/room/ABCD` need), which is exactly
what closing the tab does: a bot takes the seat, and with no real player
left `endIfAllBots` ends the game on the spot (the user: "not even for 1
second"). The home page waits for that close (`roomConnectionClosed`)
before asking `/api/rejoin`, or it is told about the game as it was.
Every socket handler checks it is still the current socket, because a
closed one goes on delivering its last frames and then its close.

**The lobby holds nothing for anybody** (the user, 2026-09-29). Hanging up
that way first says `bye`, and the server decides: a seat in a running
game is kept (a bot plays it), anybody else leaves the room there and
then. A refresh or a closed tab never runs that timer, and the server
cannot tell those from a phone locking, so an unexpected drop gets
`LOBBY_GRACE_MS` (20s) and then leaves like a Leave. The grace is silent —
`viewFor` reports them connected until it runs out — and it lives in
`RoomRuntime` (`maintainGrace`, re-derived after every command), not in the
pure room, so a seat holder whose game ends while they are away gets a
fresh 20s from then. A room is destroyed the moment its last member goes
(`displace`); `EMPTY_ROOM_TTL_MS` is now only the backstop for a room held
open by an unanswered knock, and knockers are told when any room goes
(`onRoomDestroyed`). Joining a room nobody is left in makes you its
leader, straight in even if it was private — there is nobody to ask.

### Chat is the room's, and a hand can silence it

A room has a chat (the user, 2026-09-29): a drawer from the right in the
lobby and at the table — ONE `ChatSheet`, owned by `RoomScreen`, so a trip
between the two neither closes it nor loses what was unread — with the
quick replies in a sideways row directly above the field. In the lobby,
what other people say also pops up as a toast that opens the chat
(`chatToast`, the user, 2026-10-01); at the table, never a toast — it
appears beside their pod (`SeatBubbles`). Neither ever shows your own. The rules live in `session/chat.ts`, shared by
both ends: the server cleans and checks every message (controls, direction
overrides and stacked accents out; 120 characters as a person counts them;
five per ten seconds), and the composer counts and dims with the same
functions, so it never offers what would be refused. The last fifty go to
anybody arriving (`chatLog`), and `connection.ts` keeps them across the
lobby ↔ table page swap.

**Table talk.** While a partnership hand is played (Spades; dominoes in
teams), whoever HOLDS a seat in it — at the table or stepped back to the
lobby, since they still know their cards — may send only the table-safe
quick replies (`RoomView.chat`, per viewer). Spectators and the lobby may
say anything: they see no hidden cards. A quick reply travels by id, so
the server, which decides what is safe, is the one that knows what it
says. The room is rebroadcast the moment a hand starts or ends, because
the mode rides on the room and not the frame.

Things that bit, worth knowing before touching it:

- **The sheet is portalled to `body`** (`InfoSheet layer="page"`): the
  lobby has no `TableSurface`, and inside one a text field sits under
  `select-none`, which iOS will not let you type into.
- **The table's pan listens on the whole document by coordinates**, so the
  sideways reply row over the hand strip was panning the hand. Anything
  drawn over the table that takes a gesture of its own is marked
  `data-pan-ignore` (`usePanZone`).
- **The keyboard is measured, not obeyed**: `useKeyboardInset` reads the
  visual viewport and pulls the sheet's bottom edge up, rather than setting
  `interactive-widget=resizes-content`, which would re-lay the whole table
  out under the chat whenever somebody typed.
- **A bubble hangs below or above its pod, never beside it.** Beside put a
  phone's high left seat's bubble into the toast lane. It is its own layer
  at z-980 because `SeatRing` is a z-800 stacking context that opponents'
  cards (up to 960) always cover.
- **Only what is said LIVE pops up.** `useRoom.chatLiveAfter` marks where
  the replayed log (`chatLog`: joining, reconnecting, the page swap) ends,
  or every arrival would replay the room's past as toasts. And chat toasts
  are put away when the lobby goes (`dismissChatToasts`): sonner replays
  any toast still up into the next `Toaster` to mount, and the table mounts
  its own.
- **A mouse cannot swipe.** With the scrollbar hidden, the reply row was
  out of reach on a desktop; `useSidewaysScroll` turns an up-and-down wheel
  sideways and lets a mouse drag it (swallowing the click a drag ends on).
  It snaps only under a coarse pointer — snapping fights both.

### A photo is the room's, not the game's

A member may add a photo for as long as they are in the room (the user,
2026-09-29: no accounts, nothing kept past the session). The browser crops
it to a centred square and shrinks it to a small JPEG itself
(`room/photo.ts`), on every device through a plain file input — a phone's
picker already offers the camera. The server checks the BYTES, never the
label (JPEG or WebP magic only — an SVG called a JPEG is a script), keeps
it in memory against the member (`RoomRuntime.photos`, not the pure room),
and serves it at `photoUrl(id)` with `nosniff` and a sandboxing CSP. The
id is random and new with every photo, so it is the version (cached for
ever), and it is the only way to reach one — an `<img>` cannot send a
token header, and a code-plus-session URL would be guessable. The roster
carries only the id: `RoomView` goes to up to 24 people on every change.
Pods get it through `GameHost`'s `seatExtras`, which lays room-only facts
over what each game's `playerViews` built, so no game knows about photos.
The browser keeps the picture for the session and offers it to the next
room joined in it.

### Presence is table state, so it needs a frame

`SeatView.away` marks a seat whose OWNER is not in it — read from
`awayFrom(frame)`, which needs both `botSeats` and `seatNames`, because a
chair nobody ever sat in is also bot-played and is not an abandonment.

The half that is easy to miss: `botSeats` rides on a **frame**, and
frames are produced by the game advancing. So the news that a bot took
over waited for the next move — and the wait is unbounded in exactly the
wrong case, which is the table parked on the one person still there. Their
opponent walked off, the table stopped, and nothing said why. So
`RoomRuntime.command` compares a **live-seat signature** across every
command and pushes the current position when it changes; comparing the
signature rather than switching on the command covers stepping out, being
kicked, a socket dropping and coming back, and whatever is added next.

Found in a browser with two windows open. Every unit test asserted on a
frame that in practice never arrived.

### Settling up is the server's, because only it still has the game

Poker and LRC may be played for money in a room (a buy-in; a chip value —
room-only options, off by default). At the end everybody sees the FEWEST
payments that square them up (`settle.ts`, the user's call, 2026-09-28):
exact, not greedy — people not already even, less the most groups that
each sum to zero, found by a search over subsets (≤ 1,024 at ten seats).
Nobody pays a bot: money won from or lost to bots is left out and people's
results scaled down to what people can pay each other (`amongPeople`).

It is worked out by `RoomRuntime`, not a client, because the leader's End
game clears the room's game in the same command — every table unmounts,
and the only copy of the final position is the server's session. So the
stop effect settles from the participation as it stood BEFORE the command
(`gameBefore`), a match played to its winner settles on the frame that
ends it, and the result rides on `RoomView.settlement` until the next game
starts: on the winner's sheet (`summaryExtra`) and at the top of the lobby
(`SettleUp`). Ended early, Poker calls off a hand in play (a hand at its
showdown is already won, and is paid); LRC counts only finished rounds.
`SettleUp` says what changes HANDS, never "you're even" — a person who lost
to a bot is not even, they just owe no person.

**Closing the room** (the leader's, 2026-09-29) settles the same way:
`closeRoom` stops a running game with a `stopSession` effect BEFORE its
`close` effect, so the settlement exists by the time `closeOut` tells
everybody — and it rides on that `left{room-closed, by, settlement}`,
because the lobby that would have shown it is going too. `closeOut` lets
go of each socket without closing it (a close reads as a network drop, and
the client would reconnect straight past the news); the router then
destroys the room, which tells anybody still knocking.

### Two questions, not one: who moved, and who are we waiting on

A seat pod lights from **`seatCue`** ([turnCue.ts](src/table/turnCue.ts)),
and it is one function because it used to be five copies of half an idea.

Every game had `busy && lastAction?.seat === seat` — "this seat moved and
we are still watching it". Deliberately not `state.turn`, which names the
NEXT actor the instant `reduce` runs; four of the games carry a comment
defending that. What none of them had was the other question. Offline they
are the same question: every seat with a pod is a bot, and a bot's turn
OPENS with a `think`, so `lastAction` lands on it as the turn begins.

A second human does not do that. Their turn produces no frame at all until
they act, so the glow stayed on the previous player until they moved —
reported as an indicator that only updated on a draw or a pass.

So the rule is a union, gated so exactly one seat can be lit:
`animating || pendingReveal` means a turn is on SCREEN and the mover keeps
it; otherwise the table is parked and `currentSeat` takes it. `busy` is not
an input any more, and should not be: it answers "can the HERO act", which
is simply always true for a spectator — whose table therefore kept the
first mover lit for the rest of the game.

`GameRuntime` gained `currentSeat` and `animating` for this. `busy` folds
both together and cannot be un-folded by a caller.

A third question has its own field: **is this chance still open?**
`state` lags the newest move by one animation, which is right for
drawing the table and wrong for a button offering something already
taken. A bot's BS call or Rummy claim is made first and animated after,
and the buttons stayed up through the animation. `GameRuntime.latest` is
where the game has actually got to; a window's buttons need the window
open in both. Anything that sets `state` without a frame (offline
`replaceState`, behind the dev panel's scenarios) has to set `latest` too.

**Selection marks are synced, never written from a state updater.** A
held card's `selected`/`highlighted` flags live in the table store, and
a toggle that patched the store inside `setHeld(prev => ...)` wrote to it
during render. Keep the toggle pure and let `useHeldMarks` sync the
store, which also re-applies the marks after each batch resets it.

### `HERO` is a default, not a fact

Seats are laid out by POSITION and labelled from the viewer, so pinning
somebody else bottom-centre is a relabelling rather than a second layout
(`ResolveOptions.viewerSeat`). Everything downstream still speaks in real
seat ids, which is what stops each game's own state — hands, bids, scores
— from needing to be rewritten per viewer. `viewerSeat: null` is a
spectator; `undefined` means "no opinion" and stays seat 0.

A game's play screen therefore splits: `page.tsx` is the offline shell,
`table.tsx` is the table content, and the only thing that differs between
them is a `View` — who is looking, and what everyone is called.

**What a tap MEANS belongs in `table.tsx`, not in either shell.** Both
screens own where a held piece is kept — the page in its own state, the
room in `RoomScreen` so it survives a trip to the lobby — and that is a
real difference. Which piece is legal, and whether picking it up is even
a choice, is not: it is a rules question with one answer. Dominoes'
`tapTile` is the worked example, and it exists because the two had
drifted. Offline, a tile with one legal end played on the tap; online,
every tap raised ghosts and asked the player to choose between one
option. Spades' own `onPieceTap` is the same shape.

### Testing it

Four layers, and each exists because the one below it is blind to
something:

1. `npm run check` — engine, session and room logic, all pure.
2. `npm run harness` — adversarial WebSocket traffic a UI would never
   send: malformed frames, out-of-turn moves, two clients racing. Asserts
   against `/debug/room/:code`, the authoritative state, because a
   client's view is derived and could itself be wrong.
3. `npm run e2e` — several real browsers on one real server.
4. `/lab/redact` — one frozen deal from any seat, with an audit strip.
   Looking right is not enough: a face-down card whose real id is still
   in the store looks perfect and is completely broken.


## Layout

[geometry.ts](src/table/geometry.ts) is pure — `(box, seat count) ->
where everything sits`. No React, no DOM, so
[geometry.test.ts](src/table/geometry.test.ts) verifies 6 viewports ×
9 seat counts without a browser.

- The hero is **always** seat 0, pinned bottom-centre.
- Seat 1 is the hero's left; numbering runs clockwise on screen, matching the
  direction turn order passes.
- Seats walk the perimeter of a rounded rectangle, **not an ellipse** —
  on a 9:19.5 phone an ellipse wastes the horizontal band, which is the
  only place a name and score fit.
- Edge allocation is a hand-tuned table per density tier, clamped to
  what actually fits, with a proportional fallback for counts beyond
  the table.

**A zone is cheaper than a collision.** Poker took three rounds of
screenshot-driven fixes before the answer turned out to be four dedicated
boxes computed as one vertical chain, rather than several games each
anchoring their own pile to `cy`. BS's `pile` and `reveal` follow that
recipe from the start: one pair, centred on `cy` together, so they cannot
overlap by construction — and `geometry.test.ts` asserts it across all
six viewports and nine seat counts instead of waiting to be shown a
screenshot. Reusing `deck`/`discard` would have looked nearly right, too:
both are offset from centre to make room for each other, so a game with
only ONE pile in either reads as visibly off-centre with nothing beside
it to explain why.

Three density tiers (`compact` / `regular` / `wide`) set piece sizes.
Width picks the tier, but a SHORT screen is `compact` whatever its width —
a 844×390 landscape phone is wide enough for `wide`, and every band on its
short axis is sized from these pieces.

### The board comes first

Measured on a 390×844 phone (docs/table-layout-rethink.md), the board was
the smallest thing on every table: 1–6% of the screen, drawn at half to
three quarters of the hand's size, because `resolveTable` seated everybody
first — pods, then their fanned hands reaching inward — and the board got
the remainder at a fixed size. Every commercial table measured for that doc
draws its board at least as big as the hand. So the order is now:

1. **A profile** (`tableProfile`): `phonePortrait` (< 600 wide),
   `phoneLandscape` (short), `roomy` (tablets and desktops). One engine;
   a profile only sets its parameters (`RIM`). Never a second layout — the
   user scrapped one before for being a second thing to maintain.
2. **The controls**: hand strip, band, reserved bands — as before.
3. **A thin rim of seats.** On phones an opponent's FACE-DOWN hand is
   **tucked** behind their pod (`TableGeometry.tuck`; the user's call,
   2026-09-27, reversing "keep the piles" on phones only): its backs peek
   `TUCK_PEEK_FRACTION` of a card past the pod's inner edge (a few px read
   as a sliver — 2026-09-28), the pod (opaque there) says the count, and the
   board keeps clear of exactly that peek (`tuckPeek`). On a landscape
   phone a TOP seat's hand does not peek down at all — it fans wider and
   shows at the pod's sides, because height is what that table lacks. A FACE-UP opponent hand — a showdown —
   is **shown** over the pod, upright. On a phone held upright, up to two
   seats per side stack HIGH, below the corner buttons, so the board gets
   the full width beneath them; the trick then offsets cards by the seat's
   EDGE (`rimVectors`), not the line to it, or the left player's card lands
   where the partner's goes. A face-up pile beside a side pod (LRC's chips)
   hangs off that edge too, two abreast — aimed at the board's centre, a
   corner seat's chips landed on the pod stacked below it. Where that pile
   would reach the dice (many seats, a side seat level with the middle) it
   hangs in the seat's own column BELOW its pod instead (`planPile`).
   **A chip pile becomes one stack with its count on top** past what its
   room shows one by one (`chipPileStacks`; the user's call, 2026-09-28):
   a phone's pot always, a seat's pile past three rows — or sooner, past the
   last row that keeps off the dice and the pot. Decided from the viewport,
   never the count, so a pile never changes shape as chips move. The count
   is chrome (`ChipStackCounts`), never a label on a piece: the top chip is
   the one that leaves.
4. **The stage** — everything inside the rim — and each board is **fitted**
   to it: `zoneScale` may now exceed 1, up to `stageCeiling`, the RENDER BOX
   (`pieceBox`). That ceiling is not taste: it is the base box every piece
   renders at, pieces are `will-change: transform`, and a piece drawn past
   its base box is an upscaled, blurred bitmap. `boardCamera` caps the domino
   unit at the render box's tile for the same reason. On a phone the render
   box IS the hand's card; on a laptop the hand is drawn smaller than it
   (`handArt`, `handCard` 96×134 inside a 118×165 box), so the board may
   outgrow the hand — the user found the hand, pods and opponents' cards the
   biggest things on a laptop table (2026-09-28). Anything measured as a
   fraction of "a card in your hand" uses `handArt`, never the base box.

On a short, wide board poker's chain runs **sideways** (`pokerRow`: flop,
pot badge, stub + burn in one row) and its betting panel takes the laptop's
one row; a card hand may **bleed** off the bottom (`handBleed`, the top
`HAND_PEEK` of each card — a tile hand never does, since a domino needs both
halves; `GameHost` tells them apart from the game's own `pieces()`).

`measure.test.ts` holds every game to its size targets through the same code
`npm run measure` prints. Every other layout test asks whether things
COLLIDE, and none of them could see a board drawn at half size — it
collides with nothing. `POD_SIZE` is measured, not guessed (it was 7–13px
short on every tier, which a tucked hand made visible), and
`geometry.test.ts` checks real pod boxes, not centre distances.

### Chrome is laid out, not positioned

The piece layer is the **one** absolutely positioned canvas. Everything
else — badges, turn cues, action bars, sheet headers — is ordinary
flex/grid flow inside as few geometry-anchored containers as possible.

A z-index bump is a symptom, not a fix: it means two things occupy the
same space and are being told who wins, instead of being laid out so
they never occupy it at all. [HandZone.tsx](src/table/HandZone.tsx) is
the worked example — one owner of the whole band above the hand, with
three **equal** `minmax(0, 1fr)` columns, because a `flex-1` centre
item centres in the space *left over* rather than in the row.

**The band's row is reserved; a panel is drawn over the felt.** The band has
three modes — `row` (readouts), `bar` (one row of actions), `panel` (a
decision bigger than a row: Spades' bid, Poker's betting). The surface
reserves the ROW (`ResolveOptions.bandZone`) and publishes it as
`geometry.band`, so nothing the table lays out sits under it. A panel is
NOT reserved (the user's call, 2026-09-28): it is temporary, and reserving
it re-laid the whole table out every time one opened — side seats jumping
up for a bid panel that never went near them. The table's geometry does not
change while a round is played. The one exception is a panel the viewer is
asked for on EVERY turn — Poker's betting (`panelReserve`,
`usePokerPanelReserve`): drawn over the felt, it covered the flop it was
asking about on a landscape phone, so its room is reserved ALWAYS, open or
not. Always, not while open, so that table does not move either. Every decision a game asks for goes in the
band. Nothing is positioned with a `calc()` against the hand any more
(`--hand-zone` is gone). Before a deal, with no cards to hold, a game may
centre the band over the empty hand strip too (`HandZone overHand`, Rummy's
"cards each" choice).

**The centre is fitted; it does not overflow.** Poker's community → pot →
stub chain and BS's reveal + pile draw at `geometry.zoneScale[zone]` — the
largest scale, up to the hand's card, at which each chain fits between the
top seats and the ring — down to a legible floor (`LEGIBLE_CARD_H`), and
only past that may they overhang. A side seat's fan compresses rather than reaching past
the ring. `layout.test.ts`'s band test holds every game, with the band it
really shows, to this at every `TABLE_VIEWPORTS` size.

**Toasts sit top left, below the corner buttons** (`toastLane(geometry)`, px
from the top — the user's call, 2026-09-28; bottom right before that, top
centre over the board before that). The Reconnecting pill keeps a lane of
its own (`statusLane`: centred, just below the lowest top pod).

**Pods say labelled numbers** (`SeatView.stats`, drawn by the shared
`Stats`), at most two lines under the name (`POD_LINES` — the geometry
sizes every pod for that). The viewer's own chip in the band uses the same
vocabulary.

### Compress-then-pan

A fan compresses as it grows, but only to a floor
(`MIN_DISCARD_STEP_FRACTION` 0.46 / `MIN_HAND_GAP_FRACTION` 0.38 —
separate constants precisely because they no longer share a value); past
that the overflow becomes a pannable range instead of ever-thinner
slivers. Opt-in per game via the store's `discardScroll`/`handScroll`
(`null` means "this game does not pan"), so every existing fan is
untouched. A game whose hand can outgrow the screen mounts
[HandPan](src/table/HandPan.tsx) (BS; Rummy wires its own, with the
discard).

**One tap picks a card where a tap only selects.** On touch, a hand tap
first previews and a second acts — the guard against a fat-fingered,
unrecoverable PLAY (Spades, Dominoes). Where the tap only toggles a
selection that a button then commits (Rummy's melds, BS's claim), the hand's
placements set `instantAct` and one tap selects; without it BS took two taps
per card and then the button (the user, 2026-09-28). A Dominoes tile that
fits BOTH ends sets it too: its tap only picks it up, and the ghost it then
offers is the second tap (three taps before). A pannable DISCARD pile shows
its newest card again whenever a card joins or leaves it — the player used
to drag it back after every turn. The gesture is [usePanZone](src/table/usePanZone.ts) —
coordinate-based at `document` level, never hit-tested, because a
pointerdown landing on a card never reaches a catcher beneath it. It
also takes the wheel, which is what a desktop player reaches for first;
`select-none` on the felt is what stops a mouse drag becoming a text
selection instead.

The pile assembly grows about a **centre line** (`pileAxis`, the side
seats' own mid-y), not down from the region's top edge — deck centre and
fan centre are the same line at every depth. Growing from an edge is
`flex-start` by another name: it looks right until the pile is deep.

**A panned fan has no clip — the pieces fade themselves.** Overflowing
its box is what makes a fan pannable, and there is no wrapper to put
`overflow: hidden` on (see the flat piece layer above). So `FanSlot`
returns a `visible` fraction that ramps to 0 across one piece-extent at
the boundary, and layout folds it into `opacity`. Two consequences:
`PieceLayer` refuses taps below `MIN_TAPPABLE_OPACITY`, or a faded card
is a live hit target under a seat pod; and any chrome positioned from
real piece coordinates (Rummy's `StagedRing`) has to be clipped to the
same region or it follows them out.

`TableGeometry.reserved` reports what `topZone`/`bottomZone`/`sideZone`
were actually granted. Size chrome from that, never from what you asked
for: a short landscape phone cannot always give up what a game requests.

### A short viewport has no budget to divide

Below `SHORT_VIEWPORT_H` (`isShortViewport`) there is no vertical room
left once the hand strip is paid for — landscape Rummy's hand + header +
bottom sheet left the table 86px tall. Two responses, and the split
matters:

- Every game gets **relief**: `resolveTable` caps the hand strip at what
  the cards need, and `handHeaderHeight` drops to 44. Spades, Dominoes
  and LRC then fit.
- Rummy, which has the most chrome, **declines to lay out** and asks the
  player to rotate. A side-rail layout for it was built, measured
  (86 → 223px, it does work) and scrapped as a second layout to maintain
  for a way nobody wants to hold a phone. It is in git if wanted.

### Menus are their own scroll container

`body` is `overflow: hidden` on both axes so the table can own its pan
gestures, which means a page taller than the viewport is *unreachable* —
the Rummy setup screen lost its bottom half on a short window. Setup
screens use [SetupShell](src/ui/primitives/SetupShell.tsx) and the home
screen the same shape: `h-svh overflow-y-auto` on the page, and `m-auto`
rather than `justify-center` for the centring, because a flex container
centres its overflow in *both* directions and puts the top out of reach.
`SetupShell`'s `footer` sticks the screen's primary action to the bottom
of that scroll container, so "Deal in" and a lobby's Start are never below
the fold.

### A game's options are data

Each game's setup — what it asks, in what order, with what ranges,
defaults and hints — is one spec in
[gameSetup.ts](src/session/gameSetup.ts) (`GAME_SETUPS`). `GameOptions`
draws it for the solo setup screen (`GameSetup`, one component for all
six) AND the lobby (`mode: "room"`, `locked` for everyone but the leader),
and the registry's `parse` clamps what arrives off the wire from the same
numbers. The three used to be written separately and had drifted — the
room played Rummy to 500 with no way to change it, offered LRC a
difficulty slider, and let Caribbean be set to three seats. Add an option
to the spec and all three follow. Defaults are the solo values everywhere
(the user's call).

## Shared UI primitives

Reach for these before writing a one-off — each replaced several copies:

- `Button` (cva: tone × size × shape) is the only button. `ChoiceGroup`
  is one-of-a-few (a game, a ruleset, privacy); `variant="tiles"` makes
  each option a picture over its words (the lobby's game picker).
  `GameThumb` / `seatRange` / `GAME_BLURBS` draw a game the same way on
  the home page and in the lobby. `Toggle` and the sliders
  are Base UI, restyled (`src/ui/base/`); a slider's owner hears only where
  a gesture ends (`useSliderDraft`), because in a room every change is a
  message.
- `locked` (shown, not changeable — anyone but a room's leader) is not
  `unavailable` (off, with its reason — Six love without partners).
- `Stats` (labelled numbers), `Avatar` (people, with a bot variant),
  `PieceStrip` (the app's motif), `Reveal` / `Swap` / `Collapse` (the only
  motion around the table: 150–250ms tweens, no springs).
- `EndGameAction` is a solo game's way out, at the foot of its Settings
  sheet (`GameHost` adds it wherever `onLobby` is given and the table is
  not a room's). Asked twice, because nothing is saved.
- Rooms: `RoomEntryForm` is the only way in (`home` / `invite` / `retry`);
  `RoomStatusScreen` is every in-between state; `InviteCard` is the code
  and the link (lobby and a table's Settings sheet). A room names a bot's
  seat through `nameForSeat(frame, seat)` — the solo table's bot name for
  it, never "Bot 3".

## Performance

Per-piece store subscriptions ([store.ts](src/table/store.ts)) are why
a 52-card deal is cheap: each `<Piece>` subscribes to
`placements[id]` alone, so moving one card re-renders one component.
With React context it would be 52×52 renders for one deal.

That only holds because [`reindex`](src/table/applyEvent.ts) preserves
object identity for placements whose numbers did not change. If you
change that function, keep the identity guarantee — it is tested.

**A one-shot flourish does not belong in the store.** The store is table
STATE, read during render and replaced wholesale at the end of every
batch by `onIdle`'s `reset(definition.placements(...))` — so anything a
game's own `placements()` does not re-derive is erased there. A slam is
an instantaneous "this happened" with nothing to reconcile, so it goes
through [fx.ts](src/table/fx.ts), a fifteen-line emitter, the same
fire-and-forget shape `announce`/sonner already uses from the same
`surfaceEvent` seam.

`PieceLayer` subscribes to it **once** and drives Motion imperatively
through a single `useAnimate`, reaching pieces by `[data-fx="<id>"]`
(each renders a plain wrapper div for it). One hook for the whole layer,
no per-piece subscription, and nothing re-renders when a slam fires.
`useAnimate` is also what makes a repeat work at all — an identical
declarative keyframe array is not guaranteed to replay.

## Reduced motion

`MotionConfig reducedMotion="user"` wraps the app
([MotionProvider.tsx](src/app/MotionProvider.tsx)) — Motion drops
transform and layout animations while keeping opacity and colour, which
pairs with the choreographer already collapsing its delays to zero.
Before that the CSS backstop in globals.css was the only guard, and it
only reaches `animation-duration`/`transition-duration`, never the
inline transforms Motion drives from JS. Anything animated
**imperatively** still needs its own `prefersReducedMotion()` gate;
MotionConfig governs motion components only.

## Layout of the source

Partnership games share `_shared/partnership.ts` — `partnerOf`/`teamOf`/
`teammates`, seats 0↔2 and 1↔3, partners across. Both Spades and
Caribbean dominoes' team mode sit on it, and both keep **scores per seat
but mirrored within a side**, so a seat's own number already is its
side's number and every downstream reader (the win check, standings, the
pods) works without knowing teams exist. A partnership game that scores
each ROUND also needs `roundWinningSeats`, or the crown lands on
whichever partner happened to play last.

```
src/
  engine/     pure TS, zero React — types, seeded RNG
  games/      _shared/ card+deck model; per-game rules go here
  table/      geometry, placement store, piece layer, seat ring
  motion/     choreographer (event timing) + presets
  ui/         primitives/ (faces), phases/ (round & game screens),
              disclosure/ (rail, toast, sheets) — see POLICY.md
  lab/        harness fixtures and chrome
  session/    transport-agnostic: the loop, redaction, rooms, the wire
  server/     Node only — never imported from src/app
  room/       the client: connection, lobby, per-game online tables
app/play/     lrc · dominoes · spades · rummy · poker
app/room/     the lobby and the online table
app/lab/      seats · motion · tokens · phases · rummy · redact
```

**In-game settings are shared.** A game's player preferences are a
`GameSetting[]` passed to `GameHost` as `settings`; the host appends
`TABLE_SETTINGS` (Sound, Vibration) to every table's list, shows one
Settings button and sheet, keeps the values per device
([gameSettings.tsx](src/table/gameSettings.tsx)), and passes them to the
table content as `children(live, settings)`. A `shared` setting (Sound,
Vibration) is kept once for the whole app, not per game. Add a setting to
a game by adding an entry to its list, never a per-game sheet.

- **Hints** (`hintsSetting`) is per game and means what the game says:
  Poker spells out its labels; Spades and Dominoes dim what cannot be
  played. Off by default (the user's call, 2026-09-26) — except Poker's,
  which a newcomer needs and would not know to turn on. The host syncs it into the store as `hintsShown`, and with it off
  `PieceLayer` ignores `dimmed` — the piece looks and taps like any other,
  and the game's tap handler says why it was refused (`whyNotPlayable` in
  Spades). Feedback AFTER a tap, never a hint before one.
- **An online table's room buttons** — Return to the lobby, and the
  leader's End game — are `menuActions` at the foot of the sheet
  (`TableMenu`), not on the table (the user's call, 2026-09-26).
- **The slam's sound and buzz** are `useSlamFeedback`
  ([slamFeedback.ts](src/table/slamFeedback.ts)), mounted by the host and
  gated by those two settings: a synthesised Web Audio thud (no file) and
  `navigator.vibrate`, both at IMPACT (`SLAM_LAND_MS`), not the wind-up.
  The audio context is resumed on the first tap or key, because browsers
  allow no sound before one; a slam before that is silent.

The dev panel also takes `scenarios` — labelled one-shot callbacks a game
supplies for states only reachable by waiting (Rummy's claim window opens
roughly once every twelve rounds). The panel knows nothing about what they
do, so no game's rig leaks into it.

The dev panel carries a **generic** state editor
([debugState.ts](src/table/debugState.ts)) that finds every pile of
piece ids in any game's state by matching against that game's own
declared `pieces()` vocabulary. Zero per-game code — use it to reach a
20-card hand or a 30-card pile instead of grinding out legal turns.

## Bot difficulty is a wired setting, not a decoration

Every game's setup screen offers `DifficultyPicker` (shared 3-stop
slider, each tier with a line of copy stating what actually changes — the
copy lives in the game's spec, `GAME_SETUPS[game].difficulty`) and passes
`botTable(seats, tier)` — one tier for the whole table — into
`GameRuntime.difficulty`. This used to default silently to `steady`
everywhere with nothing ever overriding it, so casual and sharp were
unreachable in every game at once. If a future difficulty-related report
comes in ("opponents feel the same regardless of setting"), check that
the setup screen is actually threading `difficulty` through before
touching the bots themselves — that exact silent no-op is what happened
here.

Not every game needs the control: LRC has none, because rolling is the
only legal action and the dice are random, so its tiers differ only in
pacing — a slider that changes nothing but reaction speed would promise
a difference the game doesn't have.

### A tier test has to be a match, not a diff

Proving the tiers *behave* differently proves nothing about which one
plays *better*, and the difference is not academic: measured for the
first time, poker's `sharp` won only 40% of heads-up matches against
`casual`, and Spades' `sharp` lost team matches to `steady` 10-24. Both
were real strategy bugs that no behavioural-difference test could see —
poker's `sharp` charged itself a positional penalty for completing the
small blind, which heads-up is the BUTTON; Spades' `sharp` ducked to
dodge bags even while the opponents were still short of their own
contract, politely helping them make it.

So all five games with a picker now own a head-to-head test asserting
`sharp > steady > casual` over whole matches, alternating seats so the
button/dealer advantage cannot decide it. Because every bot runs on a
seeded `Rng`, these are **exact, not statistical** — a win-rate
assertion on fixed seeds cannot flake. Re-run it after touching any
tier constant: several tunings that looked obviously right moved the
gradient the wrong way.

BS came through that audit clean and needed no fix, which is worth
recording rather than assuming — it was already the only game with a
quantitative gradient (`bluffPast`, measuring how often each tier
catches a pure liar). Note that a rate ordering on one behaviour and
"the sharper bot wins more" are different claims, and BS now asserts
both.

### Seats are not clones

`botTable(seats, tier)` hands every seat the same tier, so a table used
to be one strategy running five times — obviously artificial, and in
poker actively harmful, since identical thresholds on correlated reads
had two bots re-raising each other in lockstep.
[`_shared/botPersonality.ts`](src/games/_shared/botPersonality.ts)
gives each seat a small, stable offset *inside* its tier, derived from
`hashString` (the slam precedent) rather than an `Rng` — so a seed
replays personalities exactly, and nothing had to be threaded through
`BotStrategy.choose`'s fixed signature, which already receives `seat`.

### A bot read that isn't on the state isn't a read

`choose(state, seat, rng)` gets no history, so anything a human tracks
across a round has to be captured as it happens. Three public fields
exist only for this, and each is information every player at the table
already has (so `playerView` leaves all three alone):

- `PokerState.raisesThisStreet` — the fix for the all-in bug. Several
  raise sequences produce the same `lastRaiseSize`, so it cannot be
  inferred.
- `SpadesState.voids` — a seat failing to follow is permanent and
  public, but `won` is a flat unordered pile per seat, so after the
  trick it is genuinely unrecoverable.
- `DomState.passedEnds` — `passes` is a bare counter with no record of
  who passed on what, and a pass is the strongest read in dominoes.

### Poker strength is a probability, or it is nothing

Poker's bots scored hands on an invented 0..1 scale and compared it
against pot odds, which *is* a probability — two different units, so
the comparison could not work. The scales also disagreed with each
other (pocket aces preflop 0.95, a made full house 0.75), which is why
bots jammed preflop and would not bet a real hand later. Retuning those
constants was tried first and did not hold.
[`equity.ts`](src/games/poker/equity.ts) replaces them with real
seeded Monte Carlo equity — one honest number meaning the same thing on
every street. It carries its own fast 7-card evaluator for speed, kept
honest by a test asserting it orders 4000 random hands identically to
`hand.ts`'s canonical `compareHandValues`; preflop results memoise by
canonical shape (169 per opponent count), which is what makes the hot
path free.

## Conventions

- **Never call `Math.random()`** in engine or bot code. Everything goes
  through `createRng(seed)` so a game replays exactly from its seed.
- **Piece ids are stable for the whole game.** A changing id reads as
  "old piece destroyed, new piece created" and throws away the
  animation.
- **Read [src/ui/disclosure/POLICY.md](src/ui/disclosure/POLICY.md)
  before adding any panel, sheet or dialog.** Reference information
  never goes in a modal.
- Tailwind scans source statically — no interpolated class names
  (`bg-${x}`). Use the CSS variable instead.
- Design tokens live only in [globals.css](src/app/globals.css). The
  Claude Design canvas "Neo-Felt System" is the visual reference; if
  they disagree, the code is the truth.

## Adding a game

1. Implement `GameDefinition<S, A>` from
   [engine/types.ts](src/engine/types.ts) under `src/games/<id>/`.
2. Emit events from `reduce` for everything the table should show.
3. Provide `placements(state, viewer)` — the choreographer reconciles
   against it, so a missed event self-corrects instead of desyncing. It
   is also the authority for FACING: `projectEvents` corrects each
   event's `faceUp` against it per viewer, so `faceUp: seat === HERO` in
   a deal stays correct offline and online both.
4. Compose the existing phase shells; only the slot content is new.
5. Add bots per `BotDifficulty`. `thinkMs` is part of the feel, and a
   head-to-head test that the tiers really are ordered is not optional —
   see "A tier test has to be a match, not a diff" above.
