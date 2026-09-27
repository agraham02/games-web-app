# Table layout rethink — the board first, on phones

**Status:** research brief, 2026-09-27. Nothing here is built. It is the
starting point for a fresh session that will research further and propose
designs; it ends with the questions only the user can answer.

**Why now.** The user, after the layout/UX pass (`feat/layout-ui-ux-pass`):

> Remember how I said mobile is the priority. Look at the 3rd and 4th pics
> that show a dominoes game. I feel like the main thing players should be
> looking at, the center game board with the played pips, is small,
> especially compared to all the other game items (the player pods and
> visible tiles) and that there is a lot of empty white space. And I feel
> like this is the case for all the other games too, which leads to a lot
> of our overlapping problems. Maybe we need to approach how we render and
> layout games completely differently.

The measurements below agree with them, and they point at the layout model
rather than at any one game.

---

## 1. In short

- **Most of a phone screen shows nothing.** Mid-round on a 390×844 phone,
  pieces, pods and the band above the hand cover **17–37%** of the screen.
  The other 63–83% is empty felt.
- **The board is the smallest thing on the table.** It covers **1–6%** of
  the screen. Board pieces are drawn at about half to three quarters of the
  size of the pieces in your hand. Poker's flop is drawn at 28×39, the same
  size as an opponent's face-down card. Dominoes' chain tiles are 43×21
  while the hand's tiles are 90×45.
- **The cause is the order things get space in.** `resolveTable` seats
  everybody first: an edge slot per opponent, a 46px pod inset on three
  sides, a fanned hand beside each pod, then a 214px hand strip and band at
  the bottom. The board gets what remains. Its pieces are then drawn at a
  fixed size per density tier (`card`, 48×67 on every phone), not a size
  derived from that room. The Dominoes camera is capped at that size too.
- **Recommendation:** a board-first composition on portrait phones. The
  hand and band stay at the bottom. Opponents move to one compact strip
  along the top, showing counts instead of fanned card backs. The board
  gets one large box: everything else, about 55–60% of the screen instead
  of about 22% for Dominoes today. Each game fits its board to that box
  with its own minimum and maximum piece sizes (a "stage"). Keep the
  current ring for tablets and desktops, where it works, until the new
  composition has proved itself. Build it in the lab first, on Dominoes.

---

## 2. How a table is laid out today

One pipeline serves all six games:

1. **`TableSurface`** measures its box and the band above the hand
   (`HandZone` reports its height), and calls `resolveTable`.
2. **`resolveTable`** ([geometry.ts](../src/table/geometry.ts)) picks a
   **density** by width alone (`compact` < 640px, `regular` < 1024px or a
   short screen, `wide` otherwise). Each density is a table of fixed sizes:

   | density | hand card | table card | mini card | hand strip | ring pad | pod inset | pod |
   |---|---|---|---|---|---|---|---|
   | compact | 64×90 | 48×67 | 28×39 | 150 | 14 | 46 | 60×62 |
   | regular | 74×103 | 56×78 | 32×45 | 172 | 18 | 54 | 64×68 |
   | wide | 118×165 | 92×129 | 50×70 | 250 | 28 | 88 | 96×100 |

   It then builds a **ring**: the viewport minus the hand strip, the band
   and any reserved zones. `allocateEdges` shares the opponents between
   the left, top and right edges. Each edge that holds a seat is inset by
   `podInset`. What is left is **`play`**. The centre zones are carved out
   of `play`, mostly sized from `card` (for example
   `trickW = min(play.w × 0.72, card.w × 3.4)`). Dominoes' `line` is `play`
   pulled clear of the pods and of the opponents' tile racks (`topBleed`,
   `sideBleed`). Poker's community → pot → stub chain and BS's reveal + pile
   pair shrink to fit (`zoneScale`), down to a legible floor of 40px.
3. **`layoutPiece`** ([layout.ts](../src/table/layout.ts)) turns each
   piece's `Placement` (zone, seat, index, count) into a transform. Hands
   are fans, and a hand that overflows compresses, then pans. Dominoes
   tiles in `line` go through **`boardCamera`**, which fits the chain's
   extent to the `line` box, turns it a quarter on portrait boxes, and caps
   the unit at `tileShortSide(g.card)`.
