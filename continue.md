# Continue — session handoff (2026-08-17)

Four of five games are real and playtested: LRC, Dominoes, Spades, Rummy
500. Poker is the only one left, unbuilt. `npm run check` clean at **360
tests**. This file is a fresh handoff — the blow-by-blow of how Rummy got
here across ~13 playtest rounds is in git history and in memory (start
from [[rummy-implementation]] and follow its `[[links]]`), not repeated
here.

## Where things stand

**Rummy 500** is feature-complete and has had the most scrutiny of any
game in this app — real-money-feeling mechanics (the claim race), a
correctness-vs-reachability bug (the claim window was dead for a whole
session before anyone noticed), house-rule edge cases (a set closing at
three cards), and a full pass on responsive layout. Nothing known-broken
remains. Two things worth a deliberate look next time you're in it:

- **Round-win confetti was never confirmed fixed.** The likely cause (the
  `cardPoints` tens-scoring bug feeding a wrong `result.winner`) was
  fixed a long time ago in this session, and there's a test that a hero
  who scores most is reported as the winner — but nobody has watched a
  round end since and confirmed the confetti actually fires. Cheap to
  check, worth doing before assuming it's fine.
- The board sheet's expanded-card scaling (`expandedCardSize` in
  `page.tsx`) was retuned this session against real numbers (0.72 floor,
  capped by the panel's actual content width) but only verified by
  reading the math, not by eye at a real 15+ meld board. If Rummy ever
  gets a long-match playtest, that's the screen to watch.

**Spades, Dominoes, LRC** all got shared-layer improvements this session
(bot difficulty, dealer/opener randomness audit, responsive menus,
bigger phone cards) but no game-specific playtest — they should still be
in the state the last dedicated session left them
([[spades-implementation]]).

## Standing conventions worth knowing before touching anything

These are the load-bearing ones; CLAUDE.md has the full architectural
picture.

- **Bot difficulty is a real, wired setting now**, on all four games —
  `DifficultyPicker` (shared 3-stop slider) + `botTable(seats, tier)`,
  one tier for the whole table. It used to default to `steady`
  everywhere with nothing ever overriding it, silently. If a future
  "opponents feel the same regardless of difficulty" report comes in,
  check whether the SETUP SCREEN is actually passing `difficulty` through
  — that exact silent-no-op is what happened here.
- **A pannable fan cannot be clipped and never should be layered with
  more decoration without checking `FanSlot.visible` first.** See
  [[pannable-fan-has-no-clip]] — this bit twice (the fan itself, then
  `StagedRing` following it out from under a pod).
- **`Placement.dimmed`/`highlighted`/`tappable` exist specifically so a
  game can offer interaction without revealing legality.** See
  [[no-hand-holding-ui]] before adding any affordance that might leak
  what's playable.
- **Don't offer a decline button when accepting is free.** Rummy's claim
  bar had a "Pass" button until the user asked "who would want to pass
  up free points?" — and the honest answer was nobody, ever, in any
  state. See [[no-free-choice-buttons]].
- **A component's `transition` prop in Motion applies to its `exit`
  too.** A `repeat: Infinity` animation used as both the resting state
  and the exit means the exit never completes and `AnimatePresence`
  never unmounts the element — it looked like a leftover pulse running
  forever behind cards that had already flipped. See
  [[motion-exit-inherits-transition]].
- **When "is this closed / exhausted / complete" depends on cards that
  aren't in the collection you're asking about, you cannot answer from
  that collection's own members.** Rummy's "is this meld dead" question
  needed the whole board, not the one meld — a 3-ace set is closed the
  instant the 4th ace lands in someone else's RUN. See
  [[rummy-dead-meld-needs-whole-board]].
- **`DevPanel` takes a generic `scenarios` slot** — labelled one-shot
  callbacks a game supplies for states that are correct but hard to
  reach naturally (Rummy's claim window fires on the order of once every
  dozen rounds). Reach for this before accepting "untestable without
  grinding" for any future feature.

## Known non-issues, in case they come up again

- **LRC has no difficulty control, deliberately.** Rolling is the only
  legal action and the dice are random — `lrcBots`' tiers differ only in
  pacing, so a slider that changes nothing but reaction speed would
  promise a difference the game doesn't have.
- **Landscape Rummy on a short phone shows a rotate prompt, not a
  layout.** A side-rail version was built, measured, and worked
  (86px → 223px of table) — then scrapped at the user's request rather
  than kept as a second layout to maintain. It's recoverable from git
  (`PeekRail`'s `edge` prop, `ResolveOptions.sideZone`) if ever wanted
  back. See [[short-viewport-has-no-budget]].

## Next up

Poker (NL Hold'em) is the only unbuilt game. Nothing in this repo has
scoped it yet — no engine sketch, no UI decisions made. Read
`CLAUDE.md`'s "Adding a game" checklist and the shared-layer
`[[rummy-implementation]]` note on what groundwork already exists
(compress-then-pan, `HandZone`, the generic dev state editor, the
`scenarios` slot) before re-deriving any of it.
