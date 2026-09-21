"use client";

/**
 * The flat piece layer.
 *
 * Every card, tile and chip in the game is rendered exactly once, here,
 * in a single absolutely-positioned layer. Pieces never move between
 * parent components — a card "in your hand" and the same card "in the
 * trick" are the same DOM node at different transforms.
 *
 * This is the decision the whole animation system rests on:
 *
 *  - no reparenting, so no unmount/remount and no lost animation state
 *  - no z-index fights between a Hand and a Trick component
 *  - one source of truth for position, so a resize is just a recompute
 *  - only transform + opacity animate, so it runs on the compositor
 *
 * The alternative — Motion's `layoutId` shared-element transitions —
 * does not survive this use case: it cannot animate SVG, it is disabled
 * during window resize, and 52 simultaneous transitions across mounting
 * and unmounting components is fragile in a way this is not.
 */

import { memo, useEffect } from "react";
import { motion, useAnimate } from "motion/react";
import { HERO, type PieceId } from "@/engine/types";
import { CardBack, CardFace } from "@/ui/primitives/CardFace";
import { TileBack, TileFace } from "@/ui/primitives/TileFace";
import { ChipFace } from "@/ui/primitives/ChipFace";
import { artSize, baseSize, layoutPiece } from "./layout";
import {
  useBoardView,
  useDiscardCount,
  useDiscardPanEnabled,
  useDiscardScroll,
  useGeometry,
  useHandOrder,
  useHandScroll,
  useHeroHoverIndex,
  useHeroTurnActive,
  usePieceIds,
  usePlacement,
  usePieceMeta,
  useSetHeroHoverIndex,
  useTableStore,
} from "./store";
import {
  SHAKE_KEYFRAMES,
  SHAKE_KEYFRAMES_FINAL,
  SHAKE_TIMING,
  SHAKE_TIMING_FINAL,
  SLAM_FINAL_LAND_MS,
  SLAM_KEYFRAMES,
  SLAM_KEYFRAMES_FINAL,
  SLAM_LAND_MS,
  SLAM_TIMING,
  SLAM_TIMING_FINAL,
  prefersReducedMotion,
  supportsHover,
  TRANSITIONS,
} from "@/motion/presets";
import { onSlam } from "./fx";

/** Below this on-screen width, pips become mud — draw the simple face. */
const DETAIL_THRESHOLD_PX = 52;

/** Fraction of the hero hand's own scale a card settles to while it
 * isn't the hero's turn to act at all — small enough to read as "at
 * rest," not so small it looks broken or hard to read. Grows back via
 * the same spring transition every other piece move already uses, no
 * special-casing needed. */
const INACTIVE_HAND_SCALE = 0.94;

/** How solid a piece has to be drawn before a tap on it counts. See
 * `interactive` below for why a faded piece must be inert, and
 * `FanSlot.visible` for what fades them. */
const MIN_TAPPABLE_OPACITY = 0.5;

/**
 * How far the hovered card's neighbours are pushed aside, as a fraction
 * of the piece's own DRAWN width. Deliberately modest: the push only has
 * to break the overlap enough to read the hovered card's edge, and a
 * bigger shove makes the whole hand lurch on every pointer move.
 *
 * Measured against `artSize`, not the base box — a domino inscribes
 * itself in a card-shaped box at roughly 70% of its width, so the same
 * constant against the box fanned a tile rack visibly wider than a card
 * hand. See `artSize`'s own doc in layout.ts.
 */
const HOVER_SPREAD_NEAR = 0.22;
const HOVER_SPREAD_FAR = 0.09;

/**
 * Extra lift/scale/x-shift for a hero-hand card at `index`, relative to
 * whichever index is currently hovered (or, on touch, tap-previewed) —
 * the card under the pointer rises and grows most, tapering off over
 * its 1-2 nearest neighbours, like a real hand fanning open under a
 * finger. The neighbours also get pushed sideways, AWAY from the
 * hovered card, so it doesn't just rise out of a stack it's still
 * buried in — this matters far more once a hand is dense enough to
 * heavily overlap (a big Rummy hand) than it does at Spades' fixed 13.
 *
 * `artWidth` is the drawn art (see the constants above); `cardHeight`
 * stays the BASE box height, because the lift is measured against the
 * slot a piece occupies rather than the ink inside it, and every hand is
 * laid out on that box.
 *
 * Lift/x-shift are FRACTIONS of the piece's own rendered size, not fixed
 * px amounts — a flat px value read as barely-there on `wide` density's
 * much larger cards. Pure and cheap enough not to bother memoizing.
 */
