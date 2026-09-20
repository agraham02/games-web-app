/**
 * Engine contracts.
 *
 * The load-bearing decision in this file: `reduce` returns BOTH the next
 * state AND the ordered list of things that happened. A snapshot alone
 * cannot drive a table animation — if you only diff state you have to
 * guess whether three cards moved because they were dealt, collected as
 * a trick, or swept into a discard, and each of those looks different.
 *
 * Nothing in src/engine imports React. Keep it that way: the engine must
 * be runnable in a test, a worker, or a future server.
 */

import type { Rng } from "./rng";

/** Seat 0 is ALWAYS the human. Bots occupy 1..n-1. */
export type SeatId = number;

export const HERO: SeatId = 0;

/**
 * Stable identity for a physical piece, e.g. "S-A", "H-10", "D6-3", "C-red".
 * Ids must be stable for the whole game: the piece layer keys off them, and
 * a changing id reads as "old piece destroyed, new piece created", which
 * throws away the animation.
 */
export type PieceId = string;

export type ZoneId =
  | "deck"
  | "discard"
  | "trick"
  | "board"
  | "hand"
  | "collected"
  | "center"
  /**
   * A fixed row of community-card slots — poker's flop/turn/river.
   * Unlike every other shared pile, position here is a fixed slot by
   * `index` (0-4), not a fan: community cards never overlap and are
   * revealed incrementally (3, then 1, then 1), each staying visible for
   * the rest of the hand once dealt.
   */
  | "community"
  /**
   * Poker's own pot-total readout — deliberately NOT `"center"`.
   * `"center"` (LRC's pot/dice overlay) draws at table-card scale, which
   * is fine when nothing else shares that space; poker's community row
   * does. No pieces are placed here — a decorative fanned chip pile used
   * to live in this zone and was dropped for a plain "$" total instead
   * (simpler, and structurally can't reweave into the community row the
   * way a growing fan could) — but the zone stays: it's still what a
   * game-specific pot badge reads its box from, geometrically anchored
   * below the community row with a real gap so the two can never overlap
   * by construction.
   */
  | "pot"
  /**
   * Poker's own remaining-deck stub — deliberately NOT `"deck"`.
   * `"deck"` is Rummy's stock pile, positioned dead centre (`cy`)
   * because Rummy has nothing else competing for that space. Poker does
   * (`"community"`/`"pot"` both live there), and unlike Rummy's stock —
   * whose visible depth is information a player plans around — nobody
   * acts on how many cards are left in a poker deck, so it doesn't need
   * a defended, central spot: a small tucked-away pile is enough. See
   * `"burnt"` for its sibling pile.
   */
  | "stub"
  /**
   * Poker's burnt cards — one face-down card set aside on every street
   * transition (see `rules.ts`'s `advanceStreet`). Deliberately NOT
   * `"discard"` for the same reason `"stub"` is not `"deck"`: Rummy's
   * discard is a real, centrally-positioned pile a player reads and
   * reasons about; a poker burn card is never looked at again once set
   * aside; it needs a real GameEvent to fly to (so the burn itself reads
   * as a beat, per this build's "nice, clean" street-transition ask) but
   * not Rummy's contested table-centre real estate afterward.
   */
  | "burnt"
  /**
   * BS's single central stack of played-but-unverified cards —
   * deliberately NOT `"deck"` or `"discard"`. Those two are offset from
   * table centre by `card.w/2 + 0.45*card.w` in opposite directions,
   * precisely so they can sit side by side; a game with only ONE pile
   * placed in either of them reads as visibly off-centre with nothing
   * beside it to explain why. And it cannot be `"trick"`: that box is
   * `card.h * 2.6` tall around `cy`, which leaves nowhere for the
   * face-up `"reveal"` row this pile hands its top cards to.
   *
   * So: its own box, dead centre, with `"reveal"` stacked above it and a
   * real gap between — the same "dedicated, non-overlapping by
   * construction" answer `"community"`/`"pot"`/`"stub"`/`"burnt"` are,
   * arrived at for the same reason rather than guessed at.
   *
   * Every card here is face down to EVERYONE, including whoever played
   * it. That is not a redaction compromise, it is the game: a claim is
   * worth doubting exactly because nobody can see it.
   */
  | "pile"
  /**
   * The cards from a challenged play, turned face up for everyone while
   * the table reads the verdict — BS's one moment of public truth.
   *
   * A row rather than a stack, because the whole point is that all 1-4
   * of them are legible at once. It sits ABOVE `"pile"` (see there for
   * why neither reuses an existing zone), and the cards reach it by a
   * real `move`, so the reveal is a gesture off the top of the pile
   * rather than an appearance.
   */
  | "reveal"
  /**
   * A chain of pieces laid end to end — dominoes' line of play. Unlike
   * every other zone, position here is NOT derived from index/count:
   * where a domino sits depends on the exact run of tiles before it
   * (a double advances the line by half as much as anything else), and
   * a played tile must never move again. See `Placement.cell`.
   */
  | "line"
  /** Face-down pool drawn from — dominoes' boneyard. */
  | "boneyard"
  | "offscreen";

