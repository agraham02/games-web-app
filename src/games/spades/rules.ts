/**
 * Spades — GameDefinition.
 *
 * Bidding is not a separate mini-game bolted onto play — it is driven
 * through the exact same `currentSeat` -> `legalActions` -> `reduce` turn
 * loop as trick play. `state.phase` just tells `reduce` which family of
 * actions is currently legal, the same way Dominoes branches on
 * `result`/`dealt`. `state.exchange`, when set, overrides `currentSeat`
 * regardless of `phase` — the Blind Nil card exchange is its own
 * sub-sequence layered on top, not a third phase.
 *
 * Blind-bid timing, worth getting right: the rule ("After everyone has
 * bid and before the first lead, the [Blind Nil] bidder may exchange two
 * cards with partner") places the exchange AFTER ALL FOUR bids are in,
 * not immediately after the blind bid itself — so `phase` stays "bid"
 * through the whole exchange sub-sequence and only flips to "play" once
 * it resolves (or never happened). A Blind NUMERIC bid has no exchange
 * mechanic and reveals the bidder's hand the instant it's locked in —
 * the whole point of "blind" was not seeing the hand BEFORE deciding the
 * number, and nothing in the rule keeps it hidden any longer than that.
 * A Blind Nil bidder's hand, by contrast, stays hidden until the
 * exchange resolves (skipped or completed).
 *
 * One thing that looked at first like it would need special handling and
 * turns out not to: does executing the "take" half of the exchange
 * force-reveal the TAKER's hand? Only if the taker could still be
 * genuinely hidden at that point — but the taker is always the giver's
 * partner, and the only way to stay hidden through the full bidding
 * round is to bid Blind Nil yourself, which the team minimum-4 rule
 * already makes double-Nil (and so double-Blind-Nil) on one team
 * unreachable (see state.ts's `minLegalBid`). A partner who also went
 * blind must have bid a blind NUMBER instead — which reveals immediately
 * on locking in, per above. So the taker's hand is always already
 * visible by the time the exchange happens, by construction; no extra
 * reveal step is needed here at all.
 */

import type {
  GameDefinition,
  GameEvent,
  PieceId,
  PieceMeta,
  PlacementMap,
  ReduceResult,
  SeatId,
  SetupOptions,
} from "@/engine/types";
import { HERO } from "@/engine/types";
import type { Rng } from "@/engine/rng";
import { botName } from "@/games/_shared/botIdentity";
import { sortHandForDisplay } from "@/games/_shared/cards";
import { resolveTrick } from "@/games/_shared/trickTaking";
import {
  cardStrength,
  effectiveSuit,
  isTrump,
  shuffledSpadesDeck,
  spadesCardLabel,
  spadesDeck,
  type SpadesRules,
} from "./cards";
import { spadesBots } from "./bots";
import {
  HIDDEN_CARD,
  isBlindEligible,
  isHiddenFromSelf,
  isSecondBidder,
  legalPlays,
  minLegalBid,
  mustBidBlind,
  nextSeat,
  partnerOf,
  teamOf,
  teammates,
} from "./state";
import { AUTO_LOSS_SCORE, scoreRound, TARGET_SCORE } from "./scoring";
import type { Bid, RoundResult, SpadesAction, SpadesState } from "./types";

export const MIN_SEATS = 4;
export const MAX_SEATS = 4;

const SEATS: readonly SeatId[] = [0, 1, 2, 3];

function leadAnnounce(seat: SeatId): GameEvent {
  return {
    t: "announce",
    seat,
    text: seat === HERO ? "You lead" : `${botName(seat)} leads`,
    tone: "info",
  };
}

function describeBid(bid: Bid): string {
  if (bid.nil) return bid.blind ? "blind nil" : "nil";
  return bid.blind ? `${bid.tricks} blind` : `${bid.tricks}`;
}

/**
 * The next seat that still genuinely needs to bid, skipping anyone who
 * already has one recorded. Bidding normally fills strictly in turn
 * order, so this is a no-op everywhere except right after a team blind
 * bid (see `reduceBid`'s doc) — that's the one case where a bid can get
 * mirrored onto a seat BEFORE turn order naturally reaches them, and
 * without this, `currentSeat` would still stop on that seat and prompt
 * them to bid a second time.
 */
function nextBidder(bids: Record<SeatId, Bid | null>, from: SeatId): SeatId {
  let s = nextSeat(from);
  while (bids[s] != null) s = nextSeat(s);
  return s;
}

/**
 * Every unordered pair from `items`, in BOTH orders — `[a, b]` and
 * `[b, a]` are the exact same real action (an exchangeGive/exchangeTake
 * pair has no concept of "first" vs "second" card; neither reducer ever
 * reads `cards[0]` differently from `cards[1]`), so both need to appear
 * for `legalActions` to correctly recognise EITHER as legal. A caller
 * (a bot sorting by strength, say) picking the same two cards in the
 * order it happens to prefer isn't choosing a different action from one
 * that picked them the other way around.
 */