function handHoverLift(
  index: number,
  hoverIndex: number | null,
  artWidth: number,
  cardHeight: number,
): { liftPx: number; xPx: number; scale: number } {
  if (hoverIndex === null) return { liftPx: 0, xPx: 0, scale: 1 };
  const distance = Math.abs(index - hoverIndex);
  const side = Math.sign(index - hoverIndex); // -1 left, 0 the card itself, +1 right
  switch (distance) {
    case 0:
      return { liftPx: -cardHeight * 0.32, xPx: 0, scale: 1.08 };
    case 1:
      return { liftPx: -cardHeight * 0.16, xPx: side * artWidth * HOVER_SPREAD_NEAR, scale: 1.04 };
    case 2:
      return { liftPx: -cardHeight * 0.06, xPx: side * artWidth * HOVER_SPREAD_FAR, scale: 1.015 };
    default:
      return { liftPx: 0, xPx: 0, scale: 1 };
  }
}

export interface PieceLayerProps {
  onPieceTap?: (id: PieceId) => void;
}

/**
 * While a piece is being slammed it has to draw over everything —
 * including the hand it just left and any pod it flies past. Above
 * `Z_SELECTED` (5000), and set imperatively rather than through the
 * placement map because it is a hard switch, not something to tween: it
 * lands on the same frame the grow starts and is put back on the same
 * frame the piece settles. This is the one place the piece layer touches
 * z-index outside `layoutPiece`, and it is deliberately transient.
 */
const Z_SLAM = 6000;

/**
 * A piece id, made safe to sit inside a QUOTED attribute selector.
 * `CSS.escape` is the wrong tool here — it escapes identifiers, not
 * string contents, so it would turn `6-3` into `6\-3` (which happens to
 * still match, by accident) and it is not guaranteed to exist outside a
 * real browser. Inside quotes only the quote and the backslash actually
 * need escaping.
 */