/**
 * Where a piece is and how it should read. This is the ONLY thing the
 * piece layer consumes — it never sees game state.
 */
export interface Placement {
  zone: ZoneId;
  /**
   * Owning seat, for hand / collected / seat-anchored zones.
   *
   * On a piece in a SHARED zone this means the seat that piece is
   * ATTRIBUTED to, which is not always the seat whose area it sits in.
   * Rummy's board is the case that makes the distinction real: a meld
   * belongs to whoever laid it, but any seat may extend ("hit") it, and
   * the hit card scores for the hitter while still visually belonging to
   * the original run or set. So on a board piece this is the per-card
   * CONTRIBUTOR, deliberately independent of `group` (which meld it is
   * grouped under). Scoring attribution and visual grouping are allowed
   * to disagree, and these two fields are how they do it.
   */
  seat?: SeatId;
  /** Position within the zone (or within `group`). */
  index: number;
  /** Total pieces in the same zone/group — drives fan spread and overlap. */
  count: number;
  faceUp: boolean;
  /** Sub-collection: meld number on the board, trick number, train index. */
  group?: number;
  selected?: boolean;
  /** Lit as a legal target. */
  highlighted?: boolean;
  /**
   * "You may interact with this" — a strictly WEAKER claim than
   * `highlighted`, which means "this specific piece is known to work."
   *
   * The distinction exists because gating a tap on "is this already
   * known to be legal" forces the player to discover by trial and error
   * what a piece would even offer before they are allowed to look. A
   * Rummy discard pile is the motivating case: every card in it is
   * tappable (tapping stages a cancelable pickup preview), while only
   * the COMMIT step validates. Letting players explore a reversible
   * choice costs nothing; making them guess costs a lot.
   *
   * Transient, like `selected`/`highlighted` — included in the store's
   * `clearFlags()`.
   */
  tappable?: boolean;
  /**
   * Opt out of the touch "first tap previews, second tap acts" gate, so
   * a single tap always acts immediately even with no hover available.
   *
   * That gate exists to stop a fat-fingered, hard-to-undo PLAY on a
   * touchscreen. It is actively wrong for a tap that only toggles a
   * reversible selection with a separate action bar committing later
   * (Rummy's hand cards) — nothing has happened yet, so there is
   * nothing to protect against, and the extra tap just makes selecting
   * a card feel broken. Anything that plays a piece directly should NOT
   * set this.
   */
  instantAct?: boolean;
  /**
   * Owner tint for a piece in a shared zone — a small colour tab making
   * "this belongs to seat X" legible without the player first learning a
   * separate avatar-colour key. Any CSS colour. Cosmetic only; it never
   * affects layout or interactivity.
   */
  accentColour?: string;
  /**
   * Short initials rendered in a chip on the piece's top-right corner,
   * tinted by `accentColour`. For a shared zone where several players'
   * pieces sit side by side and "whose is this" is not otherwise
   * answerable from the piece itself — a Rummy board meld, where any
   * seat may hit any meld and each card scores for whoever played it.
   *
   * Deliberately per-PIECE rather than per-group, because that is the
   * granularity the question actually has: one run can carry cards from
   * three different players.
   */
  ownerTag?: string;
  /** Pushed back as an invalid target during a targeting mode. */
  dimmed?: boolean;
  /**
   * Faded to fully invisible (opacity 0) without leaving the placement
   * map — used for a piece that is logically "put away" (Spades' won
   * tricks) but should still fade out smoothly in place rather than pop
   * out of existence. Keeping it tracked, rather than omitting it from
   * `PlacementMap` entirely, is what keeps this consistent with "cards
   * never reparent": the piece never unmounts, it just animates opacity
   * to 0 like any other transition.
   */
  hidden?: boolean;
  /**
   * Spread a pile out instead of stacking it. Set on every piece in the
   * pile, because a piece is laid out without knowledge of its siblings
   * — that is what keeps layout O(1) per piece and lets each one
   * subscribe to its own placement alone.
   */
  fanned?: boolean;
  /**
   * Per-piece animation delay in milliseconds, for a batch of pieces
   * that should arrive staggered rather than simultaneously even though
   * they all land in the same store write — a collected trick, a sweep.
   * Set by applyEvent.ts at collect/sweep time; consumed once by
   * PieceLayer's motion transition. Transient, not structural — grouped
   * with `selected`/`highlighted`/`tappable`/`dimmed`/`fanned` in the
   * store's `clearFlags()`, NOT with `cell` (which is deliberately
   * excluded from that set). "Consumed once" falls out for free: every OTHER event
   * type's placement write (`deal`, `draw`, `play`, `flip`) leaves this
   * unset, which zeroes it for that piece the next time it moves.
   */
  motionDelayMs?: number;
  /**
   * Position in an abstract board-unit space, for zones where a piece
   * sits where the pieces before it put it rather than at an index in a
   * fan (`zone: "line"`).
   *
   * This exists because everywhere else, position is a pure function of
   * (index, count) — which is what lets layout stay O(1) per piece with
   * no sibling knowledge. A domino chain breaks that: a double advances
   * the line by one unit and everything else by two, so a tile's spot
   * depends on the whole run before it. The game does that walk once,
   * at the moment the piece is played, and stores the answer here. It is
   * then immutable for the rest of the round — which is the point. The
   * player's frame of reference is never re-derived under them; only the
   * camera that views this space moves (see `boardCamera` in
   * table/layout.ts).
   *
   * Units are the piece's short side, so a domino is 1x2. `rot` is the
   * final face rotation in degrees (0 = upright, high half at the top),
   * which is all the renderer needs to make matching pips touch.
   *
   * Structural, not a transient interaction flag — do NOT add it to the
   * store's `clearFlags`.
   */
  cell?: { x: number; y: number; rot: number };
}

