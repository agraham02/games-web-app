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

## Open

### The table's centre runs into the seats — fix it ONCE, centrally
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
- Rummy: now measured and reported (see "The table's centre runs into the
  seats" above).
- BS's `pile`/`reveal` pair and Dominoes' `line` are still to be measured.

### The round-end summary hides the table
- It blurs and covers the felt, so at a poker showdown you cannot look at
  the cards that decided the hand while reading the result. (The summary
  now names the winning hand in words, which helps, but the cards are the
  real answer.) POLICY.md: reference information should not be modal.

### Online corner controls are positioned per table
- Every `*Online.tsx` renders its own absolutely positioned top-right box
  (End game / Step away). Anything else wanting that corner collides with it.
  Poker's in-game Settings button is the first; see "Chrome is laid out, not
  positioned" in CLAUDE.md. The other five tables should move into the same
  shared row when they gain settings.

### Pod text that can outgrow a pod
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
- The round intro and scorecard eyebrow are shared ("Round 3"). For poker
  that number is the hand count, and "Hand 3" is the word players use.
  A per-game label would do it.

### Offline dev chrome
- The dev panel (top-left, open by default) covers the left seat's pod.
  Dev-only, but it is what the table looks like every time it is opened
  in development.

## Already fixed (for reference)
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
