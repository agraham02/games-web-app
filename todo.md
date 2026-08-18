# Todo

Deferred work, flagged rather than built, from the 2026-08-17 Caribbean
dominoes session. Both are real features, not bugs — build when actually
wanted, not preemptively.

## 1. Partner-hand inference for Caribbean dominoes bots

Real Caribbean partnership skill includes reading what your partner is
holding from which tiles they passed on (e.g. if they didn't play a 5,
they probably don't have one). Today's `sharp` bot only got the minimum
fix needed for team mode not to look broken — it stopped rewarding a
squeeze play that would block its own partner (`judge()` in
`src/games/dominoes/bots.ts`) — but it does no actual inference.

Needs:
- A per-round pass history on `DomState` (`state.passes` today is only a
  counter, not a log of who passed holding what open ends).
- A bot that reads that history to weight plays toward tiles a partner
  is known *not* to be squeezed by, and away from feeding an opponent's
  visible strength.

See [[caribbean-dominoes-mode]] in memory for the fuller context.

## 2. Compress-then-pan floor for the domino board camera

`boardCamera` (`src/table/layout.ts`) has no floor and no pan — it
compresses without limit to fit whatever `zone.line` it's given. The
2026-08-17 side-rack fix freed a lot of width on mobile (103px → 150px
on a 390px phone, four seats), which resolved the reported "board looks
tiny" complaint, but a long enough chain (Caribbean tops out around 25
tiles) will still shrink per-tile with no floor.

If a long game is reported as too small again, build the same
compress-then-pan pattern hands and discards already use
(`MIN_HAND_GAP_FRACTION`, `fanPanRange`, `PanSurface`/`usePanZone`) —
except the board needs a genuine **2D** pan (the chain snakes in both
directions), not `PanSurface`'s single-axis one. Needs:
- A floor on `boardCamera`'s `unit`, below which it stops shrinking.
- A new 2-axis pan surface (or an extension to `usePanZone`) over the
  `line` zone.
- A new store slice for the board's pan offset, threaded into
  `boardCamera`/`projectCell` the way `discardScroll`/`handScroll`
  already thread into their own zones.

Materially bigger than the rack fix — don't reach for it unless the
freed-width fix turns out not to be enough. See
[[domino-side-seat-hand-overlap]] in memory.
