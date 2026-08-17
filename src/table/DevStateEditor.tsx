"use client";

/**
 * The dev panel's state editor: every pile of pieces in the live game
 * state, as a labelled bucket of real piece faces you can move between
 * and resize.
 *
 * Entirely game-agnostic — see debugState.ts for how, and for why it
 * stops at "move a piece" and "fill to N". It exists to remove a
 * specific, repeated friction (reaching a 20-card hand or a 30-card
 * discard pile takes real minutes of legal play), not to be a general
 * state inspector.
 */

import { useState } from "react";
import type { PieceId, PieceMeta } from "@/engine/types";
import { CardFace } from "@/ui/primitives/CardFace";
import { TileFace } from "@/ui/primitives/TileFace";
import { ChipFace } from "@/ui/primitives/ChipFace";
import { fillPile, findPiles, movePiece, type Pile } from "./debugState";

export interface DevStateEditorProps {
  state: unknown;
  /** The game's fixed piece vocabulary — what makes a pile a pile. */
  pieces: Record<PieceId, PieceMeta>;
  onChange: (next: unknown) => void;
}

export function DevStateEditor({ state, pieces, onChange }: DevStateEditorProps) {
  const vocabulary = new Set(Object.keys(pieces));
  const piles = findPiles(state, vocabulary);
  const [picked, setPicked] = useState<{ path: string; id: PieceId } | null>(null);

  if (piles.length === 0) {
    return <p className="text-[10px] text-bone-400">No piece piles found in this state.</p>;
  }

  return (
    <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
      {picked ? (
        <div className="flex items-center justify-between rounded bg-brass-400/15 px-2 py-1 text-[10px] text-brass-300">
          <span>
            Moving <b>{picked.id}</b> — pick a destination
          </span>
          <button type="button" onClick={() => setPicked(null)} className="underline">
            cancel
          </button>
        </div>
      ) : null}

      {piles.map((pile) => (
        <PileRow
          key={pile.path}
          pile={pile}
          pieces={pieces}
          picked={picked}
          onPick={(id) => setPicked({ path: pile.path, id })}
          onDrop={() => {
            if (!picked) return;
            onChange(movePiece(state, picked.path, pile.path, picked.id));
            setPicked(null);
          }}
          onFill={(n) => onChange(fillPile(state, pile.path, n, vocabulary))}
        />
      ))}
    </div>
  );
}

function PileRow({
  pile,
  pieces,
  picked,
  onPick,
  onDrop,
  onFill,
}: {
  pile: Pile;
  pieces: Record<PieceId, PieceMeta>;
  picked: { path: string; id: PieceId } | null;
  onPick: (id: PieceId) => void;
  onDrop: () => void;
  onFill: (n: number) => void;
}) {
  const isTarget = picked !== null && picked.path !== pile.path;

  return (
    <div
      className={`rounded border px-2 py-1.5 ${
        isTarget ? "border-brass-400/60 bg-brass-400/8" : "border-bone-50/10 bg-felt-950/40"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={!isTarget}
          onClick={onDrop}
          className="truncate text-left text-[10px] font-bold text-bone-200 disabled:cursor-default"
        >
          {pile.label} <span className="text-bone-400">({pile.ids.length})</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <StepButton label="−5" onClick={() => onFill(Math.max(0, pile.ids.length - 5))} />
          <StepButton label="−1" onClick={() => onFill(Math.max(0, pile.ids.length - 1))} />
          <StepButton label="+1" onClick={() => onFill(pile.ids.length + 1)} />
          <StepButton label="+5" onClick={() => onFill(pile.ids.length + 5)} />
          <StepButton label="20" onClick={() => onFill(20)} />
        </div>
      </div>

      <div className="flex flex-wrap gap-0.5">
        {pile.ids.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            title={id}
            className={`rounded-sm ${
              picked?.id === id && picked.path === pile.path ? "ring-1 ring-brass-400" : ""
            }`}
          >
            <MiniPiece id={id} meta={pieces[id]} />
          </button>
        ))}
        {pile.ids.length === 0 ? (
          <span className="text-[10px] text-bone-500">empty</span>
        ) : null}
      </div>
    </div>
  );
}

function StepButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded bg-bone-50/8 px-1.5 py-0.5 text-[9px] font-bold text-bone-200 hover:bg-brass-400/20 hover:text-brass-300"
    >
      {label}
    </button>
  );
}

/** Reuses the real table faces, so a chip is recognisably that card. */
function MiniPiece({ id, meta }: { id: PieceId; meta?: PieceMeta }) {
  if (!meta) return null;
  if (meta.kind === "tile") return <TileFace tile={meta.face} w={14} h={28} />;
  if (meta.kind === "chip") return <ChipFace colour={meta.face} size={16} />;
  return <CardFace card={id} w={18} h={25} detail="index" />;
}