export function fxSelector(id: PieceId): string {
  return `[data-fx="${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

/**
 * Drives the slam, for the WHOLE layer, from one hook.
 *
 * `useAnimate` gives a `scope` ref plus an `animate()` whose CSS
 * selectors are scoped to it — so one subscription and one hook here can
 * reach any piece by `[data-fx="<id>"]`, instead of every `<Piece>`
 * subscribing to an fx channel it will almost never be the target of.
 * Nothing re-renders when a slam fires; this is exactly the "trigger
 * animations from events outside React's render cycle" case the hook
 * exists for.
 *
 * It also solves replay for free. A declarative keyframe array set to an
 * identical value is not guaranteed to run a second time, so slamming
 * the same tile twice would need a changing token threaded through the
 * render. Calling `animate()` again simply plays it again.
 */
function useSlamFx() {
  const [scope, animate] = useAnimate<HTMLDivElement>();

  useEffect(
    () =>
      onSlam(({ piece, shake, final }) => {
        const root = scope.current;
        if (!root) return;
        // MotionConfig's reducedMotion governs motion COMPONENTS; this
        // is an imperative call on a plain div, so it needs its own gate
        // or the one animation most worth suppressing would survive.
        if (prefersReducedMotion()) return;

        const slamKeyframes = final ? SLAM_KEYFRAMES_FINAL : SLAM_KEYFRAMES;
        const slamTiming = final ? SLAM_TIMING_FINAL : SLAM_TIMING;
        const shakeKeyframes = final ? SHAKE_KEYFRAMES_FINAL : SHAKE_KEYFRAMES;
        const shakeTiming = final ? SHAKE_TIMING_FINAL : SHAKE_TIMING;
        const landMs = final ? SLAM_FINAL_LAND_MS : SLAM_LAND_MS;

        const target = root.querySelector<HTMLElement>(fxSelector(piece));
        if (target) {
          // The piece's own parent — the positional root — is what has
          // to come forward; lifting the wrapper alone would leave it
          // inside a stacking context that is still behind the hand.
          const lifted = target.parentElement;
          const restore = lifted?.style.zIndex ?? "";
          if (lifted) lifted.style.zIndex = String(Z_SLAM);
          void animate(target, slamKeyframes, slamTiming).then(() => {
            if (lifted) lifted.style.zIndex = restore;
          });
        }

        // Only what was already on the table. The engine decides that
        // list (see the `slam` event's doc) — a hand tile can never
        // appear in it, which is the whole point.
        const rattled = shake
          .map((id) => root.querySelector<HTMLElement>(fxSelector(id)))
          .filter((el): el is HTMLElement => el !== null);
        if (rattled.length > 0) {
          void animate(rattled, shakeKeyframes, {
            ...shakeTiming,
            // Rattle on IMPACT, not on the wind-up — a board that starts
            // shaking as the arm goes up reads as the table wobbling by
            // itself.
            delay: landMs / 1000,
          });
        }
      }),
    [animate, scope],
  );

  return scope;
}

export function PieceLayer({ onPieceTap }: PieceLayerProps) {
  const ids = usePieceIds();
  const geometry = useGeometry();
  const scope = useSlamFx();
  if (!geometry) return null;

  return (
    <div className="piece-layer" ref={scope}>
      {ids.map((id) => (
        <Piece key={id} id={id} onTap={onPieceTap} />
      ))}
    </div>
  );
}

interface PieceProps {
  id: PieceId;
  onTap?: (id: PieceId) => void;
}

const Piece = memo(function Piece({ id, onTap }: PieceProps) {
  // The narrow subscriptions that keep a 52-card deal cheap: this
  // component re-renders only when THIS piece's placement changes.
  const placement = usePlacement(id);
  const meta = usePieceMeta(id);
  const geometry = useGeometry();
  // Only pieces laid in board space care where the board's camera
  // currently sits, and the camera moves every time the chain grows —
  // so this subscription is deliberately conditional. A hand tile or a
  // face-down boneyard tile reads `null` and stays out of the churn,
  // which is the same narrowness the per-piece placement selector buys.
  const board = useBoardView(Boolean(placement?.cell));
  // The hero's own hand, regardless of face-up/down — dim/shrink-when-
  // not-your-turn and click-eligibility both apply even to a still-
  // hidden blind hand. Selecting a constant when this is false means
  // the subscriptions below never trigger a re-render for any OTHER
  // piece, no matter how often the real values change (see
  // `useHeroTurnActive`'s and `useHeroHoverIndex`'s own docs — the same
  // trick `useBoardView` above already uses).
  // Whose hand this is, from the geometry's point of view rather than from
  // a hardcoded seat 0. Online the viewer sits wherever the server seated
  // them, and a spectator's `viewerSeat` is null — so no hand on the table
  // gets the hero treatment, which is exactly right for somebody watching.
  const viewerSeat = geometry ? geometry.viewerSeat : HERO;
  const isHeroHand = Boolean(
    placement &&
      placement.zone === "hand" &&
      viewerSeat !== null &&
      (placement.seat ?? HERO) === viewerSeat,
  );
  // Hover/tap-preview needs a real face to preview — meaningless (and,
  // on touch, actively in the way of a direct tap-to-select) on a card
  // that's still face down, e.g. a blind-eligible hero's own hand before
  // they look, or the giver's side of the Blind Nil exchange.
  const hoverEligible = isHeroHand && Boolean(placement?.faceUp);
  // A REAL mouse only — gates the mouseenter/mouseleave handlers below,
  // separately from `hoverEligible` itself (which still gates the lift
  // visual and `onCardClick`'s preview branch on touch). Mobile browsers
  // fire a synthetic mouseenter/mouseover as part of their tap
  // compatibility shim, moments BEFORE the click — without this gate,
  // that ghost event set `heroHoverIndex` to the tapped card's own index
  // ahead of `onCardClick`'s "is this already previewed?" check, making
  // a fresh tap look pre-previewed and fire `onTap` immediately instead
  // of just previewing (and, on a second tap of a DIFFERENT card, the
  // same race made it play THAT card instead of moving the preview to
  // it) — intermittent, because whether a given browser/device fires the
  // ghost event, and exactly when, isn't guaranteed. `supportsHover()`
  // is false on a genuine touch device, so this fully excludes it there.
  const mouseHoverEligible = hoverEligible && supportsHover();
  const heroTurnActive = useHeroTurnActive(isHeroHand);
  const hoverIndex = useHeroHoverIndex(hoverEligible);
  const setHeroHoverIndex = useSetHeroHoverIndex();
  // Three more enabled-gated slices, each reaching exactly the pieces
  // that need it and nothing else. This gating matters more here than
  // anywhere: a pan value changes on every pointermove, so subscribing
  // all 52 pieces to it would re-render the whole table per frame of a
  // drag — the precise cost this store exists to avoid.
  const isFannedDiscard = Boolean(placement?.zone === "discard" && placement.fanned);
  const isDeck = placement?.zone === "deck";
  const discardScroll = useDiscardScroll(isFannedDiscard);
  // The deck reads the pile's DEPTH, not its pan — and only in a game
  // that pans at all. `useDiscardPanEnabled` is a boolean selector for
  // exactly that reason: it tells the deck panning is in play without
  // re-rendering it on every frame of one.
  const discardPan = useDiscardPanEnabled();
  const discardCount = useDiscardCount(isDeck && discardPan);
  const handScroll = useHandScroll(isHeroHand);
  const handOrder = useHandOrder(isHeroHand);

  if (!placement || !geometry || !meta) return null;

  // Where this card sits in the hand AS DISPLAYED. Everything positional
  // — the fan slot, the stacking order, and the hover neighbourhood —
  // must agree on this one number.
  //
  // `placement.index` is the game's own order; a player-chosen sort
  // overrides it. Mixing the two is subtly broken rather than obviously
  // so: `heroHoverIndex` is a HAND INDEX, so comparing it against
  // `placement.index` while the cards are LAID OUT by the sorted index
  // lifts whichever cards happen to be neighbours in the unsorted order
  // — cards scattered across the fan. It looks correct under exactly one
  // sort (by suit), because `placements()` already suit-sorts the
  // viewer's hand and the two orders coincide there.
  const handIndex = (isHeroHand ? handOrder?.[id] : undefined) ?? placement.index;

  const t = layoutPiece(placement, geometry, {
    kind: meta.kind,
    board,
    // `undefined`, not a number, for anything that doesn't participate:
    // layout distinguishes "this game does not pan" from "this game pans
    // and is at 0", which is what keeps every existing game's fan
    // byte-identical to what it was.
    discardScroll: discardScroll ?? undefined,
    discardCount: isDeck && discardPan ? discardCount : undefined,
    handScroll: handScroll ?? undefined,
    handIndex,
  });
  const base = baseSize(geometry);
  const onScreenW = base.w * t.scale;
  const detail = onScreenW < DETAIL_THRESHOLD_PX ? "index" : "full";
  const hover = hoverEligible
    ? handHoverLift(handIndex, hoverIndex, artSize(geometry, meta.kind).w, base.h)
    : { liftPx: 0, xPx: 0, scale: 1 };
  // Settles to a slightly smaller rest size while it isn't the hero's
  // turn at all — see INACTIVE_HAND_SCALE's own doc.
  const turnScale = isHeroHand && !heroTurnActive ? INACTIVE_HAND_SCALE : 1;

  const interactive =
    Boolean(onTap) &&
    // A dimmed piece reads as "not currently usable" — a hand tile with
    // no legal play, a discard-pile card out of reach. The pointer must
    // agree with that at the input level, not just visually: leaving it
    // clickable-but-ignored is what a dead button feels like, and this
    // is the one flag the piece layer can check without knowing why a
    // game dimmed it.
    !placement.dimmed &&
    // Nothing responds to a tap while it isn't the hero's turn at all —
    // keeps the pointer honest about the same dim+shrink the piece is
    // showing below, rather than leaving a clickable-looking dead spot.
    heroTurnActive &&
    // `tappable` is a strictly weaker claim than `highlighted` — "you
    // may interact with this" rather than "this is known to work". A
    // Rummy discard card stages a cancelable preview on tap, and gating
    // that on already-being-legal would force the player to find a
    // workable depth by trial and error before being allowed to look.
    (isHeroHand || Boolean(placement.highlighted) || Boolean(placement.tappable)) &&
    // You cannot tap what you cannot see. A pannable fan fades its
    // pieces out as they cross the edge of the region they belong to
    // (see `FanSlot.visible`), and those cards keep their DOM node at
    // its real, now-invisible position — under a seat pod, under the
    // board sheet, off the screen. Leaving them clickable puts live hit
    // targets in places the player has every reason to read as empty
    // felt or as someone else's chrome. Half-visible is the cut: a card
    // still mostly inside its region is one the player is aiming at.
    t.opacity >= MIN_TAPPABLE_OPACITY;

  // Touch has no hover to preview with, so an eligible card's tap does
  // double duty: the FIRST tap previews it (the same lift/spread a mouse
  // hover gives for free) without acting, and only a SECOND tap on that
  // SAME, already-previewed card actually plays it — tapping a different
  // card just moves the preview instead of acting on it. A mouse (or a
  // card with nothing to preview, e.g. a still face-down one) acts on
  // the first tap, exactly as it always has — hover already did the
  // previewing for that input.
  const onCardClick = () => {
    if (!interactive) return;
    // ...unless the piece asks out. That two-tap gate exists to stop a
    // fat-fingered, hard-to-undo PLAY; for a tap that only toggles a
    // reversible selection with an action bar committing later, nothing
    // has happened yet, so there is nothing to protect against and the
    // extra tap just makes selecting a card feel broken. See
    // `Placement.instantAct`.
    if (hoverEligible && !placement.instantAct && !supportsHover()) {
      if (hoverIndex !== handIndex) {
        setHeroHoverIndex(handIndex);
        return;
      }
      setHeroHoverIndex(null);
    }
    onTap?.(id);
  };

  return (
    <motion.div
      initial={false}
      onMouseEnter={mouseHoverEligible ? () => setHeroHoverIndex(handIndex) : undefined}
      onMouseLeave={
        mouseHoverEligible
          ? () => {
              // Guarded against the live store value, not the closed-over
              // `hoverIndex` prop: overlapping fanned cards can fire this
              // piece's `mouseleave` after its neighbour's `mouseenter`
              // already moved the hover elsewhere, and a stale closure
              // would wrongly clear that neighbour's hover right after it
              // was set.
              if (useTableStore.getState().heroHoverIndex === handIndex) {
                setHeroHoverIndex(null);
              }
            }
          : undefined
      }
      animate={{
        x: t.x + hover.xPx,
        y: t.y + hover.liftPx,
        rotate: t.rotate,
        scale: t.scale * hover.scale * turnScale,
        opacity: t.opacity,
        // Two DIFFERENT dim reasons, two different treatments — they
        // used to share one grayscale filter, which was wrong for the
        // "not your turn" case: it read as "this specific card is
        // illegal," which isn't true during bidding (nothing has been
        // chosen yet) or while just waiting out an opponent's trick-play
        // turn. The two never overlap in practice (`dimmed` is only ever
        // computed while it genuinely IS the hero's turn to play — see
        // `placements()`), so this is a plain if/else, not a priority
        // fight.
        //
        // Illegal-target dimming (POLICY.md: "dim, don't hide") stays a
        // grayscale/darken filter rather than reduced opacity — a light
        // card face loses too much legibility fading toward the felt,
        // and this reuses the exact "disabled" idiom SeatRing already
        // uses for an eliminated seat's avatar. `filter` is not a
        // compositor-only property the way transform/opacity are (see
        // CLAUDE.md), but at hand-sized piece counts (a dozen or so
        // cards, not a 52-card deal) the cost is not visible.
        //
        // "Not your turn at all" is a much softer brightness-only dip —
        // no grayscale — so the hand still reads as a normal, colourful
        // hand at rest, just visually receded. This matters most during
        // bidding, where every seat's hand dims while waiting its turn
        // and nothing has actually been ruled illegal yet.
        filter: placement.dimmed
          ? "grayscale(0.85) brightness(0.78)"
          : isHeroHand && !heroTurnActive
            ? "brightness(0.86)"
            : "none",
      }}
      // A batch of pieces (a collected trick, a sweep) can all receive
      // their new `animate` target in the same React commit yet still
      // arrive staggered — Motion holds each one's interpolation start
      // individually via `delay`, which is exactly what
      // `applyEvent.ts`'s per-piece `motionDelayMs` assumes exists.
      // Zero for every ordinary move (deal/draw/play/flip never set it).
      // `filter` gets its own, un-delayed transition: dimming is a
      // legality readout, not part of the piece's physical arrival, so
      // it should react immediately rather than inherit a stagger meant
      // for a batch of pieces landing in sequence.
      transition={{
        default: { ...TRANSITIONS.deal, delay: (placement.motionDelayMs ?? 0) / 1000 },
        filter: TRANSITIONS.ui,
      }}
      onClick={interactive ? onCardClick : undefined}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: base.w,
        height: base.h,
        // Deliberately NOT bumped on hover — stacking order stays
        // exactly what the base layout gives every piece, full stop.
        // Z-index isn't animatable (Motion can't tween it, unlike
        // x/y/scale/opacity), so nudging it here landed as an instant,
        // out-of-sync "pop" the moment hover started or ended — visually
        // read as the card snapping around rather than smoothly rising.
        // Hover is transform-only now, matching the rest of this file's
        // "only transform and opacity animate" rule.
        zIndex: t.z,
        transformOrigin: "center center",
        pointerEvents: interactive ? "auto" : "none",
        cursor: interactive ? "pointer" : undefined,
        // Hint the compositor without permanently promoting every piece.
        willChange: "transform",
      }}
    >
      {/* The flourish surface — see `useSlamFx` below. A plain div, not a
          motion component: it is driven imperatively and only ever by
          `animate()`, so it costs one DOM node per piece and no extra
          React work at all. It has to be its OWN element because the
          root above owns absolute x/y/scale on a spring, and a slam's
          relative scale keyframes would fight it; composing them on
          nested elements is the same trick `Flipper`'s rotateY already
          uses. Kept outside Flipper so its `preserve-3d` context is
          undisturbed, and outside the highlight glow below so a
          shake moves the piece rather than its decoration. */}
      <div
        data-fx={id}
        style={{
          width: base.w,
          height: base.h,
          transformOrigin: "center center",
        }}
      >
      {meta.kind === "chip" ? (
        // Chips never flip — no game here deals one face down. Skip
        // Flipper's dual-face 3D wrapper entirely: one motion.div
        // instead of two per piece, which matters once a game like LRC
        // can have 30 chips on screen at once.
        <PieceFace kind={meta.kind} face={meta.face} w={base.w} h={base.h} detail={detail} />
      ) : (
        // Cards AND tiles both have a real face-down state — dominoes
        // deal into hidden hands and draw from a face-down boneyard, so
        // a tile that only ever showed its pips would leak every
        // opponent's hand straight onto the table.
        <Flipper
          faceUp={placement.faceUp}
          w={base.w}
          h={base.h}
          back={
            meta.kind === "tile" ? (
              <TileBack w={base.w} h={base.h} ariaHidden={placement.faceUp} />
            ) : (
              <CardBack w={base.w} h={base.h} ariaHidden={placement.faceUp} />
            )
          }
        >
          <PieceFace
            kind={meta.kind}
            face={meta.face}
            w={base.w}
            h={base.h}
            detail={detail}
            ariaHidden={!placement.faceUp}
          />
        </Flipper>
      )}
      </div>

      {placement.highlighted ? (
        <>
          {/* Pulsing glow BEHIND the piece — same radial-gradient/blur
              idiom as PhaseScreens' TurnIndicator halo, so "something
              wants your attention here" reads as one consistent motion
              vocabulary across the table, not two unrelated ones. A
              static border alone (the previous treatment) was too easy
              to miss over felt; this is what actually catches the eye
              for the trick's winning card, and doubles as a livelier
              "selected" cue for the Blind Nil exchange's held cards.
              Quick cycle (0.45s) rather than TurnIndicator's slow 1.8s
              breathe — the winning-card case only has HOLD.trick's 0.9s
              to read in before `collect`'s moveTo clears `highlighted`
              outright, so it needs to land 1-2 full pulses in that
              window, not a single slow ramp that gets cut off. */}
          <motion.span
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              inset: -6,
              borderRadius: base.w * 0.16,
              background:
                "radial-gradient(closest-side, rgb(212 175 106 / 0.65), transparent 72%)",
              filter: "blur(6px)",
            }}
            animate={{ opacity: [0.35, 0.95, 0.35], scale: [0.94, 1.05, 0.94] }}
            transition={{ duration: 0.45, repeat: Infinity, ease: "easeInOut" }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              // Drawn INSIDE the piece's own footprint, not extending
              // past it (an earlier version did). A hand can pack pieces
              // closer together than an outward border's reach — a
              // domino hand does, by design — and an outward border on
              // two adjacent highlighted pieces merges into one shape
              // instead of reading as two. Inset never has that failure
              // mode, at any spacing. Thickened from 2px to 3px — the
              // pulsing glow above does most of the new work, but the
              // border itself was also part of "too subtle."
              inset: 2,
              borderRadius: base.w * 0.11,
              border: "3px solid var(--color-brass-400)",
              boxShadow: "var(--shadow-glow-inset)",
              pointerEvents: "none",
            }}
          />
        </>
      ) : null}

      {/* Whose card this is, when the piece sits somewhere several
          players' pieces mingle and the face alone cannot answer it —
          a board meld, where any seat may hit any meld and each card
          scores for whoever actually played it. */}
      {placement.ownerTag ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: -3,
            right: -3,
            minWidth: Math.round(base.w * 0.3),
            padding: "1px 3px",
            borderRadius: 999,
            background: placement.accentColour ?? "var(--color-brass-300)",
            color: "var(--color-felt-950)",
            fontSize: Math.max(7, Math.round(base.w * 0.16)),
            lineHeight: 1.35,
            fontWeight: 800,
            textAlign: "center",
            boxShadow: "0 1px 3px rgb(0 0 0 / 0.45)",
            pointerEvents: "none",
          }}
        >
          {placement.ownerTag}
        </span>
      ) : null}
    </motion.div>
  );
});

/**
 * Two faces back to back in 3D. Rotating the container swaps which one
 * the viewer sees, so a flip is a transform rather than a content swap.
 */
function Flipper({
  faceUp,
  w,
  h,
  back,
  children,
}: {
  faceUp: boolean;
  w: number;
  h: number;
  /** The reverse face — a card back or a tile back, per piece kind. */
  back: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={false}
      animate={{ rotateY: faceUp ? 0 : 180 }}
      transition={TRANSITIONS.flip}
      style={{
        width: w,
        height: h,
        transformStyle: "preserve-3d",
        position: "relative",
      }}
    >
      <div style={{ position: "absolute", inset: 0, backfaceVisibility: "hidden" }}>
        {children}
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          backfaceVisibility: "hidden",
          transform: "rotateY(180deg)",
        }}
      >
        {back}
      </div>
    </motion.div>
  );
}

function PieceFace({
  kind,
  face,
  w,
  h,
  detail,
  ariaHidden,
}: {
  kind: string;
  face: string;
  w: number;
  h: number;
  detail: "full" | "index";
  /** Flippable kinds — hides the front face while the back is showing. */
  ariaHidden?: boolean;
}) {
  if (kind === "tile") return <TileFace tile={face} w={w} h={h} ariaHidden={ariaHidden} />;
  if (kind === "chip") return <ChipFace colour={face} size={Math.min(w, h)} />;
  return <CardFace card={face} w={w} h={h} detail={detail} ariaHidden={ariaHidden} />;
}
