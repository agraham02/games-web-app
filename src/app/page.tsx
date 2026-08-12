import Link from "next/link";

const GAMES = [
  { name: "Spades", detail: "4 seats · bid, tricks, bags", status: "planned" },
  { name: "Rummy 500", detail: "2–8 seats · board melds", status: "planned" },
  { name: "Dominoes", detail: "2–4 seats · block & draw", status: "planned" },
  { name: "Poker", detail: "2–10 seats · no-limit hold'em", status: "planned" },
] as const;

export default function Home() {
  return (
    <main className="felt felt-weave min-h-svh">
      <div className="relative z-1 mx-auto max-w-2xl px-6 py-16">
        <span className="eyebrow">Foundation build</span>
        <h1 className="mt-2 font-display text-4xl tracking-wider text-brass-300">
          Table Games
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-bone-400">
          Left Right Center is the first game with real rules — everything
          else is still exercised through the lab harness: seat geometry, the
          piece layer, motion pacing, phase screens and Rummy&apos;s board
          disclosure.
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            href="/play/lrc"
            className="inline-block rounded-lg bg-linear-to-b from-brass-300 to-brass-500 px-6 py-3.5 text-sm font-extrabold text-felt-950 shadow-e2"
          >
            Play Left Right Center →
          </Link>
          <Link
            href="/lab/seats"
            className="inline-block rounded-lg bg-bone-50/6 px-6 py-3.5 text-sm font-semibold text-bone-200 ring-1 ring-bone-50/16"
          >
            Open the lab
          </Link>
        </div>

        <span className="rule-brass my-10 block" />

        <span className="eyebrow">Games to come</span>
        <ul className="mt-4 flex flex-col gap-2">
          {GAMES.map((g) => (
            <li
              key={g.name}
              className="flex items-center justify-between rounded-xl bg-bone-50/4 px-4 py-3 ring-1 ring-bone-50/8"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-bone-50">
                  {g.name}
                </span>
                <span className="text-[11px] text-bone-400">{g.detail}</span>
              </span>
              <span className="rounded-full bg-bone-50/6 px-2.5 py-1 text-[10px] font-bold tracking-wider text-bone-400 uppercase">
                {g.status}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
