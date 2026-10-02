"use client";

/**
 * Who is in the room, where they will sit, and what the leader may do
 * about them.
 *
 * Its avatar is the shared `Avatar` — the same one the seat pods, the
 * round card and the game-end winner draw.
 *
 * The treatment of a disconnected member is deliberate and follows the
 * disclosure policy's "dim, don't hide": they stay in the list, greyed,
 * with their seat still shown. Dropping them out would make the roster jump
 * every time somebody's phone sleeps, and — worse — would suggest their
 * seat was up for grabs when it is being held for them.
 *
 * Between games the list IS the seating plan (`seatingPlan` on the server):
 * one row per seat, seat 1 first and clockwise from there, with a Bot row
 * for each seat nobody fills, and anybody past the last seat watching. The
 * leader drags rows by their grip (or moves them with the arrow keys) to
 * rearrange it, bots included. In a partnership game the seat decides the
 * team, so each seat shows its team's chip and there is nothing else to
 * set. Dragging is by the grip alone, never the whole row: on a phone a
 * finger swiping down the list has to scroll the page, not pick somebody up.
 */

import { Crown, Eye, GripVertical, UserMinus } from "lucide-react";
import { WeakLinkIcon } from "@/ui/primitives/WeakLinkIcon";
import { Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { MemberView } from "@/session/protocol";
import { Avatar } from "@/ui/primitives/Avatar";
import { Button } from "@/ui/primitives/Button";
import { photoUrl } from "@/session/photo";
import { RemovePhoto, YourAvatar } from "./YourAvatar";
import { TRANSITIONS } from "@/motion/presets";

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
  /**
   * The seating plan for the next game (`RoomView.seatPlan`), or null while
   * a game is running — then the list is the people, each with the seat
   * they actually hold.
   */
  plan: (string | null)[] | null;
  /** How many seats the game has; plan entries past it will watch. */
  seatCount: number;
  /** Whether the selected game plays in partnerships (seat decides team). */
  teamsEnabled: boolean;
  onPromote: (session: string) => void;
  onKick: (session: string) => void;
  /** Leader only, between games: the rearranged plan. Absent, no dragging. */
  onArrange?: (plan: (string | null)[]) => void;
  /** Sets or takes down your own photo. Absent, your avatar is just an avatar. */
  onPhoto?: (image: string | null) => void;
}

/** A row's identity for the drag list: a session, or `bot:n` for a bot seat. */
type RowKey = string;
const isBotKey = (key: RowKey) => key.startsWith("bot:");

/**
 * Keys for a plan, reusing the bot keys already on screen in the order
 * they appear. Bots are interchangeable, but their keys are what Motion
 * animates by: numbering them afresh from each plan the server echoes back
 * would swap two bots' keys and send them sliding past each other.
 */
function keysFor(plan: (string | null)[], previous: RowKey[]): RowKey[] {
  const pool = previous.filter(isBotKey);
  let next = previous.reduce((n, k) => (isBotKey(k) ? Math.max(n, Number(k.slice(4)) + 1) : n), 0);
  return plan.map((s) => (s !== null ? s : (pool.shift() ?? `bot:${next++}`)));
}

const planOf = (keys: RowKey[]) => keys.map((k) => (isBotKey(k) ? null : k));

export function Roster(props: RosterProps) {
  return props.plan ? <SeatingPlan {...props} plan={props.plan} /> : <MemberList {...props} />;
}

/** During a game: the people, with the seats they hold. */
function MemberList({ members, you, youAreLeader, onPromote, onKick, onPhoto }: RosterProps) {
  return (
    <ul aria-label="Room members" className="flex w-full flex-col gap-1.5">
      {members.map((m) => (
        <li key={m.session} className={ROW}>
          <MemberCells
            member={m}
            you={you}
            label={m.seat !== null ? `Seat ${m.seat + 1}` : null}
            status={
              !m.connected
                ? m.seat !== null
                  ? "Away — seat held"
                  : "Away"
                : m.seat !== null
                  ? "At the table"
                  : m.spectating
                    ? "Watching"
                    : "In the lobby"
            }
            team={m.team}
            onPhoto={onPhoto}
          />
          <LeaderActions member={m} you={you} youAreLeader={youAreLeader} onPromote={onPromote} onKick={onKick} />
        </li>
      ))}
    </ul>
  );
}

