# Table Games — architecture

Web app hosting five table games, alone against bots or in a room with
other people: Dominoes (Block & Draw, and the Caribbean game), Spades,
Rummy 500, Poker (NL Hold'em), Left Right Center. Priority is UI/UX —
real-table motion, distinct phase screens, and Rummy's board information
shown without clutter.

**Status: all five games are real**, with full rules, bots and play
screens. Four of them — Spades, Poker, Dominoes and LRC — also run
online in a room. Rummy 500 is single-player only, and for a rules
reason rather than a wiring one (see `session/registry.ts`). The shared
layer is additionally exercised through `/lab`.

```
npm run dev      # server + app on one port: /play/rummy, /room, /lab/seats
npm run check    # typecheck + lint + test
npm run harness  # adversarial WebSocket scenarios (needs `npm run dev`)
npm run e2e      # several real browsers, one real server
```

`npm run dev` boots `server.ts`, not `next dev`: rooms are live objects
with timers and open sockets, so the app needs a process that stays up.
That rules out serverless deploys — it runs anywhere Node runs.

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

The pattern: each was found by doing the NEXT thing (a second game, a
real browser), not by more tests on the last one.

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
- Seat 1 is the hero's left; numbering runs anticlockwise, matching the
  direction turn order passes.
- Seats walk the perimeter of a rounded rectangle, **not an ellipse** —
  on a 9:19.5 phone an ellipse wastes the horizontal band, which is the
  only place a name and score fit.
- Edge allocation is a hand-tuned table per density tier, clamped to
  what actually fits, with a proportional fallback for counts beyond
  the table.

Three density tiers (`compact` / `regular` / `wide`) set piece sizes.
Width picks the tier but height can demote it — a 844×390 landscape
phone is wide enough for `wide` and far too short for it.

### Chrome is laid out, not positioned

The piece layer is the **one** absolutely positioned canvas. Everything
else — badges, turn cues, action bars, sheet headers — is ordinary
flex/grid flow inside as few geometry-anchored containers as possible.

A z-index bump is a symptom, not a fix: it means two things occupy the
same space and are being told who wins, instead of being laid out so
they never occupy it at all. [HandZone.tsx](src/table/HandZone.tsx) is
the worked example — one row owning the whole band above the hand, with
three **equal** `minmax(0, 1fr)` columns, because a `flex-1` centre
item centres in the space *left over* rather than in the row.

### Compress-then-pan

A fan compresses as it grows, but only to a floor
(`MIN_DISCARD_STEP_FRACTION` 0.46 / `MIN_HAND_GAP_FRACTION` 0.38 —
separate constants precisely because they no longer share a value); past
that the overflow becomes a pannable range instead of ever-thinner
slivers. Opt-in per game via the store's `discardScroll`/`handScroll`
(`null` means "this game does not pan"), so every existing fan is
untouched. The gesture is [usePanZone](src/table/usePanZone.ts) —
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
slider, each tier with a line of copy stating what actually changes) and
passes `botTable(seats, tier)` — one tier for the whole table — into
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
   against it, so a missed event self-corrects instead of desyncing.
4. Compose the existing phase shells; only the slot content is new.
5. Add bots per `BotDifficulty`. `thinkMs` is part of the feel.
