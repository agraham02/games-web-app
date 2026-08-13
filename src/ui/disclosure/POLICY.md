# Disclosure policy

How information gets shown to the player. The rule this exists to
prevent: five games, five different opinions about what deserves a
modal, and a player who has to relearn the interface per game.

## The ladder

Pick the **lowest rung that works**. Moving up costs the player
attention; moving up unnecessarily costs them the game state they were
holding in their head.

| Rung | Component | Use for | Blocks play? | Player cost |
|---|---|---|---|---|
| 1 | Inline HUD | Turn, current bid, score, timer, stock count | never | none |
| 2 | Ambient badge | Opponent meld strips, chip counts, bag counts | never | none |
| 3 | `EventToast` (sonner) | Bot actions — "Sam knocked", "Mia bid 3" | no | a glance |
| 4 | `PeekRail` | Reference consulted *while* playing — board melds, full scoreboard, discard history | no | a drag |
| 5 | `InfoSheet` | On-demand detail — rules, scoring breakdown, hand history | no | a tap, dismissible |
| 6 | `BlockingDialog` | Real stakes only — confirm knock, place bid, fold/call/raise | **yes** | full stop |

## Hard rules

**Never put reference information in a modal.** If the player needs to
compare it against their own hand, a modal makes the comparison
impossible. This is the entire reason `PeekRail` exists and is not
built on vaul — vaul portals to `body` and is modal by default.

**The rail never covers the hero's hand.** `PeekRail` takes
`offsetBottom`; games pass the hand-zone height. Even fully open, your
own cards stay visible. "Check the board" must not become "lose sight
of what you were comparing."

**A blocking dialog must be the player's own decision.** Something a
bot did is a toast. Something the player must decide before the game
can continue is a dialog. Nothing else qualifies.

**State the count in words.** "3 eligible · tap to take" beats making
someone count highlighted cards. Highlighting shows *which*; words show
*how many*.

**Dim, don't hide.** In a targeting mode, invalid options desaturate and
darken (a grayscale/brightness filter, not reduced opacity — opacity
washes a light card face toward the felt and costs legibility) rather
than disappearing. Vanishing options make the board reflow, which
destroys the spatial memory the player just built.

## The three-tier pattern

Rummy 500's board is the worst case in this project — six players can
have eighteen melds down. It resolves as three tiers, and this
generalises to any "too much to show, too important to hide" problem:

1. **Ambient** — a compressed always-visible summary on the seat pod.
   Costs nothing, ignorable, answers "roughly what's out there?"
2. **Peek** — a rail at rest above the hand listing everything
   compactly. One drag or tap. Answers "what exactly is out there?"
3. **Targeted** — select a card and the board filters to what's legal,
   dimming the rest and showing where the card lands. Answers "what can
   I do with *this*?"

Tier 3 is reached by doing the thing you already wanted to do (picking
up a card), not by opening a menu. That is what makes it frictionless:
the disclosure *is* the interaction.

## Toast copy

- Name the actor: "Sam knocked", never "A player knocked".
- Past tense, no punctuation, under six words.
- `tone: "good"` only for the hero's own wins. Bot successes are
  `info` — the app should not celebrate against the player.
