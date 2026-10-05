"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const results = [];
let suiteComplete = false;
process.on("beforeExit", () => { if (!suiteComplete) { console.error('{"fatal":"Incomplete qualification suite"}'); process.exitCode = 1; } });
let api, logs = "";
const credential = `fixture-access-${randomUUID()}`;
const source = "/fixtures/youtube-cookies.txt";
const jars = "/tmp/yt-dlp/video-audio-dl-cookie-jars";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function test(name, action) {
  const started = Date.now();
  try { await action(); results.push({ name, status: "pass", ms: Date.now() - started }); }
  catch (error) { results.push({ name, status: "fail", error: error.message.slice(0, 1500), ms: Date.now() - started }); }
  console.log(JSON.stringify(results.at(-1)));
}
async function waitFor(action, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await action(); if (value) return value; await pause(100); }
  throw new Error("Timed out waiting for fixture condition");
}
async function request(path, { method = "GET", body, headers = {}, authenticated = true } = {}) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${credential}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  return { status: response.status, data: response.headers.get("content-type")?.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
}
async function stop(signal = "SIGTERM") {
  if (!api || api.exitCode !== null || api.signalCode !== null) return;
  const closed = once(api, "close"); api.kill(signal); await closed;
}
async function start(env = {}, expectedFailure = false) {
  await stop(); logs = "";
  api = spawn("node", ["--require", "/private-tests/bootstrap.cjs", "/app/server.js"], { env: { ...process.env, YTDLP_PATH: "/private-tests/fake-downloader.py", AUTH_REQUIRED: "true", ACCESS_CREDENTIAL: credential, YOUTUBE_COOKIES_FILE: source, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [api.stdout, api.stderr]) stream.on("data", part => { logs = (logs + part).slice(-40000); });
  if (expectedFailure) { const [code] = await once(api, "close"); assert.equal(code, 1); assert(!logs.includes("listening")); return; }
  await waitFor(async () => { if (api.exitCode !== null) throw new Error("API unexpectedly exited: " + logs); try { return (await request("/healthz")).status === 200; } catch { return false; } });
}
async function create(mode = "complete", kind = "video", url = `https://www.youtube.com/watch?v=${mode}`) {
  const reply = await request("/api/jobs", { method: "POST", body: { kind, url } }); assert.equal(reply.status, 202, JSON.stringify(reply.data)); return reply.data.id;
}
async function terminal(id) { return waitFor(async () => { const reply = await request(`/api/jobs/${id}`); assert.equal(reply.status, 200); return ["failed", "cancelled", "complete"].includes(reply.data.status) && reply.data; }); }
async function clean(id) { await waitFor(async () => !(await fs.stat(`/tmp/downloads/${id}`).catch(() => null))); assert(!(await fs.stat(`${jars}/${id}`).catch(() => null))); }
(async () => {
  await fs.mkdir("/tmp/yt-dlp", { recursive: true });
  await fs.writeFile("/tmp/yt-dlp/qualification-media.mp4", Buffer.from(await (await fetch("http://fixture.test/media.mp4")).arrayBuffer()));
  await require("./unit.cjs")(test);
  await require("./frontend-memory.cjs")(test);
  await test("Policy is inherited, HTTPS/domain/path/expiry checked and redirect cookies recalculated", () => {
    const checked = spawnSync("/usr/local/bin/download-sandbox", ["/usr/bin/python3", "/private-tests/policy.py"], { encoding: "utf8", timeout: 30000 }); assert.equal(checked.status, 0, checked.stderr);
  });
  try {
    for (const [name, env, rejected] of [
      ["No session, access open", { YOUTUBE_COOKIES_FILE: "", AUTH_REQUIRED: "false", ACCESS_CREDENTIAL: "" }, false],
      ["No session, access protected", { YOUTUBE_COOKIES_FILE: "" }, false],
      ["Session with valid protected access", {}, false],
      ["Session with open access refuses startup", { AUTH_REQUIRED: "false" }, true],
      ["Session with missing credential refuses startup", { ACCESS_CREDENTIAL: "" }, true],
      ["Unavailable session refuses startup", { YOUTUBE_COOKIES_FILE: "/fixtures/unavailable-cookie-file.txt" }, true]
    ]) await test(name, () => start(env, rejected));
    await start();
    const sourceContents = await fs.readFile(source, "utf8");
    const sentinel = sourceContents.trim().split("\t").at(-1);
    const privateStrings = [sentinel, credential, source, jars];
    function confidential(value) { const text = typeof value === "string" ? value : JSON.stringify(value); for (const secret of privateStrings) assert(!text.includes(secret), "private value escaped protection"); }
    await test("Public health reveals readiness/auth only", async () => {
      const reply = await request("/healthz", { authenticated: false }); assert.deepEqual(Object.keys(reply.data).sort(), ["activeDownloads", "authRequired", "status"]); assert(reply.data.authRequired); confidential(reply.data);
    });
    await test("Direct caller authorization, absent/forged allowed Origin and unknown Origin", async () => {
      for (const headers of [{}, { Origin: "http://localhost:5173" }, { Origin: "http://localhost:5173", Authorization: "Bearer wrong" }]) assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "https://www.youtube.com/watch?v=complete" }, headers, authenticated: false })).status, 401);
      assert.equal((await request("/healthz", { headers: { Origin: "https://unrelated.test" }, authenticated: false })).status, 403);
      assert.deepEqual(await fs.readdir(jars), []);
    });
    await test("Unsupported cookie/path/flags fields are rejected without echo", async () => {
      for (const property of ["cookies", "cookieFile", "args", "path"]) {
        const reply = await request("/api/jobs", { method: "POST", body: { kind: "video", url: "https://www.youtube.com/watch", [property]: sentinel } }); assert.equal(reply.status, 400); confidential(reply.data);
      }
    });
    for (const [mode, kind, host] of [["complete", "video", "www.youtube.com"], ["complete", "audio", "youtu.be"], ["title", "video", "www.youtube.com"]]) await test(`Session ${host} ${kind}: copy, args/env, logs, ready-before-cleanup and single-use delivery (${mode})`, async () => {
      const id = await create(mode, kind, `https://${host}/watch?v=${mode}`);
      const job = await terminal(id); assert.equal(job.status, "complete"); confidential(job);
      assert.equal(job.filename, `${kind}-${id}.${kind === "audio" ? "mp3" : "mp4"}`);
      assert(!(await fs.stat(`${jars}/${id}`).catch(() => null)));
      const audit = JSON.parse(await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8"));
      assert(audit.cookieFile.startsWith(`${jars}/${id}/`)); assert(!audit.hasCredentialEnv && !audit.hasSourceEnv); assert(!audit.args.join(" ").includes(sentinel));
      for (const op of [["GET", ""], ["POST", "/ticket"], ["DELETE", ""]]) assert.equal((await request(`/api/jobs/${id}${op[1]}`, { method: op[0], authenticated: false })).status, 401);
      const ticket = await request(`/api/jobs/${id}/ticket`, { method: "POST" }); assert.equal(ticket.status, 200); confidential(ticket.data);
      const delivered = await request(ticket.data.downloadUrl, { authenticated: false }); assert.equal(delivered.status, 200); assert(delivered.data.length > 1000); confidential(delivered.headers.get("content-disposition")); assert(!delivered.data.includes(Buffer.from(sentinel)));
      assert.equal((await request(ticket.data.downloadUrl, { authenticated: false })).status, 401);
      await clean(id); confidential(logs); assert.equal(await fs.readFile(source, "utf8"), sourceContents);
    });
    await test("Non-YouTube jobs receive no cookie jar while session-mode logs stay private", async () => {
      const id = await create("complete", "video", "https://fixture.test/media.mp4"); assert.equal((await terminal(id)).status, "complete");
      const audit = JSON.parse(await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8")); assert.equal(audit.cookieFile, null);
      await request(`/api/jobs/${id}`, { method: "DELETE" }); await clean(id); confidential(logs);
    });
    await test("HTTP YouTube is rejected rather than using a source session", async () => { assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "http://www.youtube.com/watch" } })).status, 400); });
    for (const mode of ["failure", "outside", "symlink", "hardlink", "spawn-error", "oversize", "jar-growth"]) await test(`Adversarial result or failure ${mode} cleans and never delivers secrets`, async () => {
      const id = await create(mode); const job = await terminal(id); assert.equal(job.status, "failed"); confidential(job); await clean(id);
      assert.equal((await request(`/api/jobs/${id}/ticket`, { method: "POST" })).status, 409); confidential(logs);
    });
    await test("A valid ticket cannot serve an output replaced with a secret link", async () => {
      const id = await create(); const job = await terminal(id); assert.equal(job.status, "complete");
      const ticket = await request(`/api/jobs/${id}/ticket`, { method: "POST" }); assert.equal(ticket.status, 200);
      const directory = `/tmp/downloads/${id}`, names = await fs.readdir(directory);
      const output = names.find(name => name.endsWith(".mp4")); assert(output);
      await fs.unlink(`${directory}/${output}`); await fs.symlink(source, `${directory}/${output}`);
      const reply = await request(ticket.data.downloadUrl, { authenticated: false }); assert.equal(reply.status, 410); confidential(reply.data); await clean(id); confidential(logs);
    });
    await test("Cancellation stops a hostile child before deleting its jar", async () => {
      const id = await create("child"); await pause(1500);
      assert.equal((await request(`/api/jobs/${id}`, { method: "DELETE" })).data.status, "cancelled"); await clean(id); await pause(400); assert(!(await fs.stat(`${jars}/${id}`).catch(() => null))); confidential(logs);
    });
    await test("Timeout stops the process and clears the cookie jar", async () => { const id = await create("timeout"); const job = await terminal(id); assert.equal(job.status, "failed"); assert.match(job.message, /tiempo máximo/); await clean(id); confidential(logs); });
    await test("Expired ticket refuses delivery without revealing session", async () => {
      const id = await create(); assert.equal((await terminal(id)).status, "complete"); const ticket = await request(`/api/jobs/${id}/ticket`, { method: "POST" }); await pause(11000);
      const reply = await request(ticket.data.downloadUrl, { authenticated: false }); assert.equal(reply.status, 401); confidential(reply.data); await request(`/api/jobs/${id}`, { method: "DELETE" }); await clean(id);
    });
    await test("Injected cleanup failure blocks session jobs, then retries after repair", async () => {
      await fs.writeFile("/tmp/qualification-fail-cleanup", "fixture");
      try { const id = await create(); assert.equal((await terminal(id)).status, "failed"); assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "https://www.youtube.com/watch" } })).status, 503); confidential(logs); }
      finally { await fs.unlink("/tmp/qualification-fail-cleanup"); }
      const retry = await create(); assert.equal((await terminal(retry)).status, "complete"); await request(`/api/jobs/${retry}`, { method: "DELETE" }); await clean(retry);
    });
    await test("Graceful shutdown kills descendants and clears jars; restarted API permits retry", async () => {
      const id = await create("child"); await pause(1500); await stop(); await clean(id); assert.equal(await fs.readFile(source, "utf8"), sourceContents); await start();
      assert.equal((await request(`/api/jobs/${id}`)).status, 404); const retry = await create(); assert.equal((await terminal(retry)).status, "complete"); await request(`/api/jobs/${retry}`, { method: "DELETE" }); await clean(retry);
    });
    await test("Abrupt host-like stop leaves a jar which startup removes before readiness", async () => {
      const id = await create("slow"); await pause(1200); const audit = JSON.parse(await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8"));
      await stop("SIGKILL"); try { process.kill(-audit.pid, "SIGKILL"); } catch {}
      assert(await fs.stat(`${jars}/${id}`)); await start(); assert.deepEqual(await fs.readdir(jars), []); assert.equal((await request(`/api/jobs/${id}`)).status, 404); assert.equal(await fs.readFile(source, "utf8"), sourceContents);
    });
    await test("Credential and job limits remain active", async () => {
      await start({ AUTH_FAILURE_LIMIT: "2", JOB_CREATE_LIMIT: "2" });
      for (let n = 0; n < 2; n++) assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "https://www.youtube.com/watch" }, authenticated: false })).status, 401);
      assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "https://www.youtube.com/watch" } })).status, 429);
      await start({ JOB_CREATE_LIMIT: "2" });
      for (let n = 0; n < 2; n++) assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "https://www.youtube.com/watch", unsupported: "fixture" } })).status, 400);
      assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "https://www.youtube.com/watch" } })).status, 429);
    });
  } finally { await stop(); }
  console.log(JSON.stringify({ summary: { passed: results.filter(r => r.status === "pass").length, failed: results.filter(r => r.status === "fail").length, scope: "Synthetic session, injected DNS/downloader/faults, real API/seccomp; no real cookies or deployment" }, results }));
  suiteComplete = true;
  process.exitCode = results.some(r => r.status === "fail") ? 1 : 0;
})().catch(async error => { console.error(JSON.stringify({ fatal: error.message })); suiteComplete = true; await stop(); process.exitCode = 1; });
