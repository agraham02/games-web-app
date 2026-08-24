"use client";

/**
 * Who is in the room, and what the leader may do about them.
 *
 * The initials-on-a-tinted-circle avatar was already inlined in three
 * places (`SeatRing`, the round scorecard, the game-end standings) before
 * this file; it is lifted here rather than copied a fourth time.
 *
 * The treatment of a disconnected member is deliberate and follows the
 * disclosure policy's "dim, don't hide": they stay in the list, greyed,
 * with their seat still shown. Dropping them out would make the roster jump
 * every time somebody's phone sleeps, and — worse — would suggest their
 * seat was up for grabs when it is being held for them.
 */

import { UserMinus, Crown, Eye } from "lucide-react";
import type { MemberView } from "@/session/protocol";
import { Button } from "@/ui/primitives/Button";

export function Avatar({
  name,
  colour,
  dim = false,
  size = 32,
}: {
  name: string;
  colour: string;
  dim?: boolean;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-display font-bold text-felt-950"
      style={{
        width: size,
        height: size,
        background: colour,
        fontSize: size * 0.4,
        opacity: dim ? 0.45 : 1,
        filter: dim ? "grayscale(1)" : undefined,
      }}
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Stable per-name so the same person keeps the same colour across renders. */
const TINTS = [
  "#c9a0a0",
  "#a0a8c9",
  "#c9bfa0",
  "#8fb8a0",
  "#b9a0c9",
  "#a0c9c4",
  "#c9b0a0",
  "#aab8a0",
  "#c0a8b8",
] as const;

export function tintFor(session: string): string {
  let hash = 0;
  for (let i = 0; i < session.length; i++) hash = (hash * 31 + session.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length]!;
}

export interface RosterProps {
  members: MemberView[];
  you: string;
  youAreLeader: boolean;
  /** Null when the game does not use partnerships. */
  teamsEnabled: boolean;
  onPromote: (session: string) => void;
  onKick: (session: string) => void;
  onAssignTeam: (session: string, team: number) => void;
}

export function Roster({
  members,
  you,
  youAreLeader,
  teamsEnabled,
  onPromote,
  onKick,
  onAssignTeam,
}: RosterProps) {
  return (
    <ul className="flex w-full flex-col gap-1.5">
      {members.map((m) => {
        const isYou = m.session === you;
        return (
          <li
            key={m.session}
            className="flex items-center gap-3 rounded-lg bg-bone-50/4 px-3 py-2.5 ring-1 ring-bone-50/8"
          >
            <Avatar name={m.name} colour={tintFor(m.session)} dim={!m.connected} />

            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5 truncate text-sm font-semibold text-bone-100">
                {m.name}
                {isYou ? <span className="text-xs font-normal text-bone-400">(you)</span> : null}
                {m.isLeader ? (
                  <Crown size={13} className="shrink-0 text-brass-300" aria-label="Party leader" />
                ) : null}
              </span>
              <span className="truncate text-xs text-bone-400">
                {!m.connected
                  ? "Away — seat held"
                  : m.seat !== null
                    ? `Seat ${m.seat + 1}`
                    : m.spectating
                      ? "Watching"
                      : "In the lobby"}
              </span>
            </div>

            {m.spectating ? (
              <Eye size={14} className="shrink-0 text-bone-600" aria-label="Spectating" />
            ) : null}

            {teamsEnabled ? (
              <div className="flex shrink-0 gap-1" role="group" aria-label={`${m.name}'s team`}>
                {[0, 1].map((team) => (
                  <button
                    key={team}
                    type="button"
                    disabled={!youAreLeader}
                    onClick={() => onAssignTeam(m.session, team)}
                    aria-pressed={m.team === team}
                    className={`h-6 w-6 rounded text-[11px] font-bold transition-colors disabled:cursor-not-allowed ${
                      m.team === team
                        ? "bg-brass-400 text-felt-950"
                        : "bg-bone-50/8 text-bone-400 hover:bg-bone-50/14 disabled:hover:bg-bone-50/8"
                    }`}
                  >
                    {team === 0 ? "A" : "B"}
                  </button>
                ))}
              </div>
            ) : null}

            {youAreLeader && !isYou ? (
              <div className="flex shrink-0 gap-1">
                <Button size="sm" onClick={() => onPromote(m.session)} title="Make leader">
                  <Crown size={12} />
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  onClick={() => onKick(m.session)}
                  title={`Remove ${m.name}`}
                >
                  <UserMinus size={12} />
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
