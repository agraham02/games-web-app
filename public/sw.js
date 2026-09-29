/*
 * The service worker, and all it does.
 *
 * It exists because Chromium only offers a site for installing (the
 * `beforeinstallprompt` event behind the home page's Install button) when a
 * service worker handles fetches, and ignores one whose handler is empty.
 *
 * So it handles one thing: opening a page. That goes to the network exactly
 * as it would without a worker, and only when the network fails does it
 * answer, with a page saying so, instead of the browser's own error. It
 * caches nothing. A game is live on the server, so a cached page would only
 * be a stale one, and every other request (scripts, the socket) never
 * reaches this file at all.
 */

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#071310">
<title>Table Games</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box;
    background: radial-gradient(ellipse at 50% 35%, #1b4634, #071310 70%);
    color: #f5f2ea; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center;
  }
  h1 { margin: 0 0 8px; font: 600 24px/1.2 Georgia, serif; letter-spacing: 0.04em; color: #e3c68f; }
  p { margin: 0 0 24px; color: #c2baa7; max-width: 22rem; }
  button {
    border: 0; border-radius: 8px; padding: 12px 24px; font: 800 14px system-ui, sans-serif; color: #071310;
    background: linear-gradient(#e3c68f, #b8914e); cursor: pointer;
  }
</style>
</head>
<body>
  <main>
    <h1>You're offline</h1>
    <p>Table Games needs a connection to deal. Check yours, then try again.</p>
    <button type="button" onclick="location.reload()">Try again</button>
  </main>
</body>
</html>`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    ),
  );
});
