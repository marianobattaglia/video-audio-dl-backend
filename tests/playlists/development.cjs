"use strict";
// Checks the actual independent frontend development server, not a fixture server.
const assert = require("node:assert/strict");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
(async () => {
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const frontend = path.resolve(__dirname, "../../../video-audio-dl-frontend");
  const child = spawn(process.execPath, ["scripts/dev.mjs"], { cwd: frontend,
    env: { ...process.env, FRONTEND_PORT: String(port), API_BASE_URL: "http://localhost:3000" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Frontend exited before serving"); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Frontend startup timed out")), 10000); timer.unref(); })]);
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(origin); assert.equal(response.status, 200); const html = await response.text();
    const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(match => match[1]);
    assert(scripts.includes("/playlist-links.js") && scripts.includes("/playlist-controller.js"));
    assert(scripts.indexOf("/playlist-links.js") < scripts.indexOf("/playlist-controller.js"));
    assert(scripts.indexOf("/playlist-controller.js") < scripts.indexOf("/app.js"));
    for (const file of scripts) {
      const result = await fetch(origin + file); assert.equal(result.status, 200, `${file} was not served`);
      assert.match(result.headers.get("content-type"), /^text\/javascript/); assert((await result.text()).length > 0);
    }
    assert.equal((await fetch(origin + "/not-a-public-file.js")).status, 404);
    console.log(JSON.stringify({ status: "pass", scriptsServed: scripts, scope: "Actual local frontend development server; no backend or external downloads" }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