function combinations2<T>(items: readonly T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      out.push([items[i]!, items[j]!], [items[j]!, items[i]!]);
    }
  }
  return out;
}

/* ============================================================
   Setup and dealing
   ============================================================ */

/**
 * Returns an UNDEALT state: every card still notionally "in the deck".
 * The deal itself is `startRound`'s job, which is what makes it animate.
 */
function makeSetup(rules: SpadesRules) {
  // Spades is always exactly 4 fixed-partnership seats — the seat COUNT
  // in SetupOptions never affects this, unlike Dominoes' variable-seat
  // setup. `rng` is real, though: real Spades cuts for the first dealer
  // randomly rather than always seating the same player first, and a
  // hardcoded dealer meant every brand-new match opened on the exact
  // same seat — indistinguishable from "it never rotates" if you were
  // testing by hitting Rematch rather than playing several rounds
  // within one match (within-match rotation itself was already correct;
  // see startRound's `nextSeat(state.dealer)` and the regression test
  // below).
  return function setup(opts: SetupOptions): SpadesState {
    const num = (): Record<SeatId, number> => ({ 0: 0, 1: 0, 2: 0, 3: 0 });
    const bool = (v: boolean): Record<SeatId, boolean> => ({ 0: v, 1: v, 2: v, 3: v });
    const arr = (): Record<SeatId, PieceId[]> => ({ 0: [], 1: [], 2: [], 3: [] });
    return {
      rules,
      target: TARGET_SCORE,
      autoLoss: AUTO_LOSS_SCORE,
      round: 0,
      // Round one is decided by this value directly (see startRound's
      // `round === 1` branch) — a genuine random cut, not a sentinel.
      dealer: opts.rng.pick(SEATS),
      phase: "bid",
      turn: HERO,
      hands: arr(),
      handRevealed: bool(true),
      blindEligible: bool(false),
      bids: { 0: null, 1: null, 2: null, 3: null },
      exchange: null,
      trick: [],
      ledSuit: null,
      trumpBroken: false,
      voids: { 0: [], 1: [], 2: [], 3: [] },
      leader: HERO,
      tricksWon: num(),
      won: arr(),
      scores: num(),
      bags: num(),
      nilsAttempted: num(),
      nilsMade: num(),
      result: null,
      winningSeats: null,
      winner: null,
      dealt: false,
    };
  };
}

export function startRound(state: SpadesState, rng: Rng): ReduceResult<SpadesState> {
  const round = state.round + 1;
  // Round one is decided by setup's random cut; after that, deal rotates.
  const dealer = round === 1 ? state.dealer : nextSeat(state.dealer);
  const leader = nextSeat(dealer);

  // Round 2+ inherits every seat's WON pile from the round that just
  // ended (a full round always empties every hand, so nothing is ever
  // left there — this is defensive, matching Dominoes' own leftover
  // sweep). One `sweep` event, not one `move` per card: "clear the
  // table" is a single gesture, and sweep's own choreography stays fast
  // regardless of how many cards are in it — see presets.ts.
  const leftover = [...Object.values(state.hands).flat(), ...Object.values(state.won).flat()];
  const events: GameEvent[] = leftover.length > 0 ? [{ t: "sweep", pieces: leftover, to: "deck" }] : [];

  const deck = shuffledSpadesDeck(rng, state.rules);
  events.push({ t: "shuffle", seed: rng.seed });

  // Frozen from the scores ENTERING this round — a team's blind option
  // for the round is decided before a single card is dealt, and stays
  // fixed even if the round's own outcome would have changed the answer.
  const blindEligible: Record<SeatId, boolean> = {
    0: isBlindEligible(state.scores, 0),
    1: isBlindEligible(state.scores, 1),
    2: isBlindEligible(state.scores, 2),
    3: isBlindEligible(state.scores, 3),
  };
  const handRevealed: Record<SeatId, boolean> = {
    0: !blindEligible[0],
    1: !blindEligible[1],
    2: !blindEligible[2],
    3: !blindEligible[3],
  };

  const hands: Record<SeatId, PieceId[]> = { 0: [], 1: [], 2: [], 3: [] };
  // Dealt round by round, not hand by hand, so the deal reads as one
  // pass around the table instead of four separate handfuls.
  let cursor = 0;
  for (let i = 0; i < 13; i++) {
    for (const seat of SEATS) {
      const id = deck[cursor++]!;
      hands[seat]!.push(id);
      // The one departure from "hero always deals face up": a
      // blind-eligible hero's own hand stays hidden through the deal,
      // pending their look-or-go-blind choice. A no-op in the ordinary
      // case (handRevealed[HERO] is true whenever the hero isn't
      // currently trailing by 100+).
      events.push({ t: "deal", piece: id, to: seat, faceUp: seat === HERO ? handRevealed[HERO] : false });
    }
  }

  events.push({ t: "phase", phase: `round-${round}` });
  events.push({
    t: "announce",
    seat: leader,
    text: leader === HERO ? "Your bid" : `${botName(leader)} bids first`,
    tone: "info",
  });

  return {
    state: {
      ...state,
      round,
      dealer,
      phase: "bid",
      turn: leader,
      hands,
      handRevealed,
      blindEligible,
      bids: { 0: null, 1: null, 2: null, 3: null },
      exchange: null,
      trick: [],
      ledSuit: null,
      trumpBroken: false,
      voids: { 0: [], 1: [], 2: [], 3: [] },
      leader,
      tricksWon: { 0: 0, 1: 0, 2: 0, 3: 0 },
      won: { 0: [], 1: [], 2: [], 3: [] },
      result: null,
      dealt: true,
    },
    events,
  };
}

