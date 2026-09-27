# Layout / UI / UX — issues for a dedicated pass

Collected during the online bug hunt (see `online-games-debug.md`) so they
can be fixed together in one PR instead of one screenshot at a time.
Newest first within each section. Sizes are CSS pixels.

**Test at these sizes.** Most of these only show on a laptop window, not a
tall desktop. `TABLE_VIEWPORTS` in `src/table/layout.test.ts` is the list:
the usual phone/desktop sizes plus 1917×977, 1536×730, 1366×650 and
2552×1227. A 1080p laptop's browser window is well under 900 tall.

## The pattern behind most of them

Several things in the middle of the table were placed relative to `play`,
which clears the seat pods but not the cards fanned out of them. On a tall
desktop there is room to spare; on a laptop they run into the top seats'
hands. The fix each time was to derive the zone from `pileRegion` (already
clear of pods and hands) and add a layout test across `TABLE_VIEWPORTS`.
**Do that for every centre zone, and for every overlay that sits over the
table**, instead of waiting for a screenshot.

## 2026-09-26 — Combined audit and proposal (reviewed; built — see 4.9)

One pass over every table, the home page, the six setup screens, the room
(entry form, lobby, online table) and the online flow around it: read,
audit in Chrome, research, propose. The user reviewed it the same day
(decisions in 4.8); it is being built on `feat/layout-ui-ux-pass`. It
extends the Open items below rather than repeating them, and says so where
it confirms one.

### How it was done

- **Sizes:** 390×844, 844×390, 768×1024, 1024×768, 1366×768, 1920×1080,
  plus 1366×650 for tables — what a 1366×768 laptop's browser window
  actually is.
- **Tables, offline**, from the dev panel: speed 4×, the scenarios
  (Dominoes "One tile from out", Rummy "Rummy! window") and the state
  editor (Rummy's stock run down to 1, BS's hand pushed to 40). Every
  game was taken to the hero's turn mid-round and to its round-end card.
- **Online**, with three identities: `localhost` (Ada), `127.0.0.1` (Bo)
  and an isolated browser context (Cy). Covered: make, join by code, the
  shared link, a private room (ask, deny), start, refresh mid-game, a
  forced network drop, the home page's Rejoin card, a second tab, leave.
- **Screenshots:** `docs/audit/2026-09-26/`, named
  `<screen>-<state>-<W>x<H>.jpeg` (136 files, 8.6 MB). `audit` is in
  `.gitignore`, so they stay local.
- **An overlap check** ran at each size in the final sweep: every chrome
  box (pods, panels, buttons, `HandZone` text, toasts) against every piece
  and every other chrome box. It cannot see a piece covering a piece
  (Rummy, below); those were checked by eye.
- **Testing gotcha:** switching Chrome's emulated mobile/touch flags
  RELOADS the page. That reload is how the leadership bug below turned up.
  Keep the flags fixed when stepping a live table through sizes, or an
  offline game restarts.

### (a) Findings per screen

#### Home (`app/page.tsx`, `HomeEntry.tsx`)
- 390×844: the form is above the fold; the six solo cards are one column,
  about 170px each — roughly 1000px of scrolling.
- **844×390: the whole first screen is the hero** (piece strip, title,
  paragraph). No control shows without scrolling.
- 768 and wider: fine. At 1366×768 the solo grid is wholly below the fold,
  which is the intended priority.
- Typing a full code does not change which button is primary: "Make a
  room" stays brass, "Join room" stays ghost — the steering that
  `RoomScreen`'s own form was fixed for.
- No `<form>`: Enter in the name field does nothing. A missing name shows
  its error on the name field while focus stays in the code field.
- The code field's first box wears a brass ring while the field is not
  focused, which reads as focus.
- The Rejoin card arrives after `/api/rejoin` answers and pushes the form
  down by its own height, and it is quieter than the brass "Make a room"
  below it, though rejoining is what that player came back to do.

#### Setup screens (all six `play/*/page.tsx`)
- One 320px column at every width. Column heights: Dominoes 933, Poker
  618, BS 547, Spades 536, Rummy 505, LRC 471. **"Deal in" is below the
  fold** for Dominoes at 390×844, 844×390, 1024×768 and 1366×768, and for
  all six at 844×390.
- Poker: "Players 6" and "Opponents Steady" are identical sliders one
  above the other, so "Opponents" reads as a count. The stack steps by 100
  up to 20,000.
- Dominoes' optional rules (three toggles) are always expanded — the
  longest screen, and the one a newcomer reads least of.
- No screen says more than one paragraph about how its game is played;
  there is nowhere to read the rules before sitting down.
- Hints look brighter than their labels — see R1.

#### Room entry, the shared link and the in-between screens (`RoomScreen.tsx`)
- "Connecting…", "Waiting to be let in", "Playing in another tab": one
  line, sometimes a paragraph and a button, on bare felt. "Connecting…"
  has no way back, and after a reload the lobby is replaced by it until the
  socket returns — no last-known room is kept on screen.
- The shared-link form (`/room/CODE`) says nothing about the room: whose
  it is, which game, how many are in.
- **Denied:** a 2.2s toast, then the invite form again — its copy says
  "You have been invited to a room" and its primary button asks again.
- **Leave room** lands on that same invite form, still at `/room/CODE`,
  under two toasts ("You left the room", "Ada left").

#### Lobby (`Lobby.tsx`, `Roster.tsx`)
- **A fresh room tells its maker "NO SEAT — Will watch — table full".**
  With no game picked `seatCount` is 0, so everyone is past the last seat.
  The seating paragraph, Shuffle and the drag grip show with nothing to
  seat.
- 390×844, a game picked: about 1300px tall, Start two screens down.
  1920×1080: a 448px column that still scrolls.
- The leader's order is code → roster → paragraph → Shuffle → game →
  options → Start → privacy/Leave. The seats depend on the game but come
  first.
- **Non-leaders are shown wrong rule values.** `Toggle` renders
  `checked && !disabled`, so a locked toggle shows OFF and `aria-checked`
  says false: the leader saw Teams and Key tile ON, Bo saw both OFF, above
  a roster with Team A/B chips.
- Non-leaders: Poker's starting-stack stepper is live (it has no
  `disabled`), and the difficulty slider never locks (`DifficultyPicker`
  has no prop for it). Both snap back when used.
- Non-leaders learn why Start is dim only from a `title` tooltip, which a
  phone never shows. Nothing says "Waiting for Ada to start".
- A join request gets a 2.2s toast ("Cy asked to join"); after that it is
  a card mid-page, below the roster. Deny is an `×` with no accessible
  name.
- The privacy control ("Anyone with the code") is a button that reads
  like a status label. Game chips expose no selected state.