4. **`PieceLayer`** draws every piece on one absolutely positioned canvas.
   It is the only absolute layer, by the user's standing rule. `SeatRing`
   draws the pods; `HandZone` owns the band (row / bar / panel). Each
   game's `table.tsx` adds overlays: bars, sheets, dice.

The model came from a real table seen from above, with every seat on an
edge. On a tablet or a desktop that reads well. A portrait phone has one
narrow width and a tall height, and three edges of seats spend the width
twice: a pod inset on each side, then each side seat's rack.

---

## 3. Measurements

Two instruments, both reusable:

- **`npm run measure`** ([scripts/measure-table.ts](../scripts/measure-table.ts)):
  plays each game a little way in with its own bots (seeded), lays every
  piece out through the real `resolveTable` + `layoutPiece`, and rasterises
  what lands where. It does not see chrome the geometry does not know about
  (buttons in the band, badges, Rummy's board sheet). Rerun it against any
  proposal.
- **A live probe** in Chrome (devtools MCP, 390×844, touch): the same
  rasterising over `[data-fx]` pieces, `.z-800` pods and visible text. At
  the start of a Dominoes round (one double on the line) it measured
  **20.8%** of the screen covered and the board at **1.1%**. That agrees
  with the script.

Mid-round, from `npm run measure` (percent of the screen each category
covers; overlaps counted once in *Anything*):

| Game | Screen | Board | Hand | Opponents | Pods | Band | Anything | Largest board piece | Hand piece | Opponent piece |
|---|---|---|---|---|---|---|---|---|---|---|
| dominoes | phone 390x844 | 4.5% | 3.3% | 1.6% | 3.6% | 7% | **20%** | 43×21 | 90×45 | 39×20 |
| | | camera unit 22.4px (cap 33.5), line zone 150×489 | | | | | | | | |
| dominoes | phone landscape 844x390 | 0.7% | 4.5% | 2.1% | 4.2% | 11.3% | **22.7%** | 16×8 | 103×52 | 45×23 |
| | | camera unit 8.2px (cap 39.0), line zone 572×55 | | | | | | | | |
| dominoes | desktop 1440x900 | 5.6% | 2.9% | 1.3% | 2.3% | 6.8% | **18.8%** | 99×49 | 165×83 | 70×35 |
| spades | phone 390x844 | 1.9% | 12.2% | 5.2% | 3.6% | 7% | **30%** | 68×48 | 90×64 | 39×28 |
| spades | phone landscape 844x390 | 1.9% | 17.8% | 6.5% | 4.2% | 11.3% | **38.5%** | 78×56 | 103×74 | 45×32 |
| spades | desktop 1440x900 | 1.8% | 11.5% | 4% | 2.3% | 6.8% | **26%** | 129×92 | 165×118 | 70×50 |
| rummy | phone 390x844 | 6.4% | 4.7% | 2.8% | 3.6% | 7% | **24.3%** | 68×48 | 90×64 | 39×28 |
| rummy | phone landscape 844x390 | 8% | 6.1% | 2.6% | 4.2% | 11.3% | **30.4%** | 78×56 | 103×74 | 45×32 |
| rummy | desktop 1440x900 | 5.6% | 4% | 2.1% | 2.3% | 6.8% | **20.8%** | 129×92 | 165×118 | 70×50 |
| poker | phone 390x844 | 2% | 3.1% | 2.7% | 6% | 23.5% | **37.3%** | 39×28 | 90×64 | 39×28 |
| poker | phone landscape 844x390 | 1.8% | 4.1% | 3.3% | 7% | 21.6% | **36.9%** | 40×29 | 103×74 | 45×32 |
| poker | desktop 1440x900 | 3.8% | 2.7% | 2% | 3.8% | 15.4% | **27.7%** | 120×86 | 165×118 | 70×50 |
| lrc | phone 390x844 | 2.4% | 0% | 3.4% | 4.7% | 7% | **17.5%** | 68×48 | – | 39×28 |
| lrc | phone landscape 844x390 | 3.3% | 0% | 4.2% | 5.5% | 10.8% | **23.9%** | 78×56 | – | 45×32 |
| lrc | desktop 1440x900 | 2.2% | 0% | 2.6% | 3% | 6.8% | **14.6%** | 129×92 | – | 70×50 |
| bs | phone 390x844 | 1.2% | 10.3% | 5.4% | 3.6% | 7% | **27.5%** | 68×48 | 90×64 | 39×28 |
| bs | phone landscape 844x390 | 0.5% | 19% | 5.6% | 4.2% | 11.3% | **40.4%** | 40×29 | 103×74 | 45×32 |
| bs | desktop 1440x900 | 1% | 12.2% | 4.1% | 2.3% | 6.8% | **26.5%** | 129×92 | 165×118 | 70×50 |

The Band column is reserved space, most of it one line of text. It counts
as "showing something" here, so *Anything* flatters the table. Scenarios:
Dominoes and Spades 4 seats, Rummy 4, Poker 6 (measured once the turn
card is out), LRC 5, BS 4.

What the table says:

1. **The phone's free space is in the middle, and the middle is what's
   empty.** With four seats, `play` is 270×556, which is 46% of the
   screen. The board uses a tenth of that or less.
2. **Board pieces are smaller than the pieces around them.** Dominoes'
   chain tiles are half the hand's tiles. Poker's community cards are 28×39,
   exactly the size of the face-down minis in front of each opponent, and
   under half the size of your own cards. The trick in Spades and BS's pile
   are three quarters of a hand card.
3. **Dominoes gets a strip, not a board.** Its `line` box is 150px wide on a
   390px phone: 60px each side goes to the side seats' tile racks, and 46px
   more to their pods. Fourteen turns in, the camera is at 22.4px a unit,
   under its own cap. On a landscape phone the box is **572×55** and tiles
   are drawn at **16×8**, which cannot be read.
4. **Poker's band is a quarter of the phone.** The folded betting panel plus
   the band's row is 214px (23.5%) before any table is drawn, and it is
   why the flop has had to shrink to the legible floor.
5. **Opponents' face-down hands cost more than the board.** In Spades and BS
   the opponents' fans cover 5–7% of a phone and the board 1–2%. They show
   one number, a card count, that the pod could show in a badge.
6. **The same tier covers very different phones.** `compact` is everything
   under 640px wide. A 360px phone and a 600px foldable get the same
   pieces, and nothing scales in between.

---

## 4. Root causes

1. **Seat-first allocation.** Space is handed out edge seats → pod insets
   → opponents' racks → hand strip + band → board. The board is the
   remainder, and the least protected thing on the table.
2. **Board pieces are constants, not fits.** `card` is fixed per density,
   and the centre zones are built from it (`card.w × 3.4` for a trick).
   More room does not make the board bigger; only a smaller board
   (`zoneScale`) is ever computed.
3. **The Dominoes camera is capped at the table card.**
   `maxUnit = tileShortSide(g.card)` ([layout.ts](../src/table/layout.ts),
   `boardCamera`), so a short chain is drawn at 33.5px a unit on a phone
   however much room it has, which is smaller than the hand's tiles.
4. **Side seats are expensive on a portrait phone.** Each side seat costs
   a 46px inset plus a rack column (`sideBleed`, 60px), and the ring keeps
   14px from each edge. With seats on both sides, 240px of a 390px width is
   spent before Dominoes' board starts.
5. **Opponents' hands are drawn as pieces.** It is honest and it animates
   well, but on a phone a fan of 13 backs says "13" at the cost of a band on
   three sides of the board. The user once asked to keep piles and pod text
   unless a real crowding problem appeared
   (memory: *small-screen-piece-real-estate*). This request reports that
   problem, so the question is open again (see §8).
6. **The hero strip does not depend on the hand.** It is 150px on every
   phone plus the band, whether the hand is Spades' thirteen cards or
   Poker's two. Poker's two hole cards and its betting panel take 364px, 43%
   of an 844px screen. Only LRC, which has no hand, asks for less
   (`LRC_HAND_ZONE`, 64px).
7. **Width-only density tiers.** Three buckets, set by width, with height
   only demoting. Portrait vs landscape and short vs tall are handled as
   exceptions (`SHORT_VIEWPORT_H`, the Rummy rotate prompt), not as part of
   the model.

The "overlap problems" the user mentions (the Rummy board vs pods, domino
racks vs the chain, Poker's centre vs the band, BS's pile, LRC's dice) were
each fixed locally. They share one shape: several claims on a small
remainder. A layout that gives the board its space first removes the
remainder instead of rationing it.

---

## 5. What other games do

Sources are listed at the end. Where a claim is from general knowledge of
the genre rather than something read this session, it says **verify**; the
next session should confirm those claims with screenshots.

- **Portrait is the standard for phone card games now.** Partypoker
  (2019), GGPoker and PokerStars all rebuilt their tables for portrait so
  they can be played one-handed. Marvel Snap's team: *"Portrait mode is the
  way to go. Don't force players to turn their device."*
- **The thumb zone.** Hoober's 1,333 observations: 49% of people hold a
  phone one-handed, and only about a third of the screen, at the bottom, is
  easy to reach. Our hand and band at the bottom already fit this. The top
  of the screen is the right place for things you only look at: opponents,
  scores.
- **Cards change size with their job.** A card-game UI analysis
  (Fairtravel Battle) notes cards shrinking on the board to save room.
  That works for games whose boards hold many units. Our boards hold few
  (a trick of 4, a flop of 5, a double-six chain) and they are the shared
  focus, so they can afford to be big.
- **Opponents as badges, not fans** (**verify**). Commercial Spades,
  Hearts and dominoes apps usually show opponents as an avatar with a
  count or bid badge rather than a full fan of backs. The trick sits large
  in the middle, and your hand is the biggest thing on screen.
- **Dominoes apps snake the chain** (**verify**). The chain turns at the
  screen edges and the camera zooms out as it grows; some allow pinch and
  pan. One open-source implementation describes "one continuous domino
  snake with horizontal runs and vertical turns", auto-fitting from a short
  chain to all 28 tiles.
- **Portrait poker** (**verify**). Seats sit around an elongated oval
  (up to 9) as small avatars with stacks. The community cards are large in
  the centre, the hero's hole cards large at the bottom, and actions sit
  in a fixed bar with preset bet buttons. Portrait multi-tabling shows
  whole tables zoomed out, which only works if the table is a scalable
  unit.
- **Adaptive layout practice.** Material 3's *window size classes*
  (compact < 600dp wide, medium 600–840, expanded ≥ 840) and *canonical
  layouts* (for example a supporting pane) suggest a principled replacement
  for our three width tiers. On a compact width, stack the regions; on an
  expanded width, put supporting content (opponents, scores) in a pane
  beside the main one.

---

## 6. Options

| | Approach | What changes | Gain on a phone | Cost / risk |
|---|---|---|---|---|
| **A** | **Tune the ring** | Raise or remove the Dominoes camera cap; size trick/community/pile from `play` instead of `card`; count badges instead of opponents' fans on `compact`; slimmer pods. | Real but bounded. Dominoes stays a 150px strip while side racks exist; the board could roughly double in piece size. | Low. Stays in today's model and tests. |
| **B** | **Board-first composition on portrait phones** | New allocation order: hand + band → one opponent strip across the top (no side seats) → the board takes everything else as one box. | Largest. Dominoes' box goes from 150×489 to about 362×530 (2.6× the area); a Spades trick could use hand-sized cards. | Medium. A second composition beside the ring; the direction a card travels has to name its player without edge seats. |
| **C** | **A stage per game** | Each game lays its board out in its own units, fitted to whatever box it is given with a min/max piece size, the way the Dominoes camera already works, generalised. | Makes B's big box actually get used, and makes every size class the same problem. | Medium. Rewrites the centre zones of five games; the tests move with them. |
| **D** | **Compositions by size class** | Portrait phone = stacked (B). Landscape phone = board plus a side rail for opponents, or the rotate prompt Rummy already uses. Tablet/desktop = today's ring. | Fixes the landscape phone (Dominoes at 16×8). | Adds a decision per size class; needs an explicit rule for which one applies. |
| **E** | **Canvas / WebGL renderer** (Pixi etc.) | How pieces are drawn, not where. | None by itself: the problem is allocation, not rendering. | High. Loses the DOM pieces, Motion and accessibility. Not recommended. |

---

## 7. Recommendation

**B + C, per size class (D), built in the lab first.**

1. **Portrait phones get a stacked composition.** From the top:
   - an **opponent strip**: one row of compact pods (avatar, name, one or
     two stats, and a count badge for a hidden hand), in turn order,
     wrapping to two rows or scrolling past 5–6 opponents (Poker at 10);
   - the **board**: one box, as big as everything else allows;
   - the **band**: row / bar / panel, as now;
   - the **hand**.
2. **Each game fits its board to the box it gets** (C): a board space with
   its own units, a fit like `boardCamera`'s, and per-game `min` / `max`
   piece sizes. The max should allow board pieces at least as big as the
   hand's; the floor stays legible (40px today). Dominoes already works
   this way; Spades' trick, Poker's chain, BS's pair, Rummy's piles and
   LRC's pot each become a small layout in board units.
3. **Who played what, without edge seats.** A trick card or a played tile
   arrives from its player's pod in the strip and settles in a position
   that says whose it is: a cross for Spades' four seats, a row in turn
   order for more. Motion from the pod carries most of that meaning; the
   pod lighting up carries the rest.
4. **Keep the ring on tablets and desktops** (medium / expanded widths)
   for now. The measurements say they waste space too (Dominoes on a
   desktop covers 18.8%), but the ring reads well there, and the phone is
   the priority.
5. **Landscape phones**: either a board-plus-rail composition or the
   rotate prompt for every game. The user decides (§9). Today Dominoes is
   unplayable there.

**How to get there without breaking six games at once:**

- **Phase 0, measure.** Done: `npm run measure`. Add a target to it, for
  example "board ≥ 25% of a phone screen mid-round", and a test that
  holds a game to it once it has moved.
- **Phase 1, quick wins inside the ring** (option A, ships on its own):
  lift the Dominoes camera cap to at least `handCard`'s tile, and size the
  trick and community from `play`. Low risk, and the numbers show whether
  it is enough before anything bigger is built.
- **Phase 2, the stacked composition in `/lab/seats`**, which already
  previews seat layouts on device frames at forced densities. Build it
  for **Dominoes** first (the user's example, and its board is already a
  stage), then the trick games (Spades, BS), then Poker, Rummy and LRC.
- **Phase 3, promote it** per game behind the size class, and rewrite the
  layout tests for the new composition. The band test's rule, nothing
  under the band, carries over as it is.

**Constraints that still hold** (standing rules, see `docs/CLAUDE.md` and
memory): the piece layer is the only absolutely positioned layer, and all
other chrome is flex/grid; no hand-holding (nothing lights up what is
playable); no decline buttons when accepting costs nothing; shared
components over one-offs; a pannable fan cannot be clipped.

---

## 8. Game by game — what the board is

| Game | The board | Needs | Notes |
|---|---|---|---|
| Dominoes | the chain (up to 28 tiles), end markers, boneyard | the most area, and it grows | Already a camera; the chain should snake (turn at the box's edges) instead of only shrinking. Portrait turns it a quarter today. |
| Spades | a 4-card trick; won-trick piles | trick cards large enough to read at a glance; whose card is whose | Bids and tricks live in pods; the partner's score is in the band chip. |
| Rummy | deck, discard fan, melds | melds are the real board, and they live in a bottom **sheet** today | The sheet was the fix for melds colliding with pods (memory: *rummy-board-pod-overlap*). A board-first box could bring melds back onto the felt. |
| Poker | 5 community cards, pot, stub/burn | the community should be the biggest thing after your own cards | 6–10 seats: the strip has to handle 9 opponents. The betting panel (214px) competes with the board. |
| LRC | pot, dice, each player's chips | dice and the pot, big; chip counts clear | No hand: the hand strip is empty space in this game. |
| BS | the face-down pile, the reveal row, the claim | the reveal readable; the pile's size visible | Opponents' 13-card fans are the main cost; badges would free most of it. |

---

## 9. Questions for the user

1. **On phones, may opponents leave the table's edges** and sit in one strip
   along the top? This gives up the "seats around a table" picture there.
2. **Opponents' hidden hands: count badges instead of fanned backs** on
   phones? It reverses an earlier call (keep the piles) now that crowding
   is real. Fans could stay on tablets and desktops.
3. **Landscape phones:** a board-plus-rail layout, or ask to rotate in
   every game, as Rummy already does?
4. **Pinch-zoom / pan on the board** (Dominoes' long chains), or always
   fit?
5. **Tablets and desktops:** keep the ring for now, or move everything to
   the new model at once?
6. **How big may board pieces get?** As big as the hand's, or bigger when
   the board is nearly empty (a single double at the start of a round)?

---

## 10. For the next session

Read first:

- [geometry.ts](../src/table/geometry.ts): `resolveTable` (ring, `play`,
  zones, `band`, `zoneScale`), `DENSITY`, `POD_SIZE`, `allocateEdges`,
  `fitScale` / `LEGIBLE_CARD_H`.
- [layout.ts](../src/table/layout.ts): `layoutPiece` per zone,
  `boardCamera`, `projectCell`, fans.
- [PieceLayer.tsx](../src/table/PieceLayer.tsx),
  [SeatRing.tsx](../src/table/SeatRing.tsx),
  [HandZone.tsx](../src/table/HandZone.tsx),
  [TableSurface.tsx](../src/table/TableSurface.tsx), and each game's
  `src/app/play/<game>/table.tsx`.
- Tests that encode today's model and will move with it:
  [layout.test.ts](../src/table/layout.test.ts) (the band test over every
  game and viewport, trick vs hands, Poker's centre, pile clamps, the
  toast lane), `geometry.test.ts`.
- [docs/layout-ui-ux.md](layout-ui-ux.md): the last audit, with what was
  built and deliberately not built. [docs/CLAUDE.md](CLAUDE.md): the
  standing layout rules.
- Memory notes on this area: *chrome-layout-over-absolute-positioning*,
  *pannable-fan-has-no-clip*, *short-viewport-has-no-budget*,
  *domino-side-seat-hand-overlap*, *rummy-board-pod-overlap*,
  *small-screen-piece-real-estate*.

Research still to do:

- Screenshots of 5–10 commercial apps at a phone size (Spades, Hearts,
  Dominoes, Rummy, Hold'em, and one BS/Cheat), each measured with the same
  categories as §3. That turns the **verify** claims into numbers.
- How commercial dominoes apps turn a long chain on a portrait screen:
  snake shape, zoom, pan.
- How portrait poker handles 9 opponents in the top part of the screen.
- Whether an opponent strip can keep the sense of turn order and
  partnership (Spades' partner across the table) that edge seats give.

### Sources

- [Pokerfuse — Partypoker's new mobile app switches to portrait mode](https://pokerfuse.com/news/poker-room-news/211022-exclusive-partypokers-new-mobile-app-switches-portrait-mode/)
- [PokerNews — Latest app updates show big bets on vertical poker clients](https://www.pokernews.com/news/2020/03/vertical-poker-clients-36721.htm)
- [Poker Industry PRO — PokerStars launches portrait tables on mobile](https://pokerindustrypro.com/news/article/215907-pokerstars-launches-new-portrait-tables-mobile)
- [GGPoker — All about the GGPoker mobile app](https://ggpoker.com/blog/all-about-the-ggpoker-mobile-app/)
- [Out of Games — Ben Brode and Marvel Snap devs' mobile design tips](https://outof.games/news/6233-ben-brode-marvel-snap-devs-provide-game-design-tips-for-mobile-gaming/)
- [GDC Vault — Designing MARVEL SNAP](https://gdcvault.com/play/1029024/Designing-MARVEL-SNAP)
- [UXmatters — How do users really hold mobile devices? (Hoober)](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)
- [Smashing Magazine — The thumb zone](https://www.smashingmagazine.com/2016/09/the-thumb-zone-designing-for-mobile-users/)
- [GDKeys — The card games UI design of Fairtravel Battle](https://gdkeys.com/the-card-games-ui-design-of-fairtravel-battle/)
- [Impulse Limited — UI design for a 2D/3D card game, 60+ iterations](https://medium.com/@impulselimited/ui-design-for-a-2d-3d-card-game-b0824867b0a3)
- [hyphsworld — Domino table with a connected snake (PR #188)](https://github.com/hyphsworld/hyphsworld.com/pull/188)
- [Balatro Portrait Mobile (community mod)](https://github.com/ShaggyLorean/balatro-portrait-mobile)
- [Material Design 3 — Canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview)
- [Android Developers — Canonical layouts](https://developer.android.com/develop/adaptive-apps/guides/canonical-layouts)
- [Game UI Database — Balatro](https://www.gameuidatabase.com/gameData.php?id=1935) (the database is a
  good place to survey card-table HUDs by genre)