export type PlacementMap = Record<PieceId, Placement>;

/**
 * What a piece physically is. Placement says WHERE it is; this says WHAT
 * it looks like — and unlike Placement, it never changes during a game,
 * so it's a setup-time concern (`GameDefinition.pieces`), not a per-turn
 * one. Lives here, not in the table store, because every game needs to
 * describe its own physical pieces regardless of how the React layer
 * happens to cache them.
 */
export type PieceKind = "card" | "tile" | "chip";

export interface PieceMeta {
  kind: PieceKind;
  /** Face identity: card id, "6-3" for a tile, a colour token for a chip. */
  face: string;
}

/* ============================================================
   Events — the animation vocabulary.
   ============================================================ */

export type Tone = "info" | "good" | "bad";

export type GameEvent =
  /** Deck is randomised. Carries the seed so a log replays exactly. */
  | { t: "shuffle"; seed: number }
  /** Opening deal. Choreographer staggers these automatically. */
  | { t: "deal"; piece: PieceId; to: SeatId; faceUp: boolean }
  /** Taking a piece from a shared pile into a hand. */
  | { t: "draw"; piece: PieceId; from: ZoneId; to: SeatId; faceUp: boolean }
  /** Hand -> table. */
  | { t: "play"; piece: PieceId; from: SeatId; to: ZoneId; group?: number }
  /** Arbitrary relocation when nothing more specific fits. */
  | { t: "move"; piece: PieceId; to: Placement }
  | { t: "flip"; piece: PieceId; faceUp: boolean }
  /**
   * Toggles the same border/glow `Placement.highlighted` already draws
   * for a legal target — reused here to mark a specific piece as
   * notable for a reason that isn't "you may act on this" (a trick's
   * winning card, say). Fired as its own event, ahead of whatever moves
   * the piece next, so it's visible for a real beat rather than only
   * during the instant that move's own animation begins.
   */
  | { t: "highlight"; piece: PieceId; on: boolean }
  /** Sweeping a won trick to a seat. Staggered inward. */
  | { t: "collect"; pieces: PieceId[]; to: SeatId }
  /**
   * Returns many pieces to a shared pile at once — a spent chain, or
   * every seat's leftover hand, gathered face down before a fresh deal.
   * Deliberately its OWN event rather than a batch of `move`s: a single
   * deliberate placement (`move`) and "clear the table" are different
   * GESTURES, and giving them the same choreography would force a
   * round-transition sweep to play at the same weight as one careful
   * move — which is what actually made an early version of a
   * many-tile sweep look sluggish. `move`'s own pace stays exactly what
   * it was; this gets its own, deliberately fast one (see `choreograph`).
   */
  | { t: "sweep"; pieces: PieceId[]; to: ZoneId }
  /**
   * A piece is brought down HARD — Caribbean dominoes' slam. Rides
   * immediately before the `move` that actually relocates the piece, so
   * the two play as one gesture: the move carries it from hand to board
   * on the usual spring while this drives the flourish over the top of
   * it (grow toward the viewer, then a fast drop), and `shake` names the
   * pieces the landing rattles.
   *
   * `shake` is an explicit list rather than "whatever is on the table",
   * because only the engine knows which pieces were already down when
   * the tile was played — and a shake that reached into a HAND would be
   * badly wrong. Emitting it as a real event rather than firing an
   * animation from a component is what puts it under the choreographer:
   * it obeys `skip()`, the speed multiplier and reduced motion for free.
   *
   * `final` marks the tile that ends a round (going out) — visually
   * louder than an ordinary slam (see `SLAM_KEYFRAMES_FINAL` in
   * presets.ts), and given its own, longer `choreograph` duration
   * (`DURATION.slamFinal`) so the extra motion has room to actually play.
   */
  | { t: "slam"; piece: PieceId; shake: PieceId[]; final: boolean }
  /**
   * A piece the viewer could not previously identify enters their picture
   * at the position it already occupies.
   *
   * Emitted ONLY by the multiplayer redaction layer (`session/redact.ts`),
   * never by a game's own `reduce` — a game has no notion of a viewer who
   * was being kept in the dark. When an opponent plays from a concealed
   * hand, the watching client holds an anonymous stand-in in that slot and
   * has never seen the real card; this puts the real piece exactly where
   * the stand-in was so the `play` that follows can fly out of the hand
   * rather than popping into being on the table.
   *
   * Rides immediately in front of that play with zero offset and zero
   * duration, so the two land in the same frame — the same shape `slam`
   * uses to ride in front of its own `move`, and for the same reason: two
   * events, one gesture.
   */
  | { t: "unmask"; piece: PieceId; at: Placement }
  /**
   * A deliberate beat with nothing to place. Some legal actions
   * genuinely move no piece — LRC's roll landing entirely on dots is
   * the first case — and without this, that turn snapped straight to
   * the next one with none of the settle time a real move gets,
   * reading as visibly inconsistent against every roll that DOES move
   * a chip. `reduce` should push this whenever it would otherwise
   * return an empty `events` array for an action that was legal and
   * genuinely happened.
   *
   * Carries no `ms` deliberately, unlike `think`: a bot's deliberation
   * time is a real domain quantity the BOT chooses, but "how long
   * should a beat with nothing to show last" is a motion decision, not
   * a rules one — `choreograph` answers it the same way it answers
   * every other event's duration, from `presets.ts`, not from
   * whatever the emitting game happened to guess.
   */
  | { t: "pause" }
  /**
   * Bot deliberation. A first-class event, not a setTimeout in the UI:
   * it is what makes an opponent feel like a person rather than a
   * function that returns instantly.
   */
  | { t: "think"; seat: SeatId; ms: number }
  /** Surfaced as a toast. Never blocks. */
  /**
   * Surfaced as a toast. Never blocks.
   *
   * `actor` is how a line gets a NAME without the engine knowing any
   * names. Offline that hardly mattered — one human, always seat 0, so
   * `seat === HERO ? "You" : botName(seat)` was correct by construction.
   * In a room it is wrong twice over: every viewer needs their own "You",
   * and everybody else needs the name of the person actually sitting
   * there rather than the bot name that seat would have had.
   *
   * So the engine writes the PREDICATE and names the actor by seat; the
   * client composes. `selfText` exists because English will not let one
   * template cover both — "Sam leads" and "You lead" differ in the verb,
   * not just the subject — so a line whose verb changes supplies the
   * second-person form alongside. Most do not need it: past tense agrees
   * either way, which is what POLICY already asks toasts to use.
   */
  | {
      t: "announce";
      seat?: SeatId;
      text: string;
      tone?: Tone;
      /** Whose line this is. The client prefixes their name. */
      actor?: SeatId;
      /** The `text` to use when the actor is the viewer. */
      selfText?: string;
      /**
       * The `tone` to use when the actor is the viewer.
       *
       * Same problem as `selfText` and the same shape of answer. "Takes
       * the trick" is good news to exactly one person at the table and
       * neutral news to everyone else, and games were writing
       * `tone: winner === HERO ? "good" : "info"` — which offline is
       * correct by construction and online colours the toast for the
       * wrong player. The engine states both readings; the client picks
       * the one that belongs to whoever is looking.
       */
      selfTone?: Tone;
    }
  | { t: "phase"; phase: string }
  | { t: "score"; deltas: Record<SeatId, number> }
  | { t: "roundEnd"; round: number }
  | { t: "gameEnd"; winner: SeatId };