/* ============================================================
   reduce
   ============================================================ */

export function reduce(state: SpadesState, action: SpadesAction): ReduceResult<SpadesState> {
  switch (action.t) {
    case "look":
      return reduceLook(state);
    case "bid":
      return reduceBid(state, { tricks: action.tricks, nil: action.nil, blind: false });
    case "blindNil":
      return reduceBid(state, { tricks: 0, nil: true, blind: true });
    case "blindBid":
      return reduceBid(state, { tricks: action.tricks, nil: false, blind: true });
    case "skipExchange":
      return reduceSkipExchange(state);
    case "exchangeGive":
      return reduceExchangeGive(state, action.cards);
    case "exchangeTake":
      return reduceExchangeTake(state, action.cards);
    case "play":
      return reducePlay(state, action.card);
  }
}

function reduceLook(state: SpadesState): ReduceResult<SpadesState> {
  const seat = currentSeat(state);
  if (seat === null) return { state, events: [] };
  const hand = state.hands[seat] ?? [];
  // The shared table store only ever holds ONE viewer's picture (the
  // hero's — see useGameRuntime's `definition.placements(current, HERO)`),
  // so a `flip` event's `faceUp` has to already be hero-relative when it's
  // emitted; `applyEventToTable` applies it verbatim with no idea who's
  // watching. A non-hero seat looking at their OWN hand is real and
  // legal, but must not flash it face up on the hero's screen — that was
  // a real bug (a blind-eligible partner choosing to look, mid-round,
  // visibly flipped their cards for the hero to see, if only briefly
  // until the next reconcile corrected it back).
  //
  // Ordered by DISPLAY position (`handDisplayOrder`), not raw deal
  // order — a hand renders suit-sorted (see `placements()`), so
  // flipping in deal order visibly scrambles relative to what's on
  // screen: card 7 flips, then card 2, then card 11, with no relation
  // to their sorted left-to-right positions. Sorting the events first
  // makes the reveal sweep across the hand the same direction it's laid
  // out in.
  const events: GameEvent[] = handDisplayOrder(hand, state.rules).map((id) => ({
    t: "flip",
    piece: id,
    faceUp: seat === HERO,
  }));
  return {
    state: { ...state, handRevealed: { ...state.handRevealed, [seat]: true } },
    events,
  };
}