/** Between games: one row per seat, draggable by the leader. */
function SeatingPlan({
  members,
  you,
  youAreLeader,
  plan,
  seatCount,
  teamsEnabled,
  onPromote,
  onKick,
  onArrange,
  onPhoto,
}: RosterProps & { plan: (string | null)[] }) {
  const [keys, setKeys] = useState<RowKey[]>(() => keysFor(plan, []));
  const dragging = useRef(false);
  // The order at the moment of the drop, whichever render's handler fires.
  const latest = useRef(keys);
  useEffect(() => {
    latest.current = keys;
  }, [keys]);
  const planKey = plan.map((s) => s ?? "·").join(",");

  // Follow the server's plan, except mid-drag, when the local order is the
  // one on screen and the server has not heard about it yet.
  useEffect(() => {
    if (dragging.current) return;
    setKeys((prev) => keysFor(plan, prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const byId = new Map(members.map((m) => [m.session, m]));
  const canArrange = youAreLeader && Boolean(onArrange);
  const commit = (next: RowKey[]) => onArrange?.(planOf(next));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= keys.length || from === to) return;
    const next = [...keys];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row!);
    setKeys(next);
    commit(next);
  };

  return (
    <Reorder.Group
      as="ul"
      axis="y"
      values={keys}
      onReorder={(next: RowKey[]) => {
        latest.current = next;
        setKeys(next);
      }}
      aria-label="Seating plan"
      className="flex w-full flex-col gap-1.5"
    >
      {keys.map((key, i) => {
        const member = isBotKey(key) ? null : byId.get(key);
        const seated = i < seatCount;
        const label = seated ? `Seat ${i + 1}` : "No seat";
        const team = teamsEnabled && seated ? i % 2 : null;
        return (
          <SeatRow
            key={key}
            value={key}
            canArrange={canArrange}
            name={member?.name ?? "Bot"}
            onDragStart={() => {
              dragging.current = true;
            }}
            onDragEnd={() => {
              dragging.current = false;
              commit(latest.current);
            }}
            onMoveBy={(delta) => move(i, i + delta)}
          >
            {member ? (
              <>
                <MemberCells
                  member={member}
                  you={you}
                  label={label}
                  status={!member.connected ? "Away" : seated ? "In the lobby" : "Will watch — table full"}
                  team={team}
                  onPhoto={onPhoto}
                />
                <LeaderActions
                  member={member}
                  you={you}
                  youAreLeader={youAreLeader}
                  onPromote={onPromote}
                  onKick={onKick}
                />
              </>
            ) : (
              <BotCells label={label} team={team} />
            )}
          </SeatRow>
        );
      })}
    </Reorder.Group>
  );
}

const ROW =
  "flex items-center gap-3 rounded-lg bg-bone-50/4 px-3 py-2.5 ring-1 ring-bone-50/8";

function SeatRow({
  value,
  canArrange,
  name,
  onDragStart,
  onDragEnd,
  onMoveBy,
  children,
}: {
  value: RowKey;
  canArrange: boolean;
  name: string;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMoveBy: (delta: number) => void;
  children: React.ReactNode;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      as="li"
      value={value}
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`${ROW} relative`}
      // Somebody arriving fades in rather than popping into the list.
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={TRANSITIONS.uiEnter}
      whileDrag={{ scale: 1.02, zIndex: 1, boxShadow: "0 8px 24px rgb(0 0 0 / 0.35)" }}
    >
      {canArrange ? (
        <button
          type="button"
          aria-label={`Move ${name}. Drag, or use the arrow keys.`}
          onPointerDown={(e) => controls.start(e)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onMoveBy(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onMoveBy(1);
            }
          }}
          // `touch-action: none` on the grip alone: dragging it must not
          // scroll the page, while the rest of the row still does.
          style={{ touchAction: "none" }}
          className="-ml-1 flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded text-bone-400 hover:bg-bone-50/10 hover:text-bone-50 active:cursor-grabbing"
        >
          <GripVertical size={16} />
        </button>
      ) : null}
      {children}
    </Reorder.Item>
  );
}

