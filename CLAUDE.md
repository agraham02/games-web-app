# Table Games — architecture

Single-player web app hosting five table games against bots: Dominoes
(Block & Draw), Spades, Rummy 500, Poker (NL Hold'em), Left Right
Center. Priority is UI/UX — real-table motion, distinct phase screens,
and Rummy's board information shown without clutter.

**Status: foundation only.** No game rules are implemented. The shared
layer is built and exercised through `/lab`.

```
npm run dev      # lab at /lab/seats
npm run check    # typecheck + lint + test
```

## The two decisions everything rests on

### 1. The engine emits events, not just state

`reduce(state, action) -> { state, events[] }`.

A snapshot cannot drive a table animation. If you only diff state you
have to guess whether three cards moved because they were dealt,
collected as a trick, or swept to a discard — and each looks completely
different. The event list says which.

Bot deliberation is a real event (`{t:"think", seat, ms}`), not a
`setTimeout` in a component. That is most of what makes an opponent
feel like a person.

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

## Performance

Per-piece store subscriptions ([store.ts](src/table/store.ts)) are why
a 52-card deal is cheap: each `<Piece>` subscribes to
`placements[id]` alone, so moving one card re-renders one component.
With React context it would be 52×52 renders for one deal.

That only holds because [`reindex`](src/table/applyEvent.ts) preserves
object identity for placements whose numbers did not change. If you
change that function, keep the identity guarantee — it is tested.

## Layout of the source

```
src/
  engine/     pure TS, zero React — types, seeded RNG
  games/      _shared/ card+deck model; per-game rules go here
  table/      geometry, placement store, piece layer, seat ring
  motion/     choreographer (event timing) + presets
  ui/         primitives/ (faces), phases/ (round & game screens),
              disclosure/ (rail, toast, sheets) — see POLICY.md
  lab/        harness fixtures and chrome
app/lab/      seats · motion · tokens · phases · rummy
```

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
