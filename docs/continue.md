# Continue — session handoff (2026-09-20)

All **six** games are real and all six play online in a room. The
architecture is in CLAUDE.md and not repeated here; this is what is worth
knowing before touching the multiplayer layer.

```
npm run check     922 tests, 51 files   (typecheck + lint + test)
npm run harness    30 scenarios          (needs `npm run dev`)
npm run e2e        18 browser tests      (chromium + a phone profile)
```

CI runs all three on every push and PR to `main`, plus a
production-install boot and a docker build, and only then triggers the
Render deploy — `render.yaml` has `autoDeployTrigger: "off"`, so nothing
ships on a red suite. See `deploy.md`.

## What just happened

A second audit of the room layer, prompted by getting it ready for a V1
launch. The first audit's findings were nearly all closed already; the
value this time was in what came AFTER it, because BS landed in between
and BS is the first game to run a multi-seat race after **every** play
rather than once a round. Three real bugs, none of which any test could
see:

**A bot's turn could silently rewind the game.** `settled()` stashed the
turn as a SNAPSHOT of the position it was scheduled for, and nothing
cleared it when somebody else acted first. BS grants the seat on turn its
plays while a window is open — that interrupt is the only defence a
ten-second window has — so a person using it had their play rolled back a
beat later, cards and all.

**Every resolved challenge leaked four cards.** `reduceTake` cleared
`pendingTake` but not `reveal`, so `playerView` went on shipping the
challenged cards under their real ids while `placements` correctly drew
them face down. `redact.test.ts` could not see it because
`PUBLIC_ONCE_SEEN.bs` deleted the key before it looked.

**A deadline outlived its turn.** A seat that dropped mid-window had a
bot answer for it in a beat, and ten seconds later the orphaned timer
fired into a CURRENT window the seat was entitled to all over again.

And on the client, **BS's player on turn was never shown a Play button**:
the action band preferred the challenge outright, and a window enrols
every seat but the claimer, so the seat on turn is always also entitled
to call. The interrupt existed in the rules and was unreachable in the UI.

## Testing a room by hand

Two tabs on `localhost` will NOT give you two players — `localStorage` is
per-ORIGIN, so two tabs are one PERSON. Use two origins, which is what
`allowedDevOrigins` in `next.config.ts` is for:

- player one: `http://localhost:3000/room`
- player two: `http://127.0.0.1:3000/room`

Two browser profiles or two devices work too. The e2e tests use separate
browser CONTEXTS for the same reason.

## Things that bit, and would bite again

- **Each bug was found by doing the NEXT thing.** The freeze needed a
  real socket; the two-tab storm needed a browser; this round's rewind
  needed a game that races after every play. Green tests either side.
- **A test that passes either way pins nothing.** Two of this round's
  tests passed against the unfixed code on the first attempt — one
  because a full `drain()` let later turns re-add what the bug had
  removed, one because it ran against an undealt `setup()` and never
  reached the code it was aiming at. Revert the fix and watch the test
  fail before believing it.
- **An exemption wider than its own argument hides the next bug.**
  `PUBLIC_ONCE_SEEN.bs` was justified by "a reveal is public", which is
  true only while the cards are face up. Unconditional, it deleted the
  evidence.
- **`legalActions` is the turn gate, not the action gate.**
  `GameDefinition.validate?()` is the seam that closes it. LRC is the one
  online game without one, and that is now a stated decision the sweep
  enforces rather than a hole nobody noticed.
- **`SPECTATOR_SEAT` is -1, and -1 is an ordinary number.** Third outing
  for this: after the partner badge and the "$0" hero badge, it was
  game-end standings rows. Swept for now, across all six games.
- **A control the server refuses must say so.** The lobby stayed fully
  interactive during a match; the picker was refused server-side and
  rendered nothing, and the team buttons were not refused at all — they
  updated the roster while the table's partnerships did not move.
- **A shell that hand-rolls what `table.tsx` should own WILL drift.** BS
  avoided every one of these traps by sharing `statsFor`, `onPieceTap`
  and now `barMode`.

## Known and deliberately not done

- **One instance only.** Rooms are live in-memory objects. Fine for the
  ~10 players this is launching to; revisit with a shared store or sticky
  routing, not a config flag.
- **A window's serial cost is by design.** Several live seats each get
  their own full window, so one play can park a big table for a while.
  That is deliberate — see `ChallengeWindow.pending` — and is listed in
  `fixes.md` rather than quietly changed.
- **No WebKit.** Playwright runs chromium and a chromium phone profile.
  Mobile Safari is a plausible target and is untested.
- `reqId` idempotency is promised in `protocol.ts`'s header and
  implemented nowhere.
- The rest of the open list, with reasons, is in `fixes.md`.