function reduceBid(state: SpadesState, bid: Bid): ReduceResult<SpadesState> {
  const seat = currentSeat(state);
  if (seat === null) return { state, events: [] };
  const partner = partnerOf(seat);

  // A blind NUMERIC bid made by the FIRST bidder of a blind-eligible
  // team is the TEAM's bid, full stop — confirmed against pagat.com's
  // "bid blind" rule ("a partnership... may choose not to look... bid
  // 'blind'... the partners pick up their cards", one joint decision,
  // not two individual numbers that sum) and trickstercards.com's own
  // "min blind bid... is a team bid". The partner never gets a separate
  // bidding turn: their hand reveals immediately and turn order skips
  // straight past them (`nextBidder`, below). A SECOND bidder's own
  // blind numeric bid — locked into blind via `mustBidBlind` after a
  // partner's Blind Nil, say — is unaffected: there's no partner turn
  // left to pre-empt, since the partner already bid separately.
  const isTeamBlindBid = bid.blind && !bid.nil && !isSecondBidder(state, seat);
  const bids = isTeamBlindBid
    ? { ...state.bids, [seat]: bid, [partner]: bid }
    : { ...state.bids, [seat]: bid };
  const events: GameEvent[] = [];

  // A blind NUMERIC bid reveals the instant it's locked in — there is no
  // exchange mechanic for it, so nothing keeps the hand hidden any
  // longer than "before the bid was decided". Blind NIL is different:
  // it stays hidden through the post-bidding exchange (see reduceBid's
  // caller doc and reduceSkipExchange/reduceExchangeTake below).
  let handRevealed = state.handRevealed;
  if (bid.blind && !bid.nil) {
    handRevealed = { ...handRevealed, [seat]: true };
    // Same hero-relative gating as reduceLook above — a non-hero seat's
    // blind numeric bid reveals to THEM, not to the hero watching.
    // Display-ordered — see reduceLook's own doc for why raw hand order
    // reads as scrambled.
    for (const id of handDisplayOrder(state.hands[seat] ?? [], state.rules)) {
      events.push({ t: "flip", piece: id, faceUp: seat === HERO });
    }
  }

  if (isTeamBlindBid) {
    // The partner never bid, but their hand reveals right alongside the
    // bidder's own — the whole team's cards land on the table together
    // the instant the team's one blind bid locks in.
    handRevealed = { ...handRevealed, [partner]: true };
    for (const id of handDisplayOrder(state.hands[partner] ?? [], state.rules)) {
      events.push({ t: "flip", piece: id, faceUp: partner === HERO });
    }
  } else if (!bid.blind && state.blindEligible[partner] && !handRevealed[partner] && bids[partner] == null) {
    // Synchronized team decision, the mirror-image direction: this bid
    // just LOOKED (bid.blind === false — the "look" step already ran).
    // If the partner hasn't bid yet and is still blind-eligible and
    // hidden, the team just committed to looking — reveal the
    // partner's hand right now, exactly like reduceLook would for
    // their own "look" action, so they never see a "go blind" option
    // that no longer exists for this team.
    handRevealed = { ...handRevealed, [partner]: true };
    for (const id of handDisplayOrder(state.hands[partner] ?? [], state.rules)) {
      events.push({ t: "flip", piece: id, faceUp: partner === HERO });
    }
  }

  if (seat !== HERO) {
    events.push({ t: "announce", seat, text: `${botName(seat)} bids ${describeBid(bid)}`, tone: "info" });
  }
  if (isTeamBlindBid) {
    events.push({
      t: "announce",
      seat: partner,
      text:
        partner === HERO
          ? "Your team's bid is set — you don't need to bid"
          : `${botName(partner)} doesn't bid — the team's bid is already set`,
      tone: "info",
    });
  }

  let next: SpadesState = { ...state, bids, handRevealed };

  const allBid = SEATS.every((s) => bids[s] != null);
  if (!allBid) {
    // nextBidder, not a raw nextSeat: a team blind bid can fill the
    // PARTNER'S slot before turn order naturally reaches them (see
    // isTeamBlindBid above), and asking an already-bid seat to bid
    // again would be a real bug, not just a redundant prompt — their
    // hand is already revealed and there's nothing left for them to
    // decide.
    return { state: { ...next, turn: nextBidder(bids, seat) }, events };
  }

  // All four bids are in. Per the rule, a pending Blind Nil exchange
  // happens now, before the first lead — `phase` stays "bid" through it;
  // reduceSkipExchange/reduceExchangeTake are what actually flip to "play".
  const blindNilSeat = SEATS.find((s) => {
    const b = bids[s];
    return b != null && b.nil && b.blind;
  });

  if (blindNilSeat !== undefined) {
    next = {
      ...next,
      turn: next.leader,
      exchange: { giver: blindNilSeat, taker: partnerOf(blindNilSeat), stage: "give" },
    };
  } else {
    next = { ...next, phase: "play", turn: next.leader };
    events.push(leadAnnounce(next.leader));
  }

  return { state: next, events };
}

function reduceSkipExchange(state: SpadesState): ReduceResult<SpadesState> {
  const ex = state.exchange;
  if (!ex) return { state, events: [] };
  const events: GameEvent[] = [];
  const handRevealed = { ...state.handRevealed, [ex.giver]: true };
  // Hero-relative, display-ordered — see reduceLook's doc.
  for (const id of handDisplayOrder(state.hands[ex.giver] ?? [], state.rules)) {
    events.push({ t: "flip", piece: id, faceUp: ex.giver === HERO });
  }
  events.push(leadAnnounce(state.leader));
  return { state: { ...state, phase: "play", exchange: null, handRevealed }, events };
}

