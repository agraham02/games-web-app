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
  | { t: "announce"; seat?: SeatId; text: string; tone?: Tone }
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