export interface ReduceResult<S> {
  state: S;
  events: GameEvent[];
}

/* ============================================================
   Game definition
   ============================================================ */

export interface SetupOptions {
  seats: number;
  rng: Rng;
  /** Bot difficulty per seat, index-aligned. Seat 0 is ignored. */
  difficulty?: BotDifficulty[];
}

export type BotDifficulty = "casual" | "steady" | "sharp";

export interface BotStrategy<S, A> {
  id: string;
  /**
   * Chooses from `legalActions`. Must be pure given (state, seat, rng) so
   * bot behaviour replays deterministically alongside the deal.
   */
  choose(state: S, seat: SeatId, rng: Rng): A;
  /** Deliberation window, in ms, before the action is emitted. */
  thinkMs(state: S, seat: SeatId, rng: Rng): number;
}

export interface GameDefinition<S, A> {
  id: string;
  name: string;
  minSeats: number;
  maxSeats: number;

  setup(opts: SetupOptions): S;
  reduce(state: S, action: A): ReduceResult<S>;
  legalActions(state: S, seat: SeatId): A[];

  /**
   * The physical pieces this game uses and what they look like. Fixed
   * once `setup` runs — a game's piece SET never changes, only where
   * each one sits — so the runtime calls this once and caches it,
   * unlike `placements` which it calls after every batch of events.
   */
  pieces(state: S): Record<PieceId, PieceMeta>;

