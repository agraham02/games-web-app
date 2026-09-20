# Deploying

The short version: **Render's free tier, deployed by GitHub Actions.** Push
to `main`, CI runs, and only if every job passes does the site update — and
CI then checks the live site is actually serving the commit it just shipped.

Everything below was checked against the providers' own docs in
September 2026. Free tiers change constantly, so treat the numbers as a
starting point and re-check before you depend on one.

---

## Where it can run, and where it can't

This app is **one long-lived Node process**: pages and the WebSocket share a
port (`server.ts`), and every room is a live object in that process's
memory — a running game loop, timers, and open sockets. That decides
everything.

| Host | Free? | Works? | Notes |
|---|---|---|---|
| **[Render](https://render.com)** | Yes, no card needed to start | ✅ **Recommended** | Sleeps after 15 min idle; ~1 min to wake. Config is already in [`render.yaml`](render.yaml). |
| **[Koyeb](https://www.koyeb.com)** | Yes — one service, 512 MB / 0.1 vCPU | ✅ | Needs a card on file (a temporary hold, not a charge). Deploy the [`Dockerfile`](Dockerfile). |
| **Oracle Cloud Always Free** | Yes — a real VM | ✅ | Always on, but you run it yourself (Docker + a TLS proxy). Setup below. |
| Fly.io | No — no free tier any more | ✅ | A couple of dollars a month for a machine that never sleeps. [`fly.toml`](fly.toml) is ready. |
| Railway | Trial credit, then paid | ✅ | Works; not free. |
| **Vercel / Netlify / Cloudflare Pages** | Yes | ❌ **Not as it stands** | See below. |

### Why not Vercel

It is *not* that Vercel cannot do WebSockets — it now can. It is that
[connections are not guaranteed to reach the same function
instance](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections),
and this app keeps a room's state in one process's memory. Two players given
the same room code could land on different instances and never meet.

It also runs a custom server (`server.ts`) that Vercel does not execute.
Moving there would mean rebuilding rooms on an external store such as Redis,
which is a rewrite of the room layer and not a config change. For roughly ten
players it is not worth it.

The same fact caps the app at **one instance** on any host. Do not turn on
autoscaling.

---

## First deploy on Render

You do this once. Budget about ten minutes.

### 1. Create the service

1. Push the repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. Render reads
   [`render.yaml`](render.yaml) and creates a free web service called
   `table-games`. No Docker is involved.
3. Wait for the first build (a few minutes). It will succeed and go live.
   Note the URL, something like `https://table-games-xxxx.onrender.com`.

`render.yaml` sets `autoDeployTrigger: "off"`, so **Render will not deploy on
its own after this first build.** That is deliberate: CI decides when, so a
commit with failing tests never goes live. (Leaving Render's default,
deploy-on-every-push, would ship a red commit before the tests had even run.)

### 2. Give GitHub the two settings

Render → your service → **Settings → Deploy Hook**: copy the URL. It looks
like `https://api.render.com/deploy/srv-…?key=…` and **is a secret** — anyone
holding it can trigger deploys.

In GitHub: **Settings → Secrets and variables → Actions**

| Kind | Name | Value |
|---|---|---|
| **Secret** | `RENDER_DEPLOY_HOOK_URL` | the deploy hook URL |
| **Variable** | `APP_URL` | your public URL, e.g. `https://table-games-xxxx.onrender.com` (no trailing slash needed) |

That is all the wiring. Until both exist the workflow still runs every test
and simply skips the deploy with a notice; without `APP_URL` it deploys but
cannot verify.

### 3. Ship it

Merge to `main`. In **Actions** you will see the five test jobs run in
parallel, then **Deploy to Render**, then **Verify the live site**, which
polls `/healthz` until it reports the commit that was just pushed.

---

## What CI does

[`.github/workflows/ci.yml`](.github/workflows/ci.yml). Every job exists
because a layer of the test suite is blind to something the others catch —
see CLAUDE.md, "Testing it".

| Job | Question it answers | Roughly |
|---|---|---|
| **check** | Is it correct? Typecheck, lint, ~800 unit tests. | 2 min |
| **harness** | Does the server hold up against hostile WebSocket traffic? | 2 min |
| **e2e** | Do two real browsers see a coherent table? | 3 min |
| **build** | Does it *boot* under a production install? | 3 min |
| **docker** | Does the container image work (for Fly, Koyeb, a VPS)? | 3 min |
| **deploy** | *(main only)* Trigger Render, pinned to this exact commit. | seconds |
| **verify** | *(main only)* Is the live site serving that commit? | ~2–5 min |

Two of these are worth understanding, because they catch things nothing else
does:

- **build** installs *production* dependencies only (`npm prune --omit=dev`)
  and starts the server. The server is TypeScript that is never compiled, so
  `tsx` and `cross-env` are **runtime** dependencies. Moving either into
  `devDependencies` passes every test and the build, then crashes on the first
  real deploy. This job is the only thing that notices. It also asserts that
  `/debug/*` answers 404 in production.
- **verify** exists because "the health check passed" does not mean "the
  deploy finished". A platform keeps the old instance serving until the new
  one is healthy, so a stale build answers `/healthz` just as well as a new
  one. `/healthz` includes a `commit` field (from Render's `RENDER_GIT_COMMIT`)
  so the workflow can tell them apart.

Pull requests run the five test jobs and nothing else. Only `main` deploys.
You can also redeploy `main` by hand: **Actions → CI → Run workflow**.

### Optional: make a human press the button

The deploy job uses a GitHub Environment called `production`. In **Settings →
Environments → production** add *Required reviewers* and every deploy will
wait for approval after CI passes.

### If a deploy goes wrong

Render keeps serving the previous version if the new one fails its health
check, so a bad deploy usually means the site simply did not update; **verify**
goes red and tells you. To roll back a deploy that *did* go live: Render →
your service → **Events** (or **Deploys**) → pick a previous deploy →
**Rollback**. Then fix forward on `main`.

---

## The free-tier catch, and how a game is protected from it

Render's free service **spins down after 15 minutes without inbound traffic**
and takes about a minute to wake ([Render's free-tier
docs](https://render.com/docs/free)). Rooms live in the process's memory, so a
spin-down ends every game in progress, with no warning. A cold start is
harmless; **a game cut off at fifteen minutes is the thing to prevent.**

Render's docs say WebSocket messages from an open connection count as traffic,
and this client sends one every 25 seconds. That should be enough. But a
platform's idle accounting is not something to find out about by losing a
game, and a game cut off exactly this way is what happened on an earlier
project, so **the server does not rely on it.**

### What the server does

[`src/server/keepAwake.ts`](src/server/keepAwake.ts). While at least one person
is connected to any room, the server makes an ordinary HTTP request to its own
public `/healthz` every 4 minutes. That is inbound traffic however the platform
counts, and 4 minutes leaves room for three attempts inside the 15-minute
window.

The important half is the other direction: **when nobody is connected it does
nothing.** So it protects a game in play and stops the moment the last person
leaves, after which the service sleeps as normal. It does not turn a free
instance into an always-on one, does not spend the 750 monthly hours on an
empty room, and is a small request every few minutes only while people are
actually playing.

It needs no configuration on Render, which sets `RENDER_EXTERNAL_URL` on every
web service. It only runs in production, so a local server never phones a live
one.

| Variable | Effect |
|---|---|
| `RENDER_EXTERNAL_URL` | Set by Render. This is the address it calls. |
| `KEEP_AWAKE_URL` | Use this address instead, or on a host that does not set the above. |
| `KEEP_AWAKE=0` | Turn it off. |

The startup log says `keep-awake enabled` with the URL it is using, so you can
confirm from the Render logs that it is on.

### Prove it on the real deployment

Neither Render's docs nor a test in this repo can show that a real game
survives fifteen minutes on a real free instance; only running one can. The
first time you deploy:

1. Open the site on two devices, make a room and start a game. Then leave it
   alone, letting the bots play, for **at least 20 minutes**.
2. The game should still be running. In the Render logs you can also see the
   `GET /healthz` requests arrive about every four minutes.
3. Close every tab, wait 20 minutes, and open the site again. It should take
   about a minute to load (asleep). That is the free tier behaving, and it is
   the other half of the design working.

If step 1 fails, the server-side request is not counting on your plan; the
options below are the fallback.

### About Render's terms

A self-request while people are playing is the mildest form of keep-alive there
is, but it is still a way of staying awake, and Render's free-tier docs are
silent on it (checked September 2026; the terms-of-service text could not be
retrieved). They do label the free tier "not for production applications", and
the only abuse language concerns *outbound* traffic. Read Render's current
terms yourself if it matters to you. The worst realistic outcome is the free
service being suspended.

### If it is not enough

1. **An external monitor** (UptimeRobot, Better Stack, cron-job.org) requesting
   `https://<your-app>/healthz` every 10 minutes keeps it awake permanently,
   including when nobody is playing. Set it up in the monitor's dashboard;
   nothing in this repo is involved. Do **not** use a GitHub Actions cron for
   it: about 4,400 runs a month would exhaust a private repo's free minutes,
   and scheduled runs are delayed by minutes at busy times, which a 15-minute
   window cannot absorb.
2. **A host that does not sleep** — Oracle's Always Free VM (below), or
   Fly/Railway at a few dollars a month.

Render gives each workspace **750 free instance hours a month**. One service
running around the clock is about 744, so an always-awake service just fits and
a second free one would not.

### Redeploys still end games

Restarting the process drops every room, whatever keeps it awake. Deploy when
nobody is mid-hand. CI deploys on every green push to `main`; if that is a
problem, add *Required reviewers* to the `production` environment (see above)
so a deploy waits for you.

---

## Other hosts

Anything that runs a container works: build the [`Dockerfile`](Dockerfile),
expose the port in `$PORT`, and health-check `GET /healthz`. CI builds and
boots the image on every run, so it does not rot.

The `deploy` job in CI is written for Render's deploy hook. For another host,
replace that job's step with the host's own deploy command. Also set
`GIT_COMMIT` on the host (to the commit being deployed) if you want **verify**
to confirm a deploy is new; without it the workflow can only confirm the site
is up, and says so.

### Koyeb (free)

1. Sign up (a card is required for verification).
2. **Create Service → GitHub**, pick the repo, builder **Dockerfile**.
3. Instance type **Free**, port **3000**, health check path `/healthz`.
4. Leave scaling at a single instance.

The free instance is small (0.1 vCPU, 512 MB); this app idles well inside it.
Regions are limited to Frankfurt and Washington, D.C.

### Oracle Cloud Always Free (a real always-on VM)

The most capable free option and the most work. Roughly:

1. Create an Always Free Ubuntu VM and open ports 80 and 443 in both the
   security list and the OS firewall.
2. `sudo apt install docker.io`, clone the repo, `docker build -t table-games .`
3. `docker run -d --restart unless-stopped -p 127.0.0.1:3000:3000 --name tg table-games`
4. Put **Caddy** in front for automatic HTTPS. WebSockets need no extra
   configuration with Caddy:

   ```
   games.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

5. Redeploy with `git pull && docker build -t table-games . && docker rm -f tg && docker run …`.

Browsers require `wss://` on an HTTPS page, so TLS is not optional.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Platforms inject their own. |
| `NODE_ENV` | — | Must be `production`. `npm start` sets it. |
| `NODE_VERSION` | `22` | Render only; already in `render.yaml`. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |
| `GIT_COMMIT` | unset | Reported by `/healthz` on hosts that do not set `RENDER_GIT_COMMIT`. |
| `ENABLE_DEBUG_ENDPOINTS` | unset | **Never set this on a real deployment.** |

`/debug/room/:code` dumps a room's authoritative state, unredacted, and
`POST /debug/drop/:code/:session` hangs up on a player. Both exist for the
test harness and are refused outright in production. Setting
`ENABLE_DEBUG_ENDPOINTS=1` would expose both. The CI **build** job fails if
`/debug/rooms` ever answers anything but 404.

There are no other secrets, no database and no third-party services.

---

## Checking a deploy by hand

```
curl https://<your-app>/healthz
{"ok":true,"rooms":0,"uptime":812.4,"commit":"6c79b3c…"}
```

`rooms` is a count, never who is in them — `/healthz` is public.

Then the test that matters: open the site on **two devices** (or one browser
and a phone), make a room on one, join it from the other, and play a hand.
On a single machine, use two *origins* — `localhost` and `127.0.0.1` — not two
tabs: identity is a per-origin token, so two tabs on one origin are one
person. See CLAUDE.md, "A seat belongs to a person".

---

## Limits, and what to do when you outgrow them

- **One instance.** Rooms live in one process. A second instance is a second,
  invisible set of rooms. One Node process handles thousands of concurrent
  sockets, so this is far beyond ten players — but going past it needs sticky
  routing by room code, or rooms moved to an external store, before any
  scaling.
- **A deploy ends every game in progress.** Restarting the process drops every
  room. Deploy when nobody is mid-hand; on a free instance there is no way to
  drain gracefully. Clients reconnect on their own, find they are in no room, and
  land back on the create-or-join screen.
- **A cold start is ~1 minute** on Render's free tier.
- **The first build can be tight on memory.** The free instance has little RAM
  and `next build` is the hungry part. If a build is killed, retry it once;
  if it keeps happening, that is the moment to consider a paid instance or
  building the image in CI and deploying it instead.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Page loads, table says "Connecting…" forever | The socket is not getting through. Check the host proxies WebSockets, and that the page is on HTTPS (so it connects with `wss://`). |
| "Reload to keep playing" | The page was loaded before a deploy. Reload it — the seat is still theirs. |
| **verify** goes red but the site works | It is still serving the old commit. Look at the deploy log in Render; the new build probably failed its health check. |
| **deploy** says nothing was deployed | `RENDER_DEPLOY_HOOK_URL` is not set (or is set as a *variable* rather than a *secret*). |
| A deploy hook call returns 404 | The `ref` commit is not on the branch Render tracks, or the hook URL is stale. Copy it again from Render's settings. |
| Dev-only: `127.0.0.1` hangs on "Connecting…" | Next's dev server blocks unlisted origins; `allowedDevOrigins` in `next.config.ts` covers it. Never a production concern. |

---

*Sources checked:* [Render free
tier](https://render.com/docs/free) ·
[Render deploy hooks](https://render.com/docs/deploy-hooks) ·
[Render Blueprint spec](https://render.com/docs/blueprint-spec) ·
[Koyeb free tier](https://www.koyeb.com/docs/faqs/pricing) ·
[Vercel and WebSockets](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
