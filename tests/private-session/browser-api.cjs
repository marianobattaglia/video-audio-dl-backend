"use strict";
const fs = require("node:fs/promises");
const http = require("node:http");
if (process.env.YOUTUBE_COOKIES_FILE === "disabled") process.env.YOUTUBE_COOKIES_FILE = "";
// Optional test-only delayed health response exercises the real client's wake UI.
const delay = Number(process.env.PRIVATE_SESSION_BROWSER_HEALTH_DELAY || 0);
if (delay > 0) {
  let pendingWake = true;
  const createServer = http.createServer;
  http.createServer = listener => createServer((req, res) => {
    if (pendingWake && req.url === "/healthz" && req.headers.origin === "http://localhost:43000") { pendingWake = false; setTimeout(() => listener(req, res), delay); }
    else listener(req, res);
  });
}
(async () => {
  await fs.mkdir("/tmp/yt-dlp", { recursive: true });
  const media = await fetch("http://fixture.test/media.mp4");
  await fs.writeFile("/tmp/yt-dlp/qualification-media.mp4", Buffer.from(await media.arrayBuffer()));
  require("./bootstrap.cjs");
  require("/app/server.js");
})().catch(() => { console.error("Synthetic browser API could not start"); process.exitCode = 1; });
