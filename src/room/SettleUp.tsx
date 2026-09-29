"use client";

/**
 * Who pays whom, for a game played for money (the user, 2026-09-28).
 *
 * The same list on the winner's sheet and, once the table is gone, at the
 * top of the lobby — the only place a game ended early by the leader can
 * still be settled from. The server works it out (`settle.ts`); this only
 * says it, from the reader's side: "You pay Ada", never "Bo pays Ada" when
 * Bo is the one reading.
 *
 * The reader's own total comes first, because it is the question everybody
 * has; the payments follow, fewest possible, so each person knows exactly
 * who to send what.
 */

import type { SettlementView } from "@/session/protocol";
import type { SessionId } from "@/session/room";
import { formatMoney } from "@/session/settle";

export function SettleUp({
  settlement,
  you,
  className,
}: {
  settlement: SettlementView;
  you: SessionId;
  className?: string;
}) {
  const mine = settlement.results.find((r) => r.session === you);
  const name = (session: SessionId, fallback: string) => (session === you ? "you" : fallback);
  const early = !settlement.finished
    ? settlement.gameId === "poker"
      ? "The game was ended early: everyone keeps what they had, and a hand still being played was called off."
      : "The game was ended early: only the rounds played to the end count."
    : null;

  return (
    <section aria-label="Settle up" className={`flex w-full flex-col gap-3 ${className ?? ""}`}>
      <header className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">Settle up</span>
        <span className="text-[11px] font-semibold text-bone-400">{settlement.stake}</span>
      </header>

      {/* What changes hands, not the game's result: with bots at the table
          the two differ, and "You're even" said of a player who had lost
          to a bot read as though they had broken even. */}
      {mine && settlement.payments.length > 0 ? (
        <p className="text-sm font-bold text-bone-50">
          {mine.cents > 0
            ? `You're owed ${formatMoney(mine.cents)}`
            : mine.cents < 0
              ? `You owe ${formatMoney(-mine.cents)}`
              : "You don't owe anything, and nobody owes you"}
        </p>
      ) : null}

      {settlement.payments.length === 0 ? (
        <p className="text-[13px] text-bone-300">
          {settlement.botsLeftOut
            ? "Nobody owes anybody — the money that changed hands went to or came from bots."
            : "Everyone is even — nobody owes anything."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {settlement.payments.map((p) => {
            const yours = p.from === you || p.to === you;
            const who = name(p.from, p.fromName);
            return (
              <li
                key={`${p.from}>${p.to}`}
                className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ring-1 ${
                  yours ? "bg-brass-400/12 ring-brass-400/40" : "bg-bone-50/5 ring-bone-50/10"
                }`}
              >
                <span className={`text-[13px] ${yours ? "font-bold text-bone-50" : "font-semibold text-bone-200"}`}>
                  {/* Capitalised here rather than in `name`, which is also
                      the object of the sentence ("Bo pays you"). */}
                  {who === "you" ? "You pay" : `${who} pays`} {name(p.to, p.toName)}
                </span>
                <span className={`tnum text-[15px] font-extrabold ${yours ? "text-brass-300" : "text-bone-100"}`}>
                  {formatMoney(p.cents)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {(settlement.botsLeftOut && settlement.payments.length > 0) || early ? (
        <div className="flex flex-col gap-1 text-[11px] leading-snug text-bone-400">
          {early ? <p>{early}</p> : null}
          {settlement.botsLeftOut && settlement.payments.length > 0 ? (
            <p>Money won from or lost to bots is left out, so this is only what people owe each other.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