function reduceExchangeGive(state: SpadesState, cards: [PieceId, PieceId]): ReduceResult<SpadesState> {
  const ex = state.exchange;
  if (!ex || ex.stage !== "give") return { state, events: [] };
  // A BOT giver's own hand is genuinely hidden from ITSELF — `playerView`
  // redacts it before `bot.choose` ever runs, same as it would a hero's
  // (see this file's top doc: "the GIVER still hasn't seen their own
  // hand"). `chooseExchange`'s blind pick therefore can only ever hand
  // back HIDDEN_CARD placeholders, never real ids — which two cards go is
  // explicitly "a genuinely blind pick, not a judged one" (that
  // function's own comment), so it doesn't matter WHICH two get
  // substituted here; the giver's own first two, in whatever order they
  // happen to sit in `hands` (itself arbitrary deal order), are exactly
  // as blind as any other choice. Passing the placeholders straight
  // through used to corrupt real state instead: the filter below never
  // matched a genuine id (so nothing was actually removed from the
  // giver's hand), and the placeholders themselves got recorded as
  // `exchange.given` and later spliced into the TAKER's real hand as two
  // literal "??" strings — which `legalPlays` correctly strips as
  // HIDDEN_CARD, silently shrinking that seat's playable hand for the
  // rest of the round.
  const realCards = cards.includes(HIDDEN_CARD) ? ([...(state.hands[ex.giver] ?? [])].slice(0, 2) as [PieceId, PieceId]) : cards;
  const giverHand = (state.hands[ex.giver] ?? []).filter((id) => !realCards.includes(id));
  const hands = { ...state.hands, [ex.giver]: giverHand };
  // Rendered face up in the discard zone once given — the taker (who is
  // always already able to see their own hand by this point, see the
  // file-top doc) needs to see what's on offer to choose what to send
  // back; a real table passes them as a face-down PACKET across to the
  // partner only in the sense that other opponents don't get to see them
  // first, not that the partner never does.
  //
  // KNOWN SMALL GAP: `applyEvent.ts`'s "play" case hardcodes
  // `faceUp: true` for every seat (correct for an ordinary trick play,
  // which really is visible to everyone) — unlike `flip`/`draw`, it has
  // no per-event override, so these 2 cards briefly render face up to
  // an OPPONENT-viewing hero too during this one animated step, before
  // `placements()`'s own reconcile (fixed above) corrects it back down.
  // Not fixed here: doing so means either threading viewer-awareness
  // into "play" (shared by every game's real trick-play mechanic) or
  // switching this specific transfer to a `move` event with a
  // caller-built `Placement`. Worth doing if this transient flash is
  // ever actually reported — nobody has hit it yet, unlike the
  // persistent reconcile-level leak this same investigation found.
  const events: GameEvent[] = realCards.map((id) => ({ t: "play", piece: id, from: ex.giver, to: "discard" }));
  return {
    state: { ...state, hands, exchange: { ...ex, stage: "take", given: realCards } },
    events,
  };
}

function reduceExchangeTake(state: SpadesState, cards: [PieceId, PieceId]): ReduceResult<SpadesState> {
  const ex = state.exchange;
  if (!ex || ex.stage !== "take" || !ex.given) return { state, events: [] };
  const given = ex.given;
  const takerHand = [...(state.hands[ex.taker] ?? []).filter((id) => !cards.includes(id)), ...given];
  const giverHand = [...(state.hands[ex.giver] ?? []), ...cards];
  const hands = { ...state.hands, [ex.taker]: takerHand, [ex.giver]: giverHand };

  const events: GameEvent[] = [
    // Hero-relative — see reduceLook's doc. The taker's hand is always
    // already visible to THEMSELVES by this point (the file-top doc
    // explains why), but that's a fact about the taker, not about
    // whichever seat the hero happens to be watching from.
    ...given.map((id) => ({
      t: "draw" as const,
      piece: id,
      from: "discard" as const,
      to: ex.taker,
      faceUp: ex.taker === HERO,
    })),
    // Still face down: the giver hasn't seen ANY of their hand yet, old
    // or new — the flip loop below reveals the whole 13-card hand as one
    // uniform moment, rather than these 2 popping face up a beat early.
    ...cards.map((id) => ({ t: "draw" as const, piece: id, from: "hand" as const, to: ex.giver, faceUp: false })),
  ];

  const handRevealed = { ...state.handRevealed, [ex.giver]: true };
  // Hero-relative, display-ordered — see reduceLook's doc.
  for (const id of handDisplayOrder(giverHand, state.rules)) {
    events.push({ t: "flip", piece: id, faceUp: ex.giver === HERO });
  }
  events.push(leadAnnounce(state.leader));

  return { state: { ...state, phase: "play", hands, handRevealed, exchange: null }, events };
}