- Copy copies the four letters, not the link; there is no Share.
- **The maker loses leadership on a refresh.** `setConnected(false)`
  calls `reassignLeader` at once (`session/room.ts`), with no grace and no
  notice; the maker comes back as a plain member, every control dim,
  nothing to say why. A host on a phone who switches to a messaging app to send the
  code is exactly who this catches.

#### Online table
- Refresh mid-game: back at the table promptly — the rejoin path renders
  well. The last LRC roll's dice are gone afterwards.
- Network drop: the "Reconnecting…" pill after about 1.2s, the table still
  readable, cleared on return. It sits on the top seat's pod (R4).
- Settings sheet: Sound, Vibration, "Return to the lobby"; End game for
  the leader. The room code is nowhere on the table.
- The Rejoin card, "Playing in another tab" and "Play here instead" work
  and read clearly.
- Online bots are "Bot 3", "Bot 4"… so every bot avatar reads "BO" — the
  same as a person called Bo. That fallback name is written out in seven
  files.
- Someone else's turn: the only cue is the brass glow on their pod.
- **Bug, verified:** Caribbean dominoes set to 3 seats in the lobby deals
  an invisible fourth player. The engine forces four hands
  (`dominoes/rules.ts`), but the lobby's Seats stepper and `selectGame`
  allow 2–4 whatever the mode, and the session starts with the room's 3.
  The table lays out three seats while "Bot 4 plays 6–4", its six tiles
  stacked in the top-left corner (`online-caribbean-3seats-bug-1920x1080`).

#### Dominoes
- The hero's pip count ("52 pips") is drawn by `BoneyardCount` under the
  boneyard zone — in Caribbean, an empty corner — at 10px, away from the
  hand.
- **Holding a tile**, the Cancel bar (`absolute bottom-0`, 56px tall)
  lands on the hand: on top of the tiles at 390×844, underneath them at
  844×390 and 1366×650, its label showing through. At 390×844 the lifted
  tile also covers the two-line "TAP WHERE IT GOES".
- 844×390: hand tiles about 205px tall in a 390px window, the chain in
  miniature.
- 1366×650: the chain snakes early and leaves the felt either side empty —
  the board camera's known limit. Noted only; the decision on record is to
  build a floor when it is reported.
- Round end: "+0" in green (R7).

#### Spades
- **The bid pad** (positioned from `--hand-zone`) covers the partner's pod
  entirely at 844×390, and overlaps the partner's cards by about 15px at
  1366×650. Clean at 390×844, 1024×768 and 1366×768.
- Pods say "bid 4 · 0" while bidding and "7 · won 0 · 0" in play — bid,
  tricks, score, none of them labelled.
- 1366×650: the hero's "Your bid: 2 · won 0" chip clips the bottom of the
  left seat's fan.
- The round card groups partners well but does not show how +92 or +60
  was reached (contract, bags, nil, a set).
- The two Jokers hints disagree, and neither is exact: solo says jokers
  are added, the lobby says they "replace the twos"; the engine swaps them
  for the 2♣ and 2♥ (`spades/cards.ts`).

#### Rummy
- **The top seat's hand covers the discard pile** at 1366×768, 1366×650
  and 1024×768: three of four cards hidden, the "20 in stock" badge on the
  same hand. Clear at 1920×1080. This is the Open item "The table's centre
  runs into the seats", now also on a tablet.
- Before the deal, "stock empty" sits on a full deck, and the chooser
  reads "Deal − 7 + Deal" with nothing saying 7 is cards each.
- The hero chip "You: 0 · +0 / −50" is unlabelled; the round card gives
  the same numbers as "+0 board · −145 held".
- The resting board sheet spends about 140px on "Nothing melded yet".
- Wide screens: the chip and "Smart" sit at the row's far ends, about
  500px from the hand.
- Meld rows scroll with the native Windows scrollbar, arrows and all.
- "BOARD · 1 MELDS". Totals print "-145" with a hyphen, deltas "−145".
- 844×390 shows the rotate notice (decided); a 22-card hand compresses,
  then pans, as designed.

#### LRC
- **Portrait (390×844 and 768×1024): the hero's chips sit across "YOUR
  TURN — ROLL"** — LRC's own `bottom-0` bar laid over the hero's chip spot.
- 844×390: the pot chip sits on the middle die. Clean at 1366×650 and up.
- No legend for the faces (• L C R), no count on the pot, no "You" by the
  hero's chips. (A seat with no chips reads "Out", which is right: it is
  out for the rest of the round, and chips pass over it.)

#### Poker
- **390×844, hero's turn: the stacked panel (about 290px) hides two of
  five opponents** (Mia, holding the dealer button, and Ada), the pot and
  the hand header ("To call", Hands). The flop shrinks to about 24px-wide
  cards.
- **844×390: the panel is taller than the room above the hand and runs
  off the top of the screen**; it covers the big blind's pod, and "You:
  $2000" and "Hands" cover the corner pods' text.
