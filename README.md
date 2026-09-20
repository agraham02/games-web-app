# Table Games

Six table games — **Dominoes** (Block & Draw, and the Caribbean game),
**Spades**, **Rummy 500**, **Poker** (NL Hold'em), **Left Right Center**
and **BS** (Cheat) — playable alone against bots or in a room with other
people. All six run online.

## Running it

```bash
npm install
npm run dev          # → http://localhost:3000
```

`npm run dev` boots [`server.ts`](server.ts), **not** `next dev`: Next and
the WebSocket server share one HTTP listener, because a room is a live
object with timers and open sockets rather than a request and a response.

To try multiplayer locally, open `/room` in **two different browser
profiles** — not two tabs. Identity lives in `localStorage`, so two tabs
of one profile are one person, which is exactly what the seat-reservation
logic is built to notice.

| | |
|---|---|
| `npm run dev` | server + app on one port |
| `npm run build && npm start` | the production build, locally |
| `npm run check` | typecheck + lint + unit tests |
| `npm run harness` | adversarial WebSocket scenarios (needs `npm run dev`) |
| `npm run e2e` | several real browsers, one real server |

## Deploying it

**Not Vercel, and not serverless.** Rooms live in this process's memory —
each one owns a running game loop with bot turns scheduled on a clock, an
expiry timer, and the sockets themselves. Serverless functions are
ephemeral and horizontally scaled, so a room created by one invocation is
invisible to the next. It runs anywhere Node runs.

The same fact caps it at **one instance**: a second would be a second,
invisible set of rooms, and two players given the same code could land on
different machines and never meet. That is fine well past any plausible
load for this app — one Node process handles thousands of concurrent
sockets — but scaling out would need sticky routing by room code before
anything else.

### Render — free, with one caveat

[`render.yaml`](render.yaml) is ready to go: point Render at the repo and
it builds and starts with no Docker involved.

The caveat is that a free service **spins down after ~15 minutes with no
traffic** and takes ~50s to wake. Milder here than it sounds, because
rooms are ephemeral anyway (a room with nobody connected is reaped after
a minute), but a room does die with the process — so two people arranging
to play should both have the page open before anyone creates one. An open
table will not idle out mid-game: the client sends a keepalive every 25
seconds.

### Fly, Koyeb, or a VPS

[`fly.toml`](fly.toml) and the [`Dockerfile`](Dockerfile) cover Fly and
anything else that takes a container. Fly is no longer free but is a
couple of dollars a month for a machine that never sleeps, which is the
one thing Render's free tier gives up. `auto_stop_machines` is off
deliberately — a stopped machine takes every live room with it.

Oracle Cloud's Always Free tier is a genuine always-on VM if you would
rather run it yourself and do not mind the setup.

*(Free tiers change constantly — check current terms before committing.)*

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Platforms inject their own. |
| `NODE_ENV` | — | Must be `production` in a deploy; `npm start` sets it. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |
| `ENABLE_DEBUG_ENDPOINTS` | unset | **Leave unset.** See below. |

`GET /healthz` is the liveness endpoint — always available, and says
nothing about who is in which room.

`/debug/*` is refused outright in production. `GET /debug/room/:code`
dumps a room's authoritative state and `POST /debug/drop/:code/:session`
hangs up on a player; both exist for the test harness. Setting
`ENABLE_DEBUG_ENDPOINTS=1` on a real deployment would expose both.

## How it is built

[CLAUDE.md](CLAUDE.md) is the architecture document — the engine's event
model, the single flat piece layer, per-viewer redaction, and why each
decision is the way it is. Worth reading before changing anything under
`src/engine`, `src/session` or `src/table`.