  /**
   * Full visual truth for a state. The choreographer applies events
   * incrementally for animation, then reconciles against this — so a
   * missed or malformed event self-corrects instead of desyncing the
   * board permanently.
   */
  placements(state: S, viewer: SeatId): PlacementMap;

  /** Redacts hidden information. Bots for seat N only ever see view(N). */
  playerView(state: S, viewer: SeatId): S;

  /**
   * Resolves any randomness a submitted action carries, authoritatively.
   *
   * `reduce` takes no rng on purpose, so a game whose move has a random
   * OUTCOME has to bake that outcome into the action before reducing —
   * LRC's roll is `{t:"roll", dice:[...]}`, already decided. Offline the
   * client resolving that is harmless, because offline the client IS the
   * authority. Online it is a cheat vector: a player who can author their
   * own dice can choose them.
   *
   * So the session re-resolves every human action through this before it
   * reduces, and whatever the client sent is discarded. Implement it only
   * if a human action can carry a random outcome; nearly nothing does.
   */
  completeAction?(state: S, action: A, seat: SeatId, rng: Rng): A;

  /**
   * What to do for a LIVE seat that does not act in time, and how long
   * to wait. Return null when this seat may take as long as it likes.
   *
   * Almost nothing needs one. A game where the table simply waits for you
   * is the normal case and is fine: everybody else is waiting on a person
   * who is right there. This exists for the case where they are NOT —
   * Rummy's claim race, where a discarded card is offered to several
   * seats at once and the whole table is parked until each answers.
   *
   * That was resolved by a `setTimeout` on the play page, which worked
   * exactly as long as the page was the only authority. Online it is a
   * stall waiting to happen: a backgrounded tab has its timers throttled
   * to about one a minute, so one player switching apps mid-race froze
   * the game for everyone else. A client-side clock cannot be what makes
   * a shared table progress.
   *
   * So the driver enforces it. The client still runs its own countdown —
   * it is what draws the ring — but it is now a nicety rather than the
   * mechanism, and the two are deliberately not tuned to fire together
   * (see Rummy's `CLAIM_GRACE_MS`).
   */
  deadline?(state: S, seat: SeatId): { ms: number; action: A } | null;

