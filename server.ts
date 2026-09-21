/**
 * The process.
 *
 * Next.js and the WebSocket server share one HTTP listener, which is the
 * whole reason this file exists instead of `next dev`. Rooms are live
 * objects with timers and open sockets — the opposite of the request/
 * response model a serverless function is built for — so the app needs a
 * process that stays up, and the simplest honest version of that is one
 * port serving both the pages and the socket.
 *
 * The cost is real and worth stating: this rules out Vercel-style
 * serverless deploys. It runs anywhere Node runs — Railway, Fly, Render, a
 * VPS.
 *
 * Run it with `npm run dev` / `npm start`, both of which go through `tsx`
 * so there is no build step in front of the server itself.
 */

import { createServer } from "node:http";
import next from "next";
import { RoomRegistry } from "@/server/RoomRegistry";
import { KeepAwake, keepAwakeUrl } from "@/server/keepAwake";
import { attachWebSocketServer, WS_PATH } from "@/server/wsServer";
import { debugEnabled, handleDebugRequest } from "@/server/debug";
import { log, setLogLevel } from "@/server/log";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
/**
 * Only ever used to build the log line and to tell Next what it is being
 * served as. The LISTEN below deliberately passes no host, so Node binds
 * every interface — which is what a container needs, and what binding
 * `localhost` inside one would have quietly prevented.
 */
const hostname = process.env.HOSTNAME ?? "localhost";

async function main(): Promise<void> {
  if (process.env.LOG_LEVEL) {
    setLogLevel(process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error");
  }

  const app = next({ dev, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();

  const registry = new RoomRegistry();

  const server = createServer((req, res) => {
    // Liveness, and deliberately NOT one of the debug routes: those are
    // refused in production, which is the one environment a platform
    // actually health-checks. It answers before Next so a slow or broken
    // page render cannot make the process look dead, and it says nothing
    // about who is in which room — a health check is a public endpoint.
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          rooms: registry.size,
          uptime: process.uptime(),
          // Which commit is actually serving, so a deploy can be VERIFIED
          // rather than assumed: a platform keeps the old instance up
          // until the new one is healthy, so "the health check passed"
          // cannot tell a finished deploy from one still in flight. Render
          // sets the first; `GIT_COMMIT` is for a host that does not.
          // Null when neither is set, which is honest for local runs.
          commit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
        }),
      );
      return;
    }
    // Debug routes answer for themselves; everything else is Next's. They
    // are refused outright in production — see `debug.ts` on why there is
    // no middle setting.
    if (handleDebugRequest(req, res, registry)) return;
    void handle(req, res);
  });

  const detach = attachWebSocketServer(server, registry);

  // Keeps a free host from sleeping under a game in progress. See the file.
  const awakeUrl = keepAwakeUrl(process.env);
  const keepAwake = awakeUrl
    ? new KeepAwake({ url: awakeUrl, hasPeople: () => registry.hasConnections() })
    : null;
  keepAwake?.start();
  if (awakeUrl) log.info("keep-awake enabled", { event: "keep-awake", url: awakeUrl });

  const shutdown = (signal: string) => {
    log.info("shutting down", { event: signal });
    keepAwake?.stop();
    detach();
    registry.disposeAll();
    server.close(() => process.exit(0));
    // A socket that refuses to close must not hold the process open
    // forever; a deploy that hangs on shutdown is worse than an abrupt one.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(port, () => {
    log.info("ready", {
      event: "listen",
      url: `http://${hostname}:${port}`,
      ws: WS_PATH,
      debug: debugEnabled(),
    });
  });
}

main().catch((err: unknown) => {
  log.error("failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
