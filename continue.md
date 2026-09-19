# Continue — session handoff (2026-09-19)

All five games are real and **all five play online in a room**. The
architecture is in CLAUDE.md and not repeated here; this is what is worth
knowing before touching the multiplayer layer.

```
npm run check     773 tests, 44 files   (typecheck + lint + test)
npm run harness    23 scenarios          (needs `npm run dev`)
npm run e2e        11 browser tests      (starts its own server on 3210)
```

## What just happened

The room layer went through its first audit, prompted by a human
playtest that found it freezing, desyncing and losing people on refresh.
Five commits, four tiers, each fix pinned by a test that fails without
it. The headline finding and the most useful one are both worth knowing:

**A player who dropped ON THEIR TURN froze the table forever.**
`settled()` is what hands a turn to a bot, and on the server it was only
ever reached from somebody ACTING — so a table parked on a live seat
whose owner left had nobody to wait for and nothing to wake it. Four of
the five games; Rummy escaped only because its claim race had already
armed a `deadline?()` timer. Every existing test passed straight over it,
because they all assert the NEWS travels (`liveSeats` flipped, a frame
with `botSeats` was pushed) and none asserted the game then MOVES.

**Two tabs on one machine is the one arrangement guaranteed not to
work** — and it is the obvious way to try a room out by hand.
`localStorage` is per-origin, not per-tab, so two tabs are one PERSON;
the server replaces the old socket with the new one, and the old tab used
to read that as the network dropping and reconnect, which closed the tab
that had just taken over. Measured at ~4 round trips a second, forever,
with one of the two always holding a dead socket. Now the server says
`superseded` and the old tab stands down with an offer to take it back.

## Testing a room by hand

Two tabs on `localhost` will NOT give you two players (see above). Use
two origins, which is what `allowedDevOrigins` in `next.config.ts` is
for:

- player one: `http://localhost:3000/room`
- player two: `http://127.0.0.1:3000/room`

Two browser profiles or two devices work too. The e2e tests use separate
browser CONTEXTS for the same reason.

## Things that bit, and would bite again

- **Each bug was found by doing the NEXT thing.** The freeze needed a
  real socket to really close; the two-tab storm needed a browser. Both
  had green unit tests either side of them.
- **`legalActions` is the turn gate, not the action gate.** It answers
  "may this seat act" and says nothing about whether the action that
  arrived is one of them — and online the action is arbitrary JSON off a
  socket. `GameDefinition.validate?()` is the seam that closes it. Four
  games share `validateByEnumeration`; poker validates by hand because
  its bet is a continuous range and `legalActions` offers only the
  minimum as a representative.
- **`SPECTATOR_SEAT` is -1, and -1 is a perfectly ordinary number.** It
  makes every `seat === viewer` comparison fail, which is exactly right
  for hands and meaningless for arithmetic: `partnerOf(-1)` is 1, so a
  spectator was told seat 1 was their partner. Check any maths that takes
  a seat id.
- **`HERO` is seat 0 is still hiding in shared code.** `playerViews` was
  fixed for it long ago; `GameHost`'s winner label and standings were
  not, so every online match ended with the wrong name. Grep for `=== 0`
  and `HERO` before trusting a shared component online.
- **A shell that hand-rolls what `table.tsx` should own WILL drift.**
  Dominoes' `tapTile` and Spades' `onPieceTap` exist because of this;
  Spades' card selection and LRC's `handZone`/`stats` had drifted again
  and are now shared the same way.
- **A client-side navigation remounts the room screen** while the socket
  stays open. The connection replays its last hello/room/frame for this
  reason. Do not make room state component-local again.
- **Mocking the router hid a fatal bug.** The jsdom tests mock
  `next/navigation`, so `replace` is a no-op. Anything depending on real
  navigation needs the browser layer.
- **The lobby and the table registry can drift.** One decides what may be
  STARTED (server-enforced), the other what can be DRAWN. They cannot be
  merged — one is imported by the server, the other is React — so
  `src/room/tables.test.tsx` holds them together.

## Known and deliberately not done

- **One instance only.** Rooms are live in-memory objects, so a second
  instance would hold a second, invisible set of rooms. Fine for the ~10
  players this is being launched to; it is the first thing to revisit if
  that changes, and it means a real fix (shared store or sticky routing),
  not a config flag.
- **There is no CI.** `check`, `harness` and `e2e` are all manual and
  local, and `render.yaml`/`Dockerfile` deploy on `build` alone — so
  nothing stops a red suite shipping. A GitHub Action running `check`
  plus `e2e` is the obvious next piece of infrastructure.
- **Only chromium** in `playwright.config.ts`. Mobile Safari is a
  plausible target for a phone-first table game and is untested.
- **Never more than two clients** at the harness or e2e layer, though
  rooms seat up to 10. Four-player online play — the shape every
  partnership game assumes — has no end-to-end test.
- `reqId` idempotency is promised in `protocol.ts`'s header and
  implemented nowhere.
