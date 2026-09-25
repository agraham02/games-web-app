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
- Rummy's deck/discard piles, BS's `pile`/`reveal` pair, Dominoes' `line`.
  Spades' trick and Poker's community row both collided; these are the same
  shape.

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
- The in-game Settings sheet slides over the hero's own cards. It is
  dismissible, but POLICY.md wants the hand visible under any sheet
  (`PeekRail`'s `offsetBottom` is the precedent).

### Poker says "Round" where players say "hand"
- The round intro and scorecard eyebrow are shared ("Round 3"). For poker
  that number is the hand count, and "Hand 3" is the word players use.
  A per-game label would do it.

### Offline dev chrome
- The dev panel (top-left, open by default) covers the left seat's pod.
  Dev-only, but it is what the table looks like every time it is opened
  in development.

## Already fixed (for reference)
- Spades' trick overlapped the top seat's hand on a laptop — trick now
  centred in `pileRegion` (layout.test.ts "trick — stays clear").
- Poker's community row overlapped the top seats' cards on a laptop, and
  the side seats' on phones — bounded by `pileRegion`, cards shrink to fit
  (layout.test.ts "poker's centre — stays clear").
- Poker's betting panel covered the flop at 1536×780 — now a single row on
  wide screens (the 1366×650 residue is open, above).
- Poker pods cut off the bet — stack and bet on separate lines.
