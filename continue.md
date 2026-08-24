# Continue — session handoff (2026-08-24)

All five games are real. Four of them — Spades, Poker, Dominoes and LRC —
also play online in a room against other people. `npm run check` clean at
**615 tests**; `npm run harness` at 18 scenarios; `npm run e2e` at 6.

The multiplayer architecture is in CLAUDE.md and not repeated here. This
is what is worth knowing before touching it.

## What is done

- **One engine, two drivers.** `GameSession` is the turn loop with no
  React in it. `useGameRuntime` drives it in a browser, `RoomRuntime` on
  the server. Same rules, same bots, same code.
- **Rooms**: 4-letter codes, public or private with approval, a party
  leader with real powers, teams, spectators, bot takeover on
  disconnect, identity-keyed seat reclaiming, one-minute expiry.
- **Redaction** filters hidden information before it is sent, not in the
  UI. `/lab/redact` audits it per seat.
- **Four test layers**, each blind to what the one below it catches —
  see CLAUDE.md's "Testing it".

## What is not

- **Rummy 500 is offline only**, and it is a rules problem rather than a
  wiring one. `currentSeat` returns `HERO` outright while a claim window
  is open, `startRound` branches on `dealer === HERO`, and the claim race
  is timed by a `setTimeout` in the play page rather than by anything the
  server could adjudicate. Poker's `pendingShowdown` — which routes every
  seat, bot or human, through an ordinary turn — is the pattern to copy.
- **Nobody has played an online game by hand.** Six browser tests drive
  the real thing and pass, but no human has sat at an online table and
  looked at it. That is the single biggest gap.
- **LRC's roll changed and wants an eye on it.** It used to resolve the
  dice on the client and hold the submit back for the length of the
  tumble. The dice are now rolled by whoever owns the game, and the beat
  comes from a `pause` the engine emits. The tumble was shortened to
  match. It is correct; whether it FEELS right is unverified.
- **No deploy config.** Custom server, so it needs a Node host.

## Things that bit, and would bite again

- **Each redaction bug was found by doing the next thing, not by more
  tests on the last one.** A second game exposed the deal-event leak; a
  real browser exposed the missing hand. Both had green unit tests.
- **A client-side navigation remounts the room screen** while the socket
  stays open. The connection replays its last hello/room/frame to a new
  subscriber for exactly this reason. Do not make room state
  component-local again.
- **Mocking the router hid a fatal bug.** The jsdom tests mock
  `next/navigation`, so `replace` was a no-op and creating a room
  appeared to work. Anything that depends on real navigation needs the
  browser layer.
- **The lobby and the table registry can drift.** One decides what may be
  STARTED (and the server enforces it), the other what can be DRAWN. They
  cannot be merged — one is imported by the server, the other is React —
  so `src/room/tables.test.tsx` holds them together.
- **`npm run check` used to be unreliable** and is not any more: the
  suite defaults to `node` and only five files opt into jsdom. If it
  starts timing out again, look at environment setup time before
  suspecting a test.

## Next up

Rummy's claim race is the obvious remaining piece of work, and the only
one that needs engine surgery rather than wiring. Everything else on the
list is polish: a human playtest of an online table, LRC's roll timing,
and somewhere to deploy it.
