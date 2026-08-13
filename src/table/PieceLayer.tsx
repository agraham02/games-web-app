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

import { memo } from "react";
import { motion } from "motion/react";
import { HERO, type PieceId } from "@/engine/types";
import { CardBack, CardFace } from "@/ui/primitives/CardFace";
import { TileBack, TileFace } from "@/ui/primitives/TileFace";
import { ChipFace } from "@/ui/primitives/ChipFace";
import { baseSize, layoutPiece } from "./layout";
import { useBoardView, useGeometry, usePieceIds, usePlacement, usePieceMeta } from "./store";
import { TRANSITIONS } from "@/motion/presets";

/** Below this on-screen width, pips become mud — draw the simple face. */
const DETAIL_THRESHOLD_PX = 52;

export interface PieceLayerProps {
  onPieceTap?: (id: PieceId) => void;
}

export function PieceLayer({ onPieceTap }: PieceLayerProps) {
  const ids = usePieceIds();
  const geometry = useGeometry();
  if (!geometry) return null;

  return (
    <div className="piece-layer">
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

  if (!placement || !geometry || !meta) return null;

  const t = layoutPiece(placement, geometry, { kind: meta.kind, board });
  const base = baseSize(geometry);
  const onScreenW = base.w * t.scale;
  const detail = onScreenW < DETAIL_THRESHOLD_PX ? "index" : "full";

  const interactive =
    Boolean(onTap) &&
    // A dimmed piece reads as "not currently usable" — a hand tile with
    // no legal play, a discard-pile card out of reach. The pointer must
    // agree with that at the input level, not just visually: leaving it
    // clickable-but-ignored is what a dead button feels like, and this
    // is the one flag the piece layer can check without knowing why a
    // game dimmed it.
    !placement.dimmed &&
    ((placement.zone === "hand" && (placement.seat ?? HERO) === HERO) ||
      Boolean(placement.highlighted));

  return (
    <motion.div
      initial={false}
      animate={{
        x: t.x,
        y: t.y,
        rotate: t.rotate,
        scale: t.scale,
        opacity: t.opacity,
      }}
      // A batch of pieces (a collected trick, a sweep) can all receive
      // their new `animate` target in the same React commit yet still
      // arrive staggered — Motion holds each one's interpolation start
      // individually via `delay`, which is exactly what
      // `applyEvent.ts`'s per-piece `motionDelayMs` assumes exists.
      // Zero for every ordinary move (deal/draw/play/flip never set it).
      transition={{ ...TRANSITIONS.deal, delay: (placement.motionDelayMs ?? 0) / 1000 }}
      onClick={interactive ? () => onTap?.(id) : undefined}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: base.w,
        height: base.h,
        zIndex: t.z,
        transformOrigin: "center center",
        pointerEvents: interactive ? "auto" : "none",
        cursor: interactive ? "pointer" : undefined,
        // Hint the compositor without permanently promoting every piece.
        willChange: "transform",
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

      {placement.highlighted ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            // Drawn INSIDE the piece's own footprint, not extending
            // past it (the earlier `-2` did). A hand can pack pieces
            // closer together than an outward border's reach — a
            // domino hand does, by design — and an outward border on
            // two adjacent highlighted pieces merges into one shape
            // instead of reading as two. Inset never has that failure
            // mode, at any spacing.
            inset: 2,
            borderRadius: base.w * 0.11,
            border: "2px solid var(--color-brass-400)",
            boxShadow: "var(--shadow-glow-inset)",
            pointerEvents: "none",
          }}
        />
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