- 1366×650 cuts about 15px off the flop (the Open item's residue);
  1024×768 cuts the "Pot $73" pill in half; at every size the band's "To
  call $33" sits under the panel.
- The top pod's "bet $20" is clipped by that seat's own cards at 390×844.
- Showdown: the Open items (the card hides the board; "Round" for "hand").

#### BS
- The window bar reads well. "Kofi claimed one two" is awkward, and the
  toast says "Sam claims one aces".
- 40-card hand: slivers at 390×844, readable at 1366×650 (Open item).
- 1366×650: the pile card runs into the claim bar (Open item).
- The round card lists You first, not the winner.

### (b) Recurring issues — one fix each

| # | Issue | Seen in | Root cause |
|---|---|---|---|
| R1 | Muted text is the brightest text | setup hints, toggles, lobby, roster, `TableMenu`, home | `bone-100/300/500` are not in `@theme`, so Tailwind generates nothing and the text inherits `bone-50`. 44 uses in 16 files. |
| R2 | Hero controls collide with the hand, the centre or a pod | Dominoes, Spades, Poker, LRC, BS | Five bars and panels positioned against `--hand-zone` or `bottom-0` at `z-1800`, outside `HandZone`, with no height reserved. |
| R3 | Centre piles run into top seats' hands | Rummy, Poker, BS | The Open item's `pileRegion` minimum. Also seen at 1024×768 and 1366×768, neither of which is in `TABLE_VIEWPORTS`. |
| R4 | Toasts and the Reconnecting pill cover the top seat | every game, online too | Top centre at a fixed offset is where the top seat's pod is. |
| R5 | Numbers without labels | pods (Spades, Dominoes), hero chips (Rummy, Spades) | `SeatView.meta` is free text; each game abbreviates its own way. |
| R6 | Hero chips drift away from the hand on wide screens | Rummy, Poker, Spades | `HandZone` spans the hand zone's full width. |
| R7 | Scorecards: "+0" in green, no target, row order varies, "-" vs "−" | all six | `delta >= 0` counts as a win; no progress field; each game orders its rows. |
| R8 | One narrow column, primary action below the fold | setup ×6, lobby, entry | `SetupShell` has one layout. |
| R9 | Bare in-between screens | Connecting, pending, superseded, incompatible | `Centred` is a line of text. |
| R10 | Keyboard and screen-reader gaps | every button, chips, deny | No designed focus ring, no pressed state, an unnamed icon button. |
| R11 | Nothing moves outside the table | home, setup, room | See 2c. |
| R12 | Whose turn, when it is not yours | every game, worst online | A pod glow only. |

### 2b — Duplication audit (fixes in 4.4)

**1. Three forms for "who are you, and which room".** The home form
(`HomeEntry`), `/room` and the `/room/CODE` invite form (both
`RoomScreen`'s `Entry`) all take a name, then make or join.
- *Re-learned:* the heading, which button is loud, and the error wording
  ("…to play in a room" / "…to join a room"). An invitee who goes home to
  make their own room meets a third layout.
- *Drift in the code:* `Entry` re-sanitises the code with its own
  `cleanCode` and hard-codes 4 where `HomeEntry` uses `CODE_LENGTH`; only
  the room side shows refusals; only the invite form puts Join first.
- *Changes the experience:* yes — one name field, a primary button that
  follows what was typed, errors that stay put.

**2. Game options, solo vs the room — the biggest drift.** The lobby
rebuilds every game's options inline (`GamePicker`), apart from the solo
screens and from the registry's `parse`:

| Game | Solo | Room | What a player re-learns |
|---|---|---|---|
| Rummy | Play to 250 (100–1000, step 25) | 500, **no control** | a match twice as long, not changeable |
| LRC | 5 rounds; no difficulty | 3 rounds; a difficulty slider | a slider CLAUDE.md says LRC must not have |
| Poker | 2000 stack, 20 big blind (steps 100 and 2); "small blind is half" | 5000 and 50 (steps 500 and 10); no hint | different money and steps |
| Dominoes (Caribbean) | rules first; 4 players fixed; 10 games; Partners off; Key tile off; Six love needs Partners | Seats (2–4) before rules; 6 games, **no control**; Teams on; Key tile bonus on; Six love ungated | names, defaults, order — and the seat count that causes the bug above |
| Spades | "2 of spades ranks above Ace"; jokers "added" | "Two of spades high"; jokers "replace the twos" | two wordings of one rule, both inexact |
| BS | 3 rounds; 5s window | 3 rounds; 10s window | nothing unintended — the window is deliberate |
| Every game | difficulty "Opponents" or "Table", tier copy per game | "Bots filling empty seats", one tier copy for all | the copy `DifficultyPicker`'s doc says must be per game |

Also: "Players" slider solo, "Seats" stepper in the room; the room's rows
are label-left/stepper-right, the solo screens use `SetupField`.
*Changes the experience:* yes — the same game set up the same way with
the same defaults, alone or in a room, and non-leaders see real values.

**3. Six setup screens.** Each `play/*/page.tsx` has its own
`SetupScreen`: header, description, options, a hand-written "Deal in"
(one class string, six copies), "← Back". Option order differs
(difficulty before the target in Rummy and before the stakes in Poker,
after the target in BS, last in Dominoes), and difficulty is "Opponents"
in three games, "Table" in two.

**4. Buttons.** `Button` exists; beside it are Dominoes' and Spades'
`ActionButton` (two copies), Rummy's `BarButton`, `PhaseScreens`'
`PrimaryAction` and its two end-of-game buttons, and the six "Deal in"s.

**5. Picking one of a few.** Dominoes' rules/target buttons (tinted brass)
and the lobby's game and mode chips (solid brass): two treatments of one
control, neither a radio group.

**6. "Disabled" means two things.** In solo setup it means *not available
under these settings* (Six love without partners — shown off, correctly).
In the lobby it means *not yours to change* — shown off, wrongly.

**7. Avatars.** `Roster.Avatar` was lifted so it would not be copied a
fourth time; `SeatRing`, the scorecard rows and the standings still draw
their own.

**8. Floating status.** `TurnIndicator` and `HeroStatusBadge` each keep a
positioned mode (`calc(var(--hand-zone) + …)`) beside the inline one
`HandZone` uses — the pattern `HandZone`'s doc says it replaced.

### 2c — Motion audit (approach in 4.5)

Outside the table, only the roster's drag uses Motion. Home, setup and
room use CSS `transition-colors` in six places and two hover nudges; no
`AnimatePresence` anywhere. Inside the table `TRANSITIONS.ui` (200ms,
ease-out) is used 28 times, and it is already the right feel.

| Screen / moment | Today | Proposed |
|---|---|---|
| Route change (home → setup → table) | instant | fade and an 8px rise on enter, 200ms |
| `RoomScreen` state (connecting → entry → lobby → table) | instant swap | cross-fade, 150ms out / 200ms in |
| Rejoin card arriving | pops in, pushes the form | space reserved; fade in |
| Form errors (name, code, refused) | pop | height and fade, 150ms |
| Roster rows joining or leaving | pop | fade and layout, 200ms |
| A join request | pops mid-page | slides in at the top of the Table panel, 200ms |
| Game options when the game changes | instant swap | cross-fade, 150ms |
| Caribbean's extra toggles | pop | height and fade |
| Reconnecting pill | pops after 1.2s | fade, 150ms |
| Waiting states | static text | a slow opacity pulse — with its own `exit` transition, because a `repeat: Infinity` transition otherwise governs the exit too and `AnimatePresence` never unmounts it |
| Game-end winner avatar | spring 220/18, which overshoots | the UI tween, like everything else |

### Research (sources at the end of this section)

- **Durations.** NN/g: 100–500ms, most UI 100–400ms; under 100ms reads as
  instant, 500ms as a drag. Material 3 keeps "short" durations for small
  utility transitions and pairs emphasized easing with entering. The
  existing 200ms and `ease-out-quint` sit in the middle of both.
- **One default.** Motion's `MotionConfig` accepts a fallback `transition`
  for every child `motion` component, beside the `reducedMotion="user"`
  the app already sets.
- **View transitions.** React 19.3 (9 Sep 2026) made `<ViewTransition>`
  stable; it animates only Transition-marked updates, and Next enables it
  with `experimental.viewTransition`. The app is on React 19.2.8.
- **60/30/10.** Dominant 60% (backgrounds), secondary 30% (surfaces,
  text), accent 10% — "where the action is".
- **shadcn/ui** supports Tailwind v4 and React 19, copies components into
  the repo through its CLI, and since July 2026 defaults to Base UI; Radix
  "is not being deprecated".
- **Aceternity UI** is a copy-paste collection of 200+ Tailwind + Motion
  components — backgrounds, 3D cards, text effects — aimed at marketing
  and landing pages. It needs `motion`, `clsx` and `tailwind-merge`, all
  already installed.
- **Sharing.** The Web Share API needs a secure context and a user
  gesture and is not Baseline: an addition to Copy, never a replacement.
- **Bottom sheets** (NN/g): for temporary, dismissible detail, not for
  controls that are always needed.
- **Focus.** WCAG 2.2 SC 2.4.11 (AA): focus must not be entirely hidden;
  2.4.13 describes a visible indicator. Browser defaults often fall short.
- **Toasts.** Sonner's `offset` and `mobileOffset` take per-edge values.
- **Zoom.** `maximum-scale` below 5 fails the axe/Lighthouse
  "meta-viewport" rule; the root layout sets 1 for every page.

### 4 — Proposal

Every item defaults to a shared, responsive fix; where one stays bespoke,
it says why. **Bug** marks what is wrong rather than a design choice.

#### 4.1 Shared table-layer fixes

**T1. One action band above the hand (R2).** `HandZone` already owns the
row above the hand. Give it a third mode:
- `row` — ambient readouts (today's three columns);
- `bar` — one row of contextual actions (today's);
- **`panel`** — a decision that needs more than one row (Spades' bid,
  Poker's betting). Its *measured* height goes to `resolveTable` as part of
  `bottomZone`, so the centre lays out in what is left
  (`TableGeometry.reserved` is there for this). The band's width comes
  from the hand zone, which the reserved height does not change, so one
  measurement settles it rather than looping.

Then move in: Dominoes' Draw/Pass/Cancel, Spades' bid pad, exchange bar
and blind-vote note, Poker's panel, LRC's Roll; BS is already there.
Delete the positioned modes of `TurnIndicator` and `HeroStatusBadge`.
What is left positioned on a table is the pods (anchored to seats), the
band (anchored to the hand) and overlays (sheets, toasts). *Test:* a band
of each game's measured height reserves its space — no centre piece or
pod intersects it at any `TABLE_VIEWPORTS` size.

**T2. The centre fits what the band leaves (R3).** Build the Open item's
central fix ("Pieces shrink, the region does not grow", one test for every
game's centre). Add 768×1024, 1024×768 and 1366×768 to `TABLE_VIEWPORTS`;
Rummy's overlap reproduces at two of them.

**T3. A toast lane (R4).** `GameToaster` reads the geometry and sets
`offset.top` / `mobileOffset.top` to just below the lowest top-edge pod,
so a toast lands between the top seat and the centre. The Reconnecting
pill uses the same lane. Toasts stay a transient overlay, as POLICY.md
has them; they just stop landing on a person.

**T4. Labelled numbers (R5).** `SeatView.meta` becomes
`stats: { label, value }[]`, drawn by `SeatRing` in one style (label
bone-400, value bone-50, the second line truncates). Each game states its
vocabulary once and uses it in three places — pod, hero chip, round card:
"Bid 7 · Won 2", "Board +20 · Held −10", "Pips 22". This also closes the
Open item "Pod text that can outgrow a pod".

**T5. The band hugs the hand (R6).** Cap `HandZone`'s width at the fanned
hand plus its side chips (about 48rem at most), centred, so "You: …",
"Smart" and "Hands" sit beside the cards on a wide screen and clear the
corner pods in landscape (Poker at 844×390).

**T6. Scorecards (R7)**, all in `PhaseScreens`: a zero delta in bone-400;
a progress line under the title ("First to 10 · Mia 1"); rows ordered by
total, You highlighted; a real minus in `AnimatedNumber`. With the two
Open items: a per-game round noun ("Hand" for poker), and a *Look at the
table* toggle that lowers the card to a strip, as `PeekRail` does, so a
showdown's board can be read.

**T7. Whose turn (R12).** On someone else's turn, the band's centre says
so in bone-400: "Mia is thinking…" for a bot, "Waiting for Ada" for a
person. It names who, never what they can do — no hand-holding. A
spectator sees the same line.

**T8. One avatar.** `Roster.Avatar` in pods, scorecards and standings,
with a bot variant showing the bot glyph the lobby already uses. Online
bots take their names from `botIdentity` through one `nameForSeat(frame)`
instead of seven copies of `Bot ${seat + 1}`.

**T9. The dev panel starts collapsed** (Open item "Offline dev chrome").

#### 4.2 Per-game fixes

Most of each game's list is T1–T6 landing; this is the rest.

- **Dominoes.** Draw/Pass/Cancel go into the band (T1). Pips move to the
  band's left cell ("Pips 22"); `BoneyardCount` keeps only "N to draw",
  beside the boneyard. The selected tile's lift is clamped to the hand's
  own zone, so it never covers the band. Short viewports shrink hand tiles
  (the short-viewport "relief" rule), so the board is not a miniature.
  The board camera: nothing — the decision on record stands.
- **Spades.** The bid pad becomes the band's `panel`; on short viewports,
  one row (`− 3 +` · Bid 3 · Nil). Pod stats labelled (T4). A round-card
  breakdown through the existing `note` ("Contract 9: +90 · 2 bags: +2",
  "Nil made: +100"). One exact jokers hint: "Adds a Big and a Little Joker
  above every spade; the 2♣ and 2♥ come out."
- **Rummy.** T2 is the discard's fix. The hero chip in the round card's
  words ("Score 0 · Board +0 · Held −45"). No stock badge before the deal;
  the chooser reads "Cards each 7" / "Deal 7". "1 MELD". Meld rows get a
  thin styled scrollbar or `PanSurface`'s fade edges. *Optional, with a
  cost:* rest an empty board sheet at header height — the table would
  reflow once, when the first meld lands.
- **LRC.** Roll and the turn label go into the band, with the hero's chips
  laid out above it (T1). Dice and pot become one vertical chain in the
  centre (Poker's community → pot recipe) instead of two things on `cy`.
  A count on the pot; "You · 3" in the band.
- **Poker.** Betting becomes the band's `panel` (T1). On phones, a compact
  band: one row of Fold · Call $X · Raise…, the four tiles folded into one
  line ("To call $20 · Pot $30 · Ace high"), and raise sizing expanding in
  place only after Raise is tapped. The band's "To call" and the panel's
  "Current bet" say one thing twice — keep one. The stub gets its own zone
  in the chain (Open item). A seat's bet shows as a chip badge on the pod's
  table side, so a three-line pod is not clipped by its own cards.
  *Bespoke by nature:* the content is poker's; the band is shared.
- **BS.** Pile and reveal inside what the band leaves (T2; Open item).
  Big hands: the Open item's plan stands. Copy uses numerals and plurals
  ("one 2", "two 7s"), which also fixes "one aces".

#### 4.3 Home, room, lobby and the online flow

- **H1. Home.** A `short:` variant (`@custom-variant`, max-height 560px —
  the same line as `SHORT_VIEWPORT_H`) collapses the hero on landscape
  phones, so "Play together" is in the first screen. On phones the solo
  list becomes a two-column grid of compact tiles (thumbnail, name,
  players; the blurb from `sm` up). Real forms; the primary button follows
  the input (a full code makes Join primary); focus goes to the first
  invalid field; the code's ring only when focused. When the Rejoin card
  is there it is the primary action, first in the panel, its space
  reserved.
- **H2. One entry form** — C1 below.
- **H3. One status screen** for every in-between state: felt, a piece
  motif, a title, one line, one action, and always a way home. After a
  reload, keep the last-known room on screen, dimmed, under the
  Reconnecting pill, rather than a blank "Connecting…" (*cost:* caching
  the room view in `sessionStorage`; can come later).
- **H4. Lobby** — the Open item "room pages look plain", made specific:
  - an **invite card** on top: the code, large; Copy link (the
    `/room/CODE` URL, not the letters); Share where `navigator.share`
    exists;
  - on wide screens, **two panels**: *Game* (chips + `GameOptions`) and
    *Table* (the seating plan, and the round-table picture from the Open
    item); on phones, Game first, and once chosen it folds to a summary
    row ("Spades · Jokers off · Bots Steady — Change");
  - a **sticky footer** at every size: a status line, Start, Leave. The
    status line says what Start is waiting for: "Pick a game", "Waiting
    for 1 more person", "Ada is choosing a game", "Waiting for Ada to
    start";
  - **Bug:** a fresh room says "Pick a game to set up the seats" in the
    Table panel, not "No seat — table full"; Shuffle and the paragraph
    wait for a game;
  - **Bug:** locked controls show their real values (C4), under one line
    at the top of the Game panel: "Only Ada can change these";
  - join requests keep their toast and pin to the top of the Table panel;
    deny gets a name ("Turn away") — **Bug** today;
  - privacy as a labelled choice: *Who can join — Anyone with the code /
    Only people I let in*.
- **H5. Leadership on a refresh — dropped.** Proposed a grace period
  before handing it on; the user's call: the current behaviour is fine.
  H4's status line ("Only Bo can change these") still tells a former
  leader who leads now.
- **H6. Refusals and leaving.** A refusal stays on the form ("Ada didn't
  let you in. Ask again, or make your own room."), not a toast over an
  invitation. Leave room goes home.
- **H7. The table's Settings sheet shows the room code**, with Copy link
  and Share, so someone can be invited mid-game.
- **H8. Invite preview** (optional, last): the shared link shows "Ada's
  room · Spades · 2 of 4 seats" from a read-only `GET` beside
  `/api/rejoin`, which creates nothing. The user: fine, not necessary.

#### 4.4 Duplication / consolidation

- **C1. `RoomEntryForm`** — one component, `mode: "home" | "invite" |
  "retry"`. Shared: the name field and its copy, `CodeInput` as the only
  sanitiser (`cleanCode` goes), `CODE_LENGTH`, a real form, an error slot
  that stays. `home`: make or join, the primary follows the code.
  `invite`: the code fixed from the URL, Join primary, making your own a
  link. `retry`: after a refusal or "no such room", with the reason. The
  `entry.ts` hand-off is unchanged.
- **C2. `GameOptions` from one spec — the heart of 2b.** Each registry
  entry gains `options: OptionSpec[]`: `seats | stepper | choice | toggle
  | difficulty`, each with `label`, `hint`, `min/max/step`, `default`, and
  `enabledWhen` / `visibleWhen` for the few couplings (Six love needs
  Partners; Caribbean fixes 4 seats; LRC has no difficulty). One renderer,
  `<GameOptions game mode="solo" | "room" locked />`, serves the solo
  screens and the lobby, and **`parse` clamps from the same spec**, so the
  UI and the server cannot disagree on a range or a default again — which
  is exactly what produced the 3-seat Caribbean bug. Mode is a parameter
  where a difference is deliberate (BS's window, 5s solo and 10s in a
  room). The per-game difficulty copy lives in the spec. *Why a spec
  rather than a component per game:* the registry already owns seats,
  defaults and parsing for rooms; putting the options there too keeps one
  source, and Dominoes' couplings fit in two predicates.
  *Also:* `selectGame` and `startGame` clamp seats to the created
  definition's own `minSeats`/`maxSeats`, which for Caribbean are 4 —
  belt and braces for the bug.
- **C3. `GameSetup`** replaces the six `SetupScreen`s: `SetupShell`,
  header, `GameOptions`, a sticky "Deal in", a "How to play" link (a rules
  sheet per game — reference information, rung 5), and Back. Wide screens
  set the options in two columns; Dominoes' optional rules fold behind one
  row that summarises them ("Optional rules · Partners off · Key tile off
  · Six love off").
- **C4. Locked vs unavailable.** `Toggle`, `NumberStepper`,
  `DifficultyPicker` and the choice control take `locked` (the real value,
  dimmed, read-only) separately from `unavailable` (off, with its reason).
  The **bug fix** for the non-leader view.
- **C5. `Button` is the only button**, built with `cva` (already a
  dependency): tone × size × shape, plus the focus ring. `ActionButton`
  ×2, `BarButton`, `PrimaryAction`, the end-of-game pair and the six "Deal
  in"s become it; `CountdownButton` wraps it.
- **C6. `ChoiceGroup`** — a radio group (`role="radiogroup"`,
  `aria-checked`) in one treatment, for Dominoes' rules and target, the
  lobby's game picker and privacy.
- **C7.** One `Avatar` (T8). **C8.** The positioned modes of
  `TurnIndicator`/`HeroStatusBadge` go once T1 lands. **C9.** One
  `RoomStatusScreen` (H3). **C10.** One `nameForSeat(frame)` (T8).

#### 4.5 Motion approach

- **Tokens in one place.** `presets.ts` gains a small UI scale —
  `ui.fast 0.15`, `ui.base 0.2`, `ui.slow 0.25` — with `EASE_OUT_QUINT`
  for entering and a plain ease-in for leaving; `globals.css` mirrors them
  as `--duration-ui-*` for CSS transitions. No springs, no overshoot.
- **One default.** `MotionProvider` passes `transition={TRANSITIONS.ui}`
  to `MotionConfig`, so a motion component without its own transition
  gets the UI feel. In-game components keep theirs.
- **Four shared primitives** in `src/ui/motion/`: `Reveal` (fade and an
  8px rise on mount), `Swap` (`AnimatePresence mode="wait"`, keyed
  cross-fade), `Collapse` (height and fade), and enter/exit for list items.
  Every row of the 2c table uses these; nothing is one-off.
- **Routes.** `app/template.tsx` wraps each page in `Reveal` — enter only,
  because the App Router unmounts at once. `RoomScreen`'s branches go in a
  `Swap`. `<ViewTransition>` can give true cross-route transitions after a
  move to React 19.3 — not worth that upgrade for this alone.
- **Rules carried over.** Reduced motion is already covered
  (`reducedMotion="user"` plus the CSS backstop). Any repeating waiting
  animation gets its own `exit` transition. Nothing tied to the table's
  geometry animates as chrome.

#### 4.6 Visual direction

- **Bug, first:** add `bone-100`, `bone-300` and `bone-500` to `@theme`
  (the steps the code already assumes), and a test that every
  `(felt|brass|bone)-N` class used under `src` is defined in
  `globals.css`.
- **60/30/10 on Neo-Felt**, which is already close: 60% felt (surfaces),
  30% bone (text, panels at 4–12% bone-50, card faces), 10% brass. Where
  it leaks: brass also paints readouts — stepper values, hero chips, pip
  counts. Keep brass for the one primary action in a view, the selection
  and the turn cue (`globals.css` already says brass means "you chose
  this"), and put readouts in bone.
- **Role tokens over the palette:** `surface`, `surface-raised`,
  `border`, `text`, `text-muted`, `text-subtle`, `accent`, `accent-fg`,
  `danger`, `focus`. Components use roles; the palette stays the source. A
  few names, all defined, so R1's kind of bug cannot recur.
- **Focus:** a 2px `focus`-coloured ring with a felt offset on every
  interactive primitive, through `:focus-visible`.
- **Component libraries — the recommendation:**
  - **shadcn/ui: borrow, don't adopt.** The stack already matches it
    (Tailwind v4, React 19, `cva`, `clsx`, `tailwind-merge`, lucide,
    sonner, vaul), and it copies code into the repo, so there is no
    lock-in. But its look would be restyled to Neo-Felt anyway, and the
    table chrome stays custom whatever happens. Take its conventions —
    `cva` variants, a `cn()` helper, `data-slot` — for our primitives. If
    you want the accessibility work done for us, pull its Switch, Toggle
    Group and Slider (on Base UI, its default now), restyled: one new
    headless dependency (Q7).
  - **Aceternity UI: no.** Its components are made to draw the eye
    (beams, spotlights, 3D cards) — the opposite of the brief for these
    screens — and everything it depends on is already installed, so it
    would add effects, not capability. At most one restrained idea for the
    home hero, if wanted.
- **Zoom:** take `maximumScale: 1` off the root layout. The felt's
  `touch-action: none` already stops pinch on the table; home, setup and
  the lobby should zoom. Check on a real phone first.

#### 4.7 Build order (Step 5)

1. **Branch** `feat/layout-ui-ux-pass`, off
   `feat/room-entry-settings-and-slam-sound` (decision 6).
2. Bugs: the 3-seat Caribbean deal (C2's clamp); the bone shades and their
   guard test; `locked` for Toggle, stepper and picker; the fresh-room
   seats; deny's name; copy slips ("1 MELDS", "one aces", the jokers
   hints, the metadata description that leaves out BS).
3. Primitives: `Button` with `cva`, the focus ring, `ChoiceGroup`, role
   tokens, the motion tokens and the `MotionConfig` default.
4. `GameOptions` spec → `GameSetup` → the lobby's Game panel; then
   `RoomEntryForm` and `RoomStatusScreen`.
5. Tables: the action band (T1), the centre (T2) with the new viewports,
   the toast lane, labelled stats, scorecards.
6. The per-game rest (4.2), the lobby layout (H4), home (H1), motion.

Each fix verified live at the sizes it targets, and `npm run check`.

#### 4.8 Decisions (the user, 2026-09-26)

1. **Hints default: off** — for the dimming meaning (Spades, Dominoes).
   Poker's Hints spells out its button labels, which the user wanted
   unambiguous for a newcomer, so it stays on.
2. **Leadership: unchanged** — hand it on at once, as now (H5 dropped).
3. **Defaults: the solo values everywhere** — Rummy to 250, LRC first to
   5, Poker 2000 chips with a 20 big blind, Caribbean to 10 games with
   Partners and Key tile off. BS's window stays 5s solo, 10s in a room.
4. **Invite preview**: fine, not necessary — last, if at all.
5. **LRC's "Out"**: stays — a seat is out for the rest of the round.
6. **Branch**: off `feat/room-entry-settings-and-slam-sound`.
7. **shadcn/Base UI primitives**: yes.
8. **Poker's compact phone band**: yes.

**Sources:**
[NN/g — animation duration](https://www.nngroup.com/articles/animation-duration/) ·
[Material 3 — easing and duration](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs) ·
[Motion — MotionConfig](https://motion.dev/docs/react-motion-config) ·
[React 19.3](https://react.dev/blog/2026/09/09/react-19-3) ·
[Next.js — view transitions](https://nextjs.org/docs/app/guides/view-transitions) ·
[LogRocket — 60-30-10](https://blog.logrocket.com/ux-design/60-30-10-rule/) ·
[UX Planet — 60-30-10](https://uxplanet.org/the-60-30-10-rule-a-foolproof-way-to-choose-colors-for-your-ui-design-d15625e56d25) ·
[shadcn/ui — Tailwind v4](https://ui.shadcn.com/docs/tailwind-v4) ·
[shadcn/ui — Base UI default](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default) ·
[Aceternity UI](https://ui.aceternity.com/) ·
[Aceternity — utilities](https://ui.aceternity.com/docs/add-utilities) ·
[MDN — Web Share API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API) ·
[NN/g — bottom sheets](https://www.nngroup.com/articles/bottom-sheet/) ·
[W3C — SC 2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum) ·
[W3C — SC 2.4.13](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html) ·
[Sonner — Toaster](https://sonner.emilkowal.ski/toaster) ·
[Deque — meta-viewport](https://dequeuniversity.com/rules/axe/4.1/meta-viewport)

#### 4.9 Built (Step 5, `feat/layout-ui-ux-pass`, 2026-09-26/27)

Each verified live at the sizes it targets, and `npm run check` green
throughout (1092 tests at the end).

| Commit | What |
|---|---|
| `d547abf` | The audit's bugs: undefined bone shades (+ guard test), the 3-seat Caribbean deal, locked rules shown as off, the fresh room's seats, deny's name, copy slips. |
| `84ef52c` | Primitives on Base UI (Switch, Toggle Group, Slider), `Button` on `cva`, `ChoiceGroup`, role tokens, UI motion tokens and `Reveal`/`Swap`/`Collapse`. |
| `0dbbf90` | C2/C3: one options spec per game (`GAME_SETUPS`), `GameOptions` for solo and lobby, `parse` clamping from it, one `GameSetup` for all six; sliders commit on gesture end. |
| `3ade933` | C1/H2/H3/H6: `RoomEntryForm`, `RoomStatusScreen`, refusals on the form, leaving goes home. |
| `7468a89` | T1/T2/T5: the band above the hand reserved and measured (row / bar / panel), Poker's folded phone panel, Spades' one-row short bid, centre chains that shrink (`zoneScale`), the band test at every viewport (+ both tablets and 1366×768). |
| `0e0d1bb` | T3/T4/T9: toast lane, labelled pod stats (`Stats`), dev panel folded. |
| `b6fcb86` | T7: whose turn it is, when it is not yours; pods sized for two stat lines. |
| `851551d` | T6: progress line, rows by total, the viewer highlighted, "Hand" for poker, *Look at the table*. |
| `dcbda62` | T8: one `Avatar`; online bots named by `nameForSeat`. |
| `d089b94` | H4/H7: the lobby as invite, Game and Table panels, and a sticky footer that says what Start waits for; the invite in a table's Settings sheet. |
| `21d7a18` | H1: the `short:` variant, compact solo tiles, the Rejoin card as the primary action. |
| `90441b6` | 4.5: route entrances, collapsing errors and rules, list entrances, the options cross-fade, the Reconnecting fade. |
| `6163961` | LRC: dice and pot as one chain, the pot counted. |
| `bc67133` | Spades' score parts on the round card, Rummy's deal wording and stock badge, a domino's lift inside its strip. |

**Deliberately not built** (each a decision, not an oversight):
- C3's *How to play* rules sheet, and folding Dominoes' optional rules on
  the solo screen (the lobby folds its whole Game panel instead).
- H3's last-known room kept on screen after a reload (needs a
  `sessionStorage` cache of the room view — "can come later").
- H8, the invite preview (the user: fine, not necessary).
- 4.2 Dominoes: shrinking hand tiles on short viewports.
- 4.5's global `MotionConfig` transition: in-game motion sets its own, and a
  default would change pieces nobody meant to touch.
- 4.6: `maximumScale: 1` is still on the root layout — take it off only
  after a check on a real phone (pinch on the felt must stay dead).
- T8's bot glyph is on the lobby's bot rows only; a room's bot pods carry
  the solo table's bot names instead.

**Open question — Poker at laptop heights.** At 1366×650 with the betting
bar up, the `wide` density's hand strip (221px) and pods leave Poker's
centre about 26px of height, so its chain reaches the legible floor and
the stub and burn piles overhang the band (allowed by the rule above, and
better than the old panel over the flop — but not good). The candidate fix
is density, not layout: demote to `regular` below roughly 720px tall
(computed from the geometry, not yet seen live: the community cards would
draw 72px tall at 0.93 of `regular` size, against 40px — the floor — at
`wide`). It shrinks every game's pieces on
those laptops, so it is the user's call.

## Open

### The room pages look plain next to the home page
**Resolved** — `d089b94` (H4).
Reported 2026-09-26. The home page has a hero, the piece strip, a
panelled "Play together" card and the game grid. The room's own screens —
the lobby at `/room/[code]`, the entry form a shared link lands on, and
"Connecting…" / "Waiting to be let in" — are a single narrow column of
controls on bare felt (`SetupShell` / `Centred` in `RoomScreen.tsx`).
Ideas for the pass, none built:
- Give the lobby the home page's panel treatment: the code as a hero in its
  own card, the roster and the game picker as two panels side by side on
  wide screens, a thumbnail per game (the home page's `THUMBS`).
- Show the seating as a small table diagram — who sits where, round the
  table — beside the draggable list. The list already says "clockwise" in
  words, with seat numbers and team chips; a picture would show it.
- The in-between screens (Connecting, Making your room, Joining ABCD,
  Waiting to be let in) could reuse the table's felt and a piece or two
  rather than a lone line of text.

### The table's centre runs into the seats — fix it ONCE, centrally
**Resolved** — `7468a89` (T2: `zoneScale`, and the band test over every game and viewport).
The user has reported this in nearly every game: Spades' trick, Poker's
board and betting panel, and now Rummy's piles. Each got its own fix,
one screenshot at a time. It needs one shared fix, plus a check of each
game's own centre.

**Rummy, reported 2026-09-25** (4 seats, board sheet resting): the stock
and discard sit under the top seat's hand, and the "15 in stock" badge
sits on it. The window was 1905×988 in screenshot pixels, probably
1524×790 CSS at 125% Windows scaling. Measured with `resolveTable` +
`layoutPiece`, with Rummy's `bottomZone` (hand header + `SHEET_PEEK_H`):

| Viewport | `pileRegion` y | Minimum used? | Top hand's bottom | Deck's top | Overlap |
|---|---|---|---|---|---|
| 1524×790 | 177–331 | yes | 200 | 148 | 52px |
| 1536×730 | 152–306 | yes | 200 | 123 | 77px |
| 1366×650 | 152–306 | yes | 200 | 123 | 77px |
| 1440×900 | 216–402 | no | 200 | 203 | clear (3px) |
| 1905×988 | 216–490 | no | 200 | 247 | clear |

**Root cause (shared).** `pileRegion` in `geometry.ts` is computed
correctly: it clears the pods and the fanned hands. Then a MINIMUM is
applied (`floorH = card.h × 1.2`, `floorW = two cards`), and when the
room left is smaller, the region grows equally up and down, straight
into the top seat's cards and the bottom sheet. The code says this is on
purpose: "a pile that cannot be drawn is worse than one sitting a little
close". That was a phone-landscape answer, but on a laptop with Rummy's
board sheet the minimum is met on ordinary windows. The layout test that
guards the pile ("keeps a clear gap between the pile and every opponent's
own cards") SKIPS every viewport where the minimum was used, so the
failing case is the one case not tested.

Each centre zone also sizes its pieces on its own: the Spades trick and
Poker's board scale down to fit `pileRegion`, but Rummy's deck and
discard (`pileAssembly`) and BS's `pile`/`reveal` draw full-size cards
and rely on that minimum. Poker's betting panel is a centre item placed
from the hand zone with no reserved space.

**The central fix, proposed:**
1. **Pieces shrink, the region does not grow.** Keep `pileRegion` at what
   the clearances leave. Give `TableGeometry` one `centreScale` (≤ 1):
   the largest scale at which each game's centre content fits the
   region. Every centre zone (deck, discard, trick, community, pot,
   stub, pile, reveal) draws at that scale. Allow a region smaller than
   the minimum only below a real legibility limit (a card under ~40px
   tall), and only on the short-phone path (`isShortViewport`), which
   already has its own rules.
2. **Chrome over the centre is reserved, not laid on top.** Poker's
   betting panel and Rummy's stock badge take space from the region's
   budget (as `topZone`/`bottomZone` do, and reported through
   `TableGeometry.reserved`), not a free position above the hand zone.
3. **One test for every game's centre.** Replace the skip with an
   assertion over `TABLE_VIEWPORTS` × seat counts × each game's own
   `bottomZone`: no centre piece or centre chrome overlaps any
   opponent's hand, pod, or the reserved bands. It must include laptop
   heights, since every report so far came from a laptop window.

**Per game, after that:**
- Rummy: `pileAssembly`'s deck + fan and `StockBadge` at `centreScale`.
  The discard fan's pan range is derived from the region, so check it at
  the smaller scale.
- BS: `pile`/`reveal` are sized from `spec.card`, so same treatment.
- Dominoes: `line` has its own camera and fits the chain already. Only
  check its clearance against the top rack on laptop heights.
- Poker: the panel reservation above covers the 1366×650 residue below.
- Spades: the trick already scales; just include it in the shared test.

### BS: the centre pile was cut off at the bottom
**Resolved** — `7468a89` (T2).
- Reported 2026-09-25 (screenshot, about 1524×790 CSS). The pile card
  sat under BS's bottom sheet. The sheet is now REMOVED (the user's call:
  BS does not need it), which also took it off the path cards fly from
  the hand to the pile.
- Still open: BS reserves no space for the band above the hand (the bar
  with "Play" / "BS!"). Measured with `resolveTable`, 4 seats: the pile
  clears that band by 14px at 1524×790, but runs 36px UNDER it at
  1366×650 and 26px under it at 844×390 (landscape phone). The
  `pile`/`reveal` pair is centred on `cy` of the whole table, not of
  what the hand band leaves. Part of the central fix above: the centre
  lays out inside the space left by every reserved band.

### Hands that grow to most of the deck (BS, Rummy)
- In BS a hand can reach ~40–52 cards (a player who keeps losing
  challenges picks up the whole pile). Rummy can also grow large.
- Rummy opts into compress-then-pan (`handScroll`, `usePanZone`, see
  CLAUDE.md): the fan compresses to a floor, then pans. **BS does not
  opt in**, so its fan keeps shrinking its step and past ~25 cards the
  cards become slivers you cannot read or tap reliably.
- Needs a plan for every form factor, not just turning panning on:
  - Phone portrait (~390px wide): even panning shows only ~8–10 cards at
    a time, so it needs a quick way to jump (e.g. the hand sorted by rank,
    with a rank index to scroll to), since BS play is "find all your 7s".
  - Phone landscape: the hand strip is already capped by the short-
    viewport rules, so the fan has height for one row only.
  - Laptop/desktop: two rows (or a wider arc) may fit before panning.
  - Selection must survive panning. Selected cards off-screen should
    still show as picked, e.g. a count in the bar ("3 picked").
- Check the opponents' side too: a seat holding 40 face-down cards fans
  them next to its pod, and that fan's reach was sized for ordinary
  hands (`cardSideReach`/`cardTopReach` use one card, not the fan's
  length, so check the length does not run into neighbours).

### Poker: betting panel vs the board on short laptop windows
**Resolved** — `7468a89` (T1 — the panel is the band's; see 4.9 for what is left at 650px).
- At 1366×650 the panel (now a single 96px row on wide screens) still
  overlaps the flop by ~12px. Between the board's bottom and the hero's
  cards there is only ~118px there. Clear at 1536×780 (89px to spare).
- Root cause: the panel is positioned from the hand zone and grows upward
  into the table, with no zone reserved for it in `geometry.ts`. It should
  be a reserved band (like `topZone`/`bottomZone`, reported through
  `TableGeometry.reserved`) that the centre chain is laid out around, and
  covered by a layout test.
- On phones it is still the stacked panel (~275px); not yet checked against
  the board on phone landscape.

### Centre zones not yet audited against HANDS on laptop heights
**Resolved** — `7468a89` (the band test checks opponents' hands too).
- Rummy: now measured and reported (see "The table's centre runs into the
  seats" above).
- BS's `pile`/`reveal` pair and Dominoes' `line` are still to be measured.

### The round-end summary hides the table
**Resolved** — `851551d` (*Look at the table*).
- It blurs and covers the felt, so at a poker showdown you cannot look at
  the cards that decided the hand while reading the result. (The summary
  now names the winning hand in words, which helps, but the cards are the
  real answer.) POLICY.md: reference information should not be modal.

### Pod text that can outgrow a pod
**Resolved** — `0e0d1bb` (T4) and `b6fcb86` (two lines, sized).
- Poker's "$4837 · bet $362" was cut off (fixed by splitting it into two
  lines). Other games still build a single `meta` string that can outgrow a
  96px pod — e.g. Spades' "4 (blind) · won 2 · 150". Audit with long values.

### Poker: small things seen in the browser
- Preflop, the stub pile peeks out from under the betting panel.
- The hand-zone header's "To call $20" turn indicator repeats what the
  panel says (and the panel covers the middle of that header anyway).
- The setup screen's description ("Fixed blinds, real side pots — a short
  stack going all-in...") is written for people who already play. It
  should say what the game is in plain words; the Hands sheet's glossary
  has the vocabulary.

### Poker says "Round" where players say "hand"
**Resolved** — `851551d` (`roundNoun`).
- The round intro and scorecard eyebrow are shared ("Round 3"). For poker
  that number is the hand count, and "Hand 3" is the word players use.
  A per-game label would do it.

### Offline dev chrome
**Resolved** — `0e0d1bb` (T9 — folded by default).
- The dev panel (top-left, open by default) covers the left seat's pod.
  Dev-only, but it is what the table looks like every time it is opened
  in development.

## Already fixed (for reference)
- Toasts lined up on their LEFT edge when two of different lengths showed:
  the pill classes were on sonner's fixed-width row as well as the pill,
  so each pill sat at the row's left. The row is now a plain centring box
  (2026-09-26).
- Online corner controls were a box per table (End game / Step away). They
  are in the Settings sheet now (`TableMenu`), and every table has a
  Settings button, so the corner is one shared row in `GameHost`.
- Settings and Poker's Hands rose from the bottom over the hero's cards —
  now drawers from the right, where their buttons are, dimming the rest of
  the screen; tap outside, the X or Esc closes (`InfoSheet`'s `side`).
- Spades' trick overlapped the top seat's hand on a laptop — trick now
  centred in `pileRegion` (layout.test.ts "trick — stays clear").
- Poker's community row overlapped the top seats' cards on a laptop, and
  the side seats' on phones — bounded by `pileRegion`, cards shrink to fit
  (layout.test.ts "poker's centre — stays clear").
- Poker's betting panel covered the flop at 1536×780 — now a single row on
  wide screens (the 1366×650 residue is open, above).
- Poker pods cut off the bet — stack and bet on separate lines.