function SeatLabel({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <span className="w-12 shrink-0 text-[11px] font-bold tracking-wide text-bone-500 uppercase">
      {label}
    </span>
  );
}

/** The side a seat plays for — partners sit across, so the seat decides. */
function TeamChip({ team }: { team: number | null }) {
  if (team === null) return null;
  const b = team === 1;
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase"
      style={{
        color: b ? "var(--color-team-b)" : "var(--color-team-a)",
        background: `color-mix(in srgb, ${b ? "var(--color-team-b)" : "var(--color-team-a)"} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${b ? "var(--color-team-b)" : "var(--color-team-a)"} 45%, transparent)`,
      }}
    >
      Team {b ? "B" : "A"}
    </span>
  );
}

function MemberCells({
  member: m,
  you,
  label,
  status,
  team,
  onPhoto,
}: {
  member: MemberView;
  you: string;
  label: string | null;
  status: string;
  team: number | null;
  onPhoto?: (image: string | null) => void;
}) {
  // Your own row sets your photo; nobody else's can.
  const setPhoto = m.session === you ? onPhoto : undefined;
  return (
    <>
      <SeatLabel label={label} />
      {setPhoto ? (
        <YourAvatar member={m} colour={tintFor(m.session)} onPhoto={setPhoto} />
      ) : (
        <Avatar
          name={m.name}
          colour={tintFor(m.session)}
          dim={!m.connected}
          src={m.photo ? photoUrl(m.photo) : null}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 truncate text-sm font-semibold text-bone-100">
          {m.name}
          {m.session === you ? <span className="text-xs font-normal text-bone-400">(you)</span> : null}
          {m.isLeader ? (
            <Crown size={13} className="shrink-0 text-brass-300" aria-label="Party leader" />
          ) : null}
          <WeakLinkIcon show={m.weak && m.connected} label={`${m.name}'s connection is slow`} size={13} className="shrink-0" />
        </span>
        <span className="truncate text-xs text-bone-400">
          {status}
          {setPhoto && m.photo ? (
            <>
              {" · "}
              <RemovePhoto onPhoto={setPhoto} />
            </>
          ) : null}
        </span>
      </div>
      {m.spectating ? (
        <Eye size={14} className="shrink-0 text-bone-600" aria-label="Spectating" />
      ) : null}
      <TeamChip team={team} />
    </>
  );
}

function BotCells({ label, team }: { label: string; team: number | null }) {
  return (
    <>
      <SeatLabel label={label} />
      <Avatar name="Bot" colour="" bot />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold text-bone-300">Bot</span>
        <span className="truncate text-xs text-bone-500">Plays this seat</span>
      </div>
      <TeamChip team={team} />
    </>
  );
}

function LeaderActions({
  member: m,
  you,
  youAreLeader,
  onPromote,
  onKick,
}: {
  member: MemberView;
  you: string;
  youAreLeader: boolean;
  onPromote: (session: string) => void;
  onKick: (session: string) => void;
}) {
  if (!youAreLeader || m.session === you) return null;
  return (
    <div className="flex shrink-0 gap-1">
      <Button size="sm" onClick={() => onPromote(m.session)} title="Make leader">
        <Crown size={12} />
      </Button>
      <Button size="sm" tone="danger" onClick={() => onKick(m.session)} title={`Remove ${m.name}`}>
        <UserMinus size={12} />
      </Button>
    </div>
  );
}