function reducePlay(state: SpadesState, card: PieceId): ReduceResult<SpadesState> {
  const seat = currentSeat(state);
  if (seat === null) return { state, events: [] };

  const hands = { ...state.hands, [seat]: (state.hands[seat] ?? []).filter((id) => id !== card) };
  const trick = [...state.trick, { seat, card }];
  const ledSuit = state.trick.length === 0 ? effectiveSuit(card) : state.ledSuit;
  // Any spade (or joker) appearing on the table breaks spades for future
  // leads — led OR sluffed, not led-only.
  const trumpBroken = state.trumpBroken || isTrump(card);

  // Failing to follow the led suit is a permanent, public fact about
  // this seat's hand — the single strongest read in a trick game, and
  // unrecoverable later (see `SpadesState.voids`).
  let voids = state.voids;
  if (state.trick.length > 0 && state.ledSuit !== null && effectiveSuit(card) !== state.ledSuit) {
    const known = voids[seat] ?? [];
    if (!known.includes(state.ledSuit)) {
      voids = { ...voids, [seat]: [...known, state.ledSuit] };
    }
  }

  const events: GameEvent[] = [{ t: "play", piece: card, from: seat, to: "trick" }];
  if (seat !== HERO) {
    events.push({ t: "announce", seat, text: `${botName(seat)} plays ${spadesCardLabel(card)}`, tone: "info" });
  }

  let next: SpadesState = { ...state, hands, trick, ledSuit, trumpBroken, voids };

  if (trick.length < 4) {
    return { state: { ...next, turn: nextSeat(seat) }, events };
  }

  const winner = resolveTrick(
    trick.map((p) => ({
      seat: p.seat,
      card: { id: p.card, suit: effectiveSuit(p.card), isTrump: isTrump(p.card) },
    })),
    ledSuit,
    (id) => cardStrength(id, state.rules),
  );

  // Marks the winning card itself BEFORE the collect event, not
  // alongside it — collect's own HOLD.trick pause only starts counting
  // once the queue actually reaches it, so highlighting here means the
  // winner is visibly marked for that entire held beat, not just the
  // instant the cards start flying away.
  const winningCard = trick.find((p) => p.seat === winner)!.card;
  events.push({ t: "highlight", piece: winningCard, on: true });
  events.push({ t: "collect", pieces: trick.map((p) => p.card), to: winner });
  events.push({
    t: "announce",
    seat: winner,
    text: winner === HERO ? "You take the trick" : `${botName(winner)} takes the trick`,
    tone: winner === HERO ? "good" : "info",
  });

  const tricksWon = { ...state.tricksWon, [winner]: (state.tricksWon[winner] ?? 0) + 1 };
  const won = { ...state.won, [winner]: [...(state.won[winner] ?? []), ...trick.map((p) => p.card)] };
  next = { ...next, tricksWon, won, trick: [], ledSuit: null, leader: winner, turn: winner };

  const roundOver = SEATS.every((s) => (next.hands[s] ?? []).length === 0);
  if (!roundOver) return { state: next, events };

  return endRound(next, events);
}

/* ============================================================
   Round and match scoring
   ============================================================ */

function matchWinnerTeam(scores: Record<SeatId, number>, target: number, autoLoss: number): 0 | 1 | null {
  const t0 = scores[0] ?? 0;
  const t1 = scores[1] ?? 0;
  const t0Reached = t0 >= target;
  const t1Reached = t1 >= target;
  if (t0Reached || t1Reached) {
    // Both reaching target in the same deal is a near-impossible edge
    // case; the higher score wins, and an exact tie falls to team 0
    // arbitrarily but harmlessly.
    if (t0Reached && t1Reached) return t1 > t0 ? 1 : 0;
    return t0Reached ? 0 : 1;
  }
  if (t0 <= autoLoss) return 1;
  if (t1 <= autoLoss) return 0;
  return null;
}

function endRound(state: SpadesState, events: GameEvent[]): ReduceResult<SpadesState> {
  const bids: Record<SeatId, Bid> = {
    0: state.bids[0]!,
    1: state.bids[1]!,
    2: state.bids[2]!,
    3: state.bids[3]!,
  };
  const { deltas, bags, bagPenalty, bagsAdded } = scoreRound(bids, state.tricksWon, state.bags);

  const scores: Record<SeatId, number> = {};
  const nilsAttempted = { ...state.nilsAttempted };
  const nilsMade = { ...state.nilsMade };
  for (const seat of SEATS) {
    scores[seat] = (state.scores[seat] ?? 0) + (deltas[seat] ?? 0);
    if (bids[seat]!.nil) {
      nilsAttempted[seat] = (nilsAttempted[seat] ?? 0) + 1;
      if ((state.tricksWon[seat] ?? 0) === 0) nilsMade[seat] = (nilsMade[seat] ?? 0) + 1;
    }
  }

  const result: RoundResult = { bids, tricksWon: { ...state.tricksWon }, deltas, bags, bagPenalty, bagsAdded };
  events.push({ t: "score", deltas });
  events.push({ t: "roundEnd", round: state.round });

  const winningTeam = matchWinnerTeam(scores, state.target, state.autoLoss);
  let winningSeats: SeatId[] | null = null;
  let winner: SeatId | null = null;
  if (winningTeam !== null) {
    winningSeats = teammates(winningTeam);
    winner = winningSeats.includes(HERO) ? HERO : Math.min(...winningSeats);
    events.push({ t: "gameEnd", winner });
  }

  return {
    state: { ...state, scores, bags, nilsAttempted, nilsMade, result, winningSeats, winner },
    events,
  };
}

