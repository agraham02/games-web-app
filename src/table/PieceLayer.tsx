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
import { TileFace } from "@/ui/primitives/TileFace";
import { ChipFace } from "@/ui/primitives/ChipFace";
import { baseSize, layoutPiece } from "./layout";
import { useGeometry, usePieceIds, usePlacement, usePieceMeta } from "./store";
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

  if (!placement || !geometry || !meta) return null;

  const t = layoutPiece(placement, geometry);
  const base = baseSize(geometry);
  const onScreenW = base.w * t.scale;
  const detail = onScreenW < DETAIL_THRESHOLD_PX ? "index" : "full";

  const interactive =
    Boolean(onTap) &&
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
      transition={TRANSITIONS.deal}
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
      <Flipper faceUp={placement.faceUp} w={base.w} h={base.h}>
        <PieceFace
          kind={meta.kind}
          face={meta.face}
          w={base.w}
          h={base.h}
          detail={detail}
          ariaHidden={!placement.faceUp}
        />
      </Flipper>

      {placement.highlighted ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: -2,
            borderRadius: base.w * 0.11,
            border: "2px solid var(--color-brass-400)",
            boxShadow: "var(--shadow-glow)",
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
  children,
}: {
  faceUp: boolean;
  w: number;
  h: number;
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
        <CardBack w={w} h={h} ariaHidden={faceUp} />
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
  /** Cards only — hides the front face while it's the back that's showing. */
  ariaHidden?: boolean;
}) {
  if (kind === "tile") return <TileFace tile={face} w={w} h={h} />;
  if (kind === "chip") return <ChipFace colour={face} size={Math.min(w, h)} />;
  return <CardFace card={face} w={w} h={h} detail={detail} ariaHidden={ariaHidden} />;
}