  /**
   * Is this actually a well-formed, legal action for this seat? Return a
   * reason to refuse it, or null to allow it.
   *
   * The session's gate is `legalActions(state, seat).length !== 0` — "is
   * there something this seat may do right now". That is the right
   * question for WHOSE TURN it is, and it is deliberately not
   * `currentSeat` (see `GameSession.submit`). But it says nothing about
   * whether the action that arrived is one of the things they may do, and
   * online the action is arbitrary JSON off a socket. Offline that gap
   * was unreachable, because the only thing authoring actions was the
   * UI's own action bar.
   *
   * Set membership against `legalActions` is not the answer. Poker
   * returns `{t:"bet", to: range.min}` as ONE representative of a
   * continuous range, so exact matching would refuse every bet but the
   * minimum. Only the game knows the shape of its own legality.
   *
   * Two real holes this closes, both reachable from a socket by a player
   * whose turn it genuinely is:
   *  - Spades: `reducePlay` filters the named card out of your hand (a
   *    no-op if you never held it) and adds it to the trick regardless —
   *    so you could play a card sitting in somebody else's hand, and
   *    piece ids are guessable.
   *  - Poker: `Math.round("abc")` is `NaN`, `Math.max/min` propagate it,
   *    and `if (added <= 0)` is FALSE for `NaN` — so it writes through to
   *    every stack and the table's money becomes `NaN`.
   *
   * Implement it wherever `reduce` would believe something a stranger
   * said. A game that omits it keeps the old behaviour, which is correct
   * for LRC: its only action carries a roll, and `completeAction` already
   * throws the client's away.
   */
  validate?(state: S, seat: SeatId, action: A): string | null;

  currentSeat(state: S): SeatId | null;
  isOver(state: S): boolean;

  /**
   * Deals (or re-deals) and returns the events that show it happening.
   * The runtime calls this once before the first turn, and again each
   * time the player continues from a round summary.
   *
   * Optional: a single-round game (LRC) sets up entirely in `setup` and
   * omits this. Implementing it buys an ANIMATED opening deal, which
   * `setup` alone cannot give you — `setup` returns state only, so a game
   * that deals there has its cards simply appear. A game with this hook
   * returns an undealt state from `setup` (everything still in the deck
   * or boneyard) and lets the deal fly out of the pile like a real one.
   *
   * The piece SET must not change between rounds — `pieces()` is called
   * once and cached.
   */
  startRound?(state: S, rng: Rng): ReduceResult<S>;

  /**
   * True between a round ending and `startRound` being called again.
   * Games that run a single round omit this.
   *
   * `currentSeat` should return null while this is true; the runtime
   * stops pacing turns and shows the round summary instead.
   */
  isRoundOver?(state: S): boolean;

  bots: Record<BotDifficulty, BotStrategy<S, A>>;
}