/* ============================================================
   GameDefinition surface
   ============================================================ */

export function currentSeat(state: SpadesState): SeatId | null {
  if (!state.dealt || state.result !== null || state.winner !== null) return null;
  if (state.exchange) {
    return state.exchange.stage === "give" ? state.exchange.giver : state.exchange.taker;
  }
  return state.turn;
}

export function isRoundOver(state: SpadesState): boolean {
  return state.result !== null;
}

export function isOver(state: SpadesState): boolean {
  return state.winner !== null;
}

export function legalActions(state: SpadesState, seat: SeatId): SpadesAction[] {
  if (currentSeat(state) !== seat) return [];

  if (state.exchange) {
    const ex = state.exchange;
    if (ex.stage === "give") {
      const hand = state.hands[ex.giver] ?? [];
      const out: SpadesAction[] = [{ t: "skipExchange" }];
      // The giver is always a Blind Nil bidder — their own hand is
      // ALWAYS still hidden from themselves at this exact point (see
      // "keeps a Blind Nil bidder's hand hidden... until the exchange
      // resolves" in rules.test.ts). The hero's own UI can still target
      // a SPECIFIC real card sight-unseen (tapping a face-down piece is
      // real, just not looked at) — combinations2(hand) covers that. A
      // bot cannot: `playerView` collapses every hidden card to the
      // SAME HIDDEN_CARD placeholder, so it has no way to reference "the
      // 3rd card" distinctly from "the 7th" — `[HIDDEN_CARD, HIDDEN_CARD]`
      // is the only action shape it could ever legitimately produce.
      // reduceExchangeGive resolves that placeholder into 2 real cards
      // itself (the choice is genuinely blind either way, so which two
      // doesn't matter).
      out.push({ t: "exchangeGive", cards: [HIDDEN_CARD, HIDDEN_CARD] });
      out.push(...combinations2(hand).map(([a, b]): SpadesAction => ({ t: "exchangeGive", cards: [a, b] })));
      return out;
    }
    const hand = state.hands[ex.taker] ?? [];
    return combinations2(hand).map(([a, b]): SpadesAction => ({ t: "exchangeTake", cards: [a, b] }));
  }

  if (state.phase === "bid") {
    if (isHiddenFromSelf(state, seat)) {
      // "look" is off the table once the partner already committed the
      // team to bidding blind — see `mustBidBlind`'s doc.
      const out: SpadesAction[] = mustBidBlind(state, seat) ? [] : [{ t: "look" }];
      if (minLegalBid(state, seat) === 0) out.push({ t: "blindNil" });
      // A blind numeric bid's minimum of 6 is never blocked by the Board
      // rule (6 always exceeds minLegalBid's ceiling of 4), so every
      // number from 6 to 13 is always offered.
      for (let tricks = 6; tricks <= 13; tricks++) out.push({ t: "blindBid", tricks });
      return out;
    }
    const out: SpadesAction[] = [];
    const floor = minLegalBid(state, seat);
    if (floor === 0) out.push({ t: "bid", tricks: 0, nil: true });
    for (let tricks = Math.max(1, floor); tricks <= 13; tricks++) out.push({ t: "bid", tricks, nil: false });
    return out;
  }

  return legalPlays(state, seat).map((card): SpadesAction => ({ t: "play", card }));
}

export function pieces(state: SpadesState): Record<PieceId, PieceMeta> {
  const out: Record<PieceId, PieceMeta> = {};
  for (const id of spadesDeck(state.rules)) out[id] = { kind: "card", face: id };
  return out;
}

export function placements(state: SpadesState, viewer: SeatId): PlacementMap {
  const out: PlacementMap = {};

  const active = currentSeat(state);
  const legalCardIds =
    active === viewer && !state.exchange && state.phase === "play"
      ? new Set(legalPlays(state, viewer))
      : null;

  for (const seat of SEATS) {
    const hand = state.hands[seat] ?? [];
    const isViewerHand = seat === viewer;
    const faceUp = isViewerHand && Boolean(state.handRevealed[seat]);
    // Only the viewer's own hand displays sorted — suit-grouped
    // (diamonds, clubs, hearts, spades), ascending strength within each
    // group, folding in the jokers/2-of-spades-high toggles for free via
    // cardStrength. Purely cosmetic: `state.hands` itself (what bots and
    // the exchange read from) is never reordered, so nothing about turn
    // order or a bot's own choices changes. Opponent hands stay in deal
    // order — always face-down here, so no one ever sees it.
    const ordered = isViewerHand ? handDisplayOrder(hand, state.rules) : hand;
    ordered.forEach((id, i) => {
      out[id] = {
        zone: "hand",
        seat,
        index: i,
        count: ordered.length,
        faceUp,
        dimmed: isViewerHand && legalCardIds && !legalCardIds.has(id) ? true : undefined,
      };
    });
  }

  state.trick.forEach((play, i) => {
    out[play.card] = { zone: "trick", seat: play.seat, index: i, count: state.trick.length, faceUp: true };
  });

  // Won tricks are not shown as a physical, ever-growing pile — the
  // `collect` event already flies them to the winner's pod (see
  // choreographer.ts's trick hold for the pause that makes that
  // readable), and each pod's own "won N" readout (YourBidBadge for the
  // hero) is the lasting record. `hidden` fades them to invisible right
  // where the collect animation left them, in place, rather than
  // stacking indefinitely or popping out of the placement map entirely
  // (which would skip the fade and unmount the piece outright).
  for (const seat of SEATS) {
    const wonCards = state.won[seat] ?? [];
    wonCards.forEach((id, i) => {
      out[id] = { zone: "collected", seat, index: i, count: wonCards.length, faceUp: false, hidden: true };
    });
  }

  if (state.exchange?.given) {
    // Visible only to the exchanging team, not to opponents watching the
    // same table — this used to be unconditionally `faceUp: true`
    // regardless of `viewer`, which leaked the exchanged cards' actual
    // ranks to an opponent-viewing hero for the whole "take" stage (not
    // just a transient flash — this is the RECONCILED state, restored
    // after every batch settles).
    const teamVisible = teamOf(viewer) === teamOf(state.exchange.giver);
    const [a, b] = state.exchange.given;
    out[a] = { zone: "discard", index: 0, count: 2, faceUp: teamVisible, fanned: true };
    out[b] = { zone: "discard", index: 1, count: 2, faceUp: teamVisible, fanned: true };
  }

  // Every card not accounted for above — the whole deck before the
  // opening deal, or the moment between a round's sweep and its next
  // deal — sits in the deck zone, which is the pile a `deal` event
  // actually needs to fly FROM. Without this, a card with no placement
  // entry is a no-op target for its own `deal` event (applyEvent.ts's
  // `moveTo` bails if the piece isn't already tracked), which is why the
  // very first deal of a game previously had nothing to animate from and
  // the hand just appeared instead of being dealt. Mirrors Dominoes'
  // boneyard, which is seeded the same way for the same reason.
  const deckIds = spadesDeck(state.rules).filter((id) => !out[id]);
  deckIds.forEach((id, i) => {
    out[id] = { zone: "deck", index: i, count: deckIds.length, faceUp: false };
  });

  return out;
}

function handDisplayOrder(hand: readonly PieceId[], rules: SpadesRules): PieceId[] {
  return sortHandForDisplay(hand, effectiveSuit, (id) => cardStrength(id, rules));
}

/**
 * Everything except the viewer's own hand is face down on a real table.
 * The viewer's own hand redacts too, exactly like any other, WHILE it is
 * hidden from the viewer themself (`isHiddenFromSelf`) — this single
 * rule is what makes a bot's blind-vs-look decision honest for free:
 * `useGameRuntime.revealBotTurn` always calls this before `bot.choose`,
 * so a bot forced through this path literally cannot see its own cards
 * until it resolves that, with no extra bot-side discipline required.
 */
export function playerView(state: SpadesState, viewer: SeatId): SpadesState {
  const hands: Record<SeatId, PieceId[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const seat of SEATS) {
    const hand = state.hands[seat] ?? [];
    const visible = seat === viewer && !isHiddenFromSelf(state, seat);
    hands[seat] = visible ? hand : hand.map(() => HIDDEN_CARD);
  }
  return { ...state, hands };
}

export function createSpades(
  rules: SpadesRules = { jokers: false, twoOfSpadesHigh: false },
): GameDefinition<SpadesState, SpadesAction> {
  return {
    id: "spades",
    name: "Spades",
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    setup: makeSetup(rules),
    reduce,
    legalActions,
    pieces,
    placements,
    playerView,
    currentSeat,
    isOver,
    startRound,
    isRoundOver,
    bots: spadesBots,
  };
}

export const spades = createSpades();

// Re-exported so callers do not have to reach into three modules to ask
// simple questions about a position. `HIDDEN_CARD` stays internal — only
// `playerView` needs it. The play screen defines its own local
// `seatName` from `botName` directly, matching Dominoes' page.tsx.
export { isBlindEligible, isHiddenFromSelf, legalPlays, minLegalBid, mustBidBlind, partnerOf, teamOf, teammates };
