"use strict";
// Only fictitious session/keys and controlled destinations; separate from Render.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const results = [], credential = "synthetic-playlist-access", source = "/fixtures/youtube-cookies.txt";
const jars = "/tmp/yt-dlp/video-audio-dl-cookie-jars";
let api, logs = "", sentinel;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(150); } throw new Error("Controlled condition timed out"); }
async function test(name, fn) { try { await fn(); results.push({ name, status: "pass" }); } catch (error) { results.push({ name, status: "fail", error: error.message.slice(0, 500) }); } console.log(JSON.stringify(results.at(-1))); }
function confidential(value) { const text = JSON.stringify(value); for (const secret of [credential, sentinel, source, jars]) assert(!text.includes(secret), "Private synthetic value escaped"); }
async function request(path, { method = "GET", body, authenticated = true, headers = {}, signal } = {}) {
  const response = await fetch("http://127.0.0.1:3000" + path, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${credential}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: signal || AbortSignal.timeout(60000) });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  if (!Buffer.isBuffer(data)) confidential(data);
  return { status: response.status, data, headers: response.headers };
}
async function stop(signal = "SIGTERM") { if (api?.exitCode === null && !api.signalCode) { const closed = once(api, "close"); api.kill(signal); await closed; } }
async function start(env = {}) {
  await stop(); logs = "";
  api = spawn("node", ["--require", "/private-tests/bootstrap.cjs", "/app/server.js"], { env: { ...process.env, AUTH_REQUIRED: "true", ACCESS_CREDENTIAL: credential, YOUTUBE_COOKIES_FILE: source, YTDLP_PATH: "/private-tests/fake-downloader.py", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [api.stdout, api.stderr]) stream.on("data", part => { logs = (logs + part).slice(-40000); });
  await until(async () => { if (api.exitCode !== null) throw new Error("Controlled API exited"); try { return (await request("/healthz")).status === 200; } catch { return false; } });
}
async function preview(list = "PLtest", host = "music.youtube.com") { const r = await request("/api/playlists/preview", { method: "POST", body: { url: `https://${host}/playlist?list=${list}` } }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function batch(p, size = 5, kind = "video") { const r = await request("/api/playlist-batches", { method: "POST", body: { previewId: p.previewId, entryIds: p.entries.filter(e => e.available).slice(0, size).map(e => e.id).reverse(), kind } }); assert.equal(r.status, 201); return r.data; }
async function begin(b, row, attemptId = randomUUID()) { const r = await request(`/api/playlist-batches/${b.id}/items/${row.id}/start`, { method: "POST", body: { attemptId } }); assert.equal(r.status, 202, JSON.stringify(r.data)); return r.data; }
async function state(b) { const r = await request(`/api/playlist-batches/${b.id}`); assert.equal(r.status, 200); return r.data; }
async function terminal(b, row) { return until(async () => { const r = (await state(b)).entries.find(e => e.id === row.id); return ["ready", "failed", "cancelled", "expired"].includes(r.status) && r; }); }
async function deliver(row) { const ticket = await request(`/api/jobs/${row.jobId}/ticket`, { method: "POST" }); assert.equal(ticket.status, 200); const r = await request(ticket.data.downloadUrl, { authenticated: false }); assert.equal(r.status, 200); assert(r.data.length > 100); assert.match(r.headers.get("content-disposition"), /filename\*=UTF-8/); return ticket.data.filename; }
async function discard(b) { assert.equal((await request(`/api/playlist-batches/${b.id}?discard=true`, { method: "DELETE" })).status, 200); }
async function empty() { await until(async () => (await fs.readdir(jars)).length === 0 && (await fs.readdir("/tmp/downloads")).length === 0); }
(async () => {
  await fs.mkdir("/tmp/yt-dlp", { recursive: true });
  await fs.writeFile("/tmp/yt-dlp/qualification-media.mp4", Buffer.from(await (await fetch("http://fixture.test/media.mp4")).arrayBuffer()));
  const original = await fs.readFile(source); sentinel = original.toString().trim().split("\t").at(-1);
  try {
    await start();
    await test("Every additive route authenticates before work; allowed/forged Origin is not authorization", async () => {
      const id = randomUUID();
      for (const [path, method] of [["/api/playlists/preview", "POST"], ["/api/playlist-batches", "POST"], [`/api/playlist-batches/${id}`, "GET"], [`/api/playlist-batches/${id}`, "DELETE"], [`/api/playlist-batches/${id}?discard=true`, "DELETE"], [`/api/playlist-batches/${id}/items/${id}/start`, "POST"]]) {
        for (const headers of [{}, { Origin: "http://localhost:5173" }, { Origin: "http://localhost:5173", Authorization: "Bearer synthetic-wrong" }]) assert.equal((await request(path, { method, body: method === "POST" ? {} : undefined, authenticated: false, headers })).status, 401);
        assert.equal((await request(path, { method, authenticated: false, headers: { Origin: "https://forged.invalid" } })).status, 403);
      }
      await empty();
    });
    await test("Playlist rejected by individual endpoint before extraction", async () => { assert.equal((await request("/api/jobs", { method: "POST", body: { url: "https://music.youtube.com/playlist?list=PLtest", kind: "audio" } })).status, 400); await empty(); });
    await test("Protected Music preview: flat/capped metadata, missing rows, text titles, distinct positions and no secrets", async () => {
      const p = await preview("PLlarge"); assert.equal(p.entries.length, 50); assert(p.truncated); assert.equal(p.totalKnown, 80); assert(!p.entries[2].available); assert.equal(p.entries[3].duration, null); assert.notEqual(p.entries[0].id, p.entries[1].id);
      const audit = JSON.parse(await fs.readFile("/tmp/yt-dlp/fixture-audit.json"));
      assert(audit.cookieFile.startsWith(jars + "/")); assert(!audit.hasSourceEnv && !audit.hasCredentialEnv); assert(audit.args.includes("--flat-playlist") && audit.args.includes("1:51")); assert(audit.args.at(-1).startsWith("https://music.youtube.com/"));
      assert(!JSON.stringify(p).includes("http_headers") && !JSON.stringify(p).includes("thumbnail")); await empty(); confidential(logs);
    });
    await start();
    await test("Entire 123-entry Music list paginates, caches stable identities and selects across all pages without five-song cap", async () => {
      const first = await preview("PLpages"); assert.equal(first.limits.batchItems, null); assert.equal(first.totalKnown, null);
      const page = async token => { const r = await request("/api/playlists/preview", { method: "POST", body: { previewId: first.previewId, pageToken: token } }); assert.equal(r.status, 200); return r.data; };
      const second = await page(first.nextPageToken), third = await page(second.nextPageToken);
      assert.equal(second.entries[0].position, 51); assert.equal(third.entries[0].position, 101); assert.equal(third.entries.length, 23); assert.equal(third.nextPageToken, null);
      const before = await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8");
      assert.deepEqual((await page(first.pageToken)).entries, first.entries); assert.deepEqual((await page(second.pageToken)).entries, second.entries);
      assert.equal(await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8"), before); await empty();
      for (const body of [{ previewId: first.previewId, pageToken: randomUUID() }, { previewId: first.previewId, pageToken: second.pageToken, start: 1000 }]) assert.equal((await request("/api/playlists/preview", { method: "POST", body })).status, 400);
      const selected = [...third.entries, ...second.entries, ...first.entries].map(e => e.id);
      const foreign = Array.from({ length: 300 }, () => randomUUID());
      const foreignSelection = { previewId: first.previewId, entryIds: foreign, kind: "audio" };
      assert(Buffer.byteLength(JSON.stringify(foreignSelection)) > 8192);
      assert.equal((await request("/api/playlist-batches", { method: "POST", body: foreignSelection })).status, 400);
      const registered = await request("/api/playlist-batches", { method: "POST", body: { previewId: first.previewId, entryIds: selected, kind: "audio" } }); assert.equal(registered.status, 201); assert.equal(registered.data.entries.length, 123); assert.equal(registered.data.entries[122].position, 123); await empty(); await discard(registered.data); confidential(logs);
    });
    await start();
    await test("Create preserves source order, no media; invalid selection/flags rejected", async () => {
      const p = await preview("PLmixed");
      for (const extra of [{ entryIds: [] }, { entryIds: [p.entries[2].id] }, { entryIds: [randomUUID()] }, { url: "https://evil.invalid" }]) {
        const r = await request("/api/playlist-batches", { method: "POST", body: { previewId: p.previewId, entryIds: [p.entries[0].id], kind: "audio", ...extra } }); assert.equal(r.status, 400);
      }
      const b = await batch(p); assert.deepEqual(b.entries.map(e => e.position), [1, 2, 4, 5, 6]); await empty(); await discard(b);
    });
    await start();
    await test("Audio/video: same attempt concurrent/lost reply is idempotent, two ready pause, native delivery frees capacity", async () => {
      for (const kind of ["audio", "video"]) {
        const p = await preview(), b = await batch(p, 3, kind), attemptId = randomUUID(), path = `/api/playlist-batches/${b.id}/items/${b.entries[0].id}/start`;
        const starts = await Promise.all(Array.from({ length: 3 }, () => request(path, { method: "POST", body: { attemptId } })));
        assert(starts.every(r => r.status === 202)); assert.equal(new Set(starts.map(r => r.data.jobId)).size, 1);
        let first = await terminal(b, b.entries[0]); assert.equal(first.status, "ready");
        assert.equal((await request(path, { method: "POST", body: { attemptId } })).data.jobId, first.jobId);
        await begin(b, b.entries[1]); const second = await terminal(b, b.entries[1]); assert.equal(second.status, "ready");
        const limited = await request(`/api/playlist-batches/${b.id}/items/${b.entries[2].id}/start`, { method: "POST", body: { attemptId: randomUUID() } }); assert.equal(limited.status, 429); assert.equal((await state(b)).pauseReason, "ready_files");
        assert.match(await deliver(first), /^Canción de prueba 1\.(mp3|mp4)$/);
        await until(async () => (await state(b)).entries[0].status === "delivered");
        await begin(b, b.entries[2]); assert.equal((await terminal(b, b.entries[2])).status, "ready");
        await deliver(second); await discard(b); await empty();
      }
    });
    await start();
    await test("Individual YouTube/Music links with playlist context create one canonical media job", async () => {
      for (const host of ["www.youtube.com", "music.youtube.com"]) {
        const r = await request("/api/jobs", { method: "POST", body: { url: `https://${host}/watch?v=pl000000000&list=PLpages&si=synthetic-tracking`, kind: "audio" } }); assert.equal(r.status, 202);
        await until(async () => { const job = await request(`/api/jobs/${r.data.id}`); return job.data.status === "complete"; });
        const audit = JSON.parse(await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8")); assert.equal(audit.args.at(-1), `https://${host}/watch?v=pl000000000`); assert(audit.args.includes("--no-playlist"));
        const files = await fs.readdir(`/tmp/downloads/${r.data.id}`); assert.equal(files.filter(name => name.endsWith(".mp3")).length, 1);
        await request(`/api/jobs/${r.data.id}`, { method: "DELETE" }); await empty(); confidential(logs);
      }
    });
    await start();
    await test("Specific unavailable row preserves partial results; bot check pauses; retry requires a new attempt", async () => {
      for (const list of ["PLpartial", "PLbots"]) {
        const b = await batch(await preview(list), 3); await begin(b, b.entries[0]); assert.equal((await terminal(b, b.entries[0])).status, "ready");
        const failed = await begin(b, b.entries[1]); const row = await terminal(b, b.entries[1]); assert.equal(row.status, "failed"); assert.equal(row.pauseOnFailure, list === "PLbots");
        assert.equal((await begin(b, b.entries[1], failed.attemptId)).jobId, failed.jobId);
        const retry = await begin(b, b.entries[1]); assert.notEqual(retry.jobId, failed.jobId); await terminal(b, b.entries[1]);
        await begin(b, b.entries[2]); assert.equal((await terminal(b, b.entries[2])).status, "ready"); await discard(b); await empty(); confidential(logs);
      }
    });
    await start();
    await test("Cancel active/pending preserves ready; discard removes retained outputs and jars", async () => {
      const b = await batch(await preview("PLactive"), 3); await begin(b, b.entries[0]); const ready = await terminal(b, b.entries[0]);
      await begin(b, b.entries[1]); await until(async () => (await state(b)).entries[1].status === "running");
      const cancelled = await request(`/api/playlist-batches/${b.id}`, { method: "DELETE" }); assert.equal(cancelled.status, 200); assert.deepEqual(cancelled.data.entries.map(e => e.status), ["ready", "cancelled", "cancelled"]);
      assert.equal((await request(`/api/jobs/${ready.jobId}/ticket`, { method: "POST" })).status, 200); await discard(b); await empty(); assert.deepEqual(await fs.readFile(source), original);
    });
    await start({ JOB_CREATE_LIMIT: "1" });
    await test("Preview quota independent of job quota; fourth preview throttled", async () => {
      const p = await preview(); await preview("PLempty"); await preview(); assert.equal((await request("/api/playlists/preview", { method: "POST", body: { url: "https://youtube.com/playlist?list=PLtest" } })).status, 429);
      const b = await batch(p, 1); await begin(b, b.entries[0]); assert.equal((await terminal(b, b.entries[0])).status, "ready"); await discard(b);
    });
    await start();
    await test("Preview disconnect shares process admission and stops/cleans before next request", async () => {
      const controller = new AbortController(); const result = request("/api/playlists/preview", { method: "POST", body: { url: "https://youtube.com/playlist?list=PLslow" }, signal: controller.signal }).catch(() => null);
      await until(async () => (await fs.readdir(jars)).length === 1);
      assert.equal((await request("/api/jobs", { method: "POST", body: { url: "https://youtube.com/watch?v=complete", kind: "video" } })).status, 429);
      controller.abort(); await result; await empty(); assert.equal((await preview()).entries.length, 7);
    });
    await start();
    await test("An active media job rejects preview before another extractor or private jar", async () => {
      const created = await request("/api/jobs", { method: "POST", body: { url: "https://youtube.com/watch?v=slow", kind: "video" } }); assert.equal(created.status, 202);
      await until(async () => (await request(`/api/jobs/${created.data.id}`)).data.status === "running");
      await until(async () => { try { return JSON.parse(await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8")).args.at(-1).includes("v=slow"); } catch { return false; } });
      const before = await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8");
      assert.equal((await request("/api/playlists/preview", { method: "POST", body: { url: "https://youtube.com/playlist?list=PLtest" } })).status, 429);
      assert.equal(await fs.readFile("/tmp/yt-dlp/fixture-audit.json", "utf8"), before); assert.equal((await fs.readdir(jars)).length, 1);
      await request(`/api/jobs/${created.data.id}`, { method: "DELETE" }); await empty();
    });
    await start();
    await test("Malformed/oversized stdout never published; shutdown kills preview and restart loses snapshots", async () => {
      for (const list of ["PLoversize", "PLbadjson"]) { assert.equal((await request("/api/playlists/preview", { method: "POST", body: { url: `https://youtube.com/playlist?list=${list}` } })).status, 422); await empty(); }
      const controller = new AbortController(); const result = request("/api/playlists/preview", { method: "POST", body: { url: "https://youtube.com/playlist?list=PLslow" }, signal: controller.signal }).catch(() => null);
      await until(async () => (await fs.readdir(jars)).length === 1); await stop(); controller.abort(); await result; await empty(); await start();
      assert.equal((await request(`/api/playlist-batches/${randomUUID()}`)).status, 404); confidential(logs);
    });
    await start();
    await test("45-second metadata deadline stops the process and removes its private jar", async () => {
      const at = Date.now();
      const r = await request("/api/playlists/preview", { method: "POST", body: { url: "https://youtube.com/playlist?list=PLslow" } });
      assert.equal(r.status, 422); assert.match(r.data.error, /tardó demasiado/); assert(Date.now() - at >= 45000); await empty();
    });
    await start();
    await test("Preview cleanup fault blocks cookie work and leaves original untouched", async () => {
      await fs.writeFile("/tmp/qualification-fail-cleanup", "synthetic");
      try { assert.equal((await request("/api/playlists/preview", { method: "POST", body: { url: "https://youtube.com/playlist?list=PLtest" } })).status, 503); assert.deepEqual(await fs.readFile(source), original); confidential(logs); }
      finally { await fs.unlink("/tmp/qualification-fail-cleanup"); }
      await start(); await empty();
    });
    await start({ AUTH_REQUIRED: "false", YOUTUBE_COOKIES_FILE: "", ACCESS_CREDENTIAL: "" });
    await test("Open mode without session supports additive flow without credentials", async () => {
      const r = await request("/api/playlists/preview", { method: "POST", body: { url: "https://youtube.com/playlist?list=PLempty" }, authenticated: false }); assert.equal(r.status, 200); assert.equal(r.data.entries.length, 0); await empty();
      const p = await request("/api/playlists/preview", { method: "POST", body: { url: "https://music.youtube.com/playlist?list=PLtest" }, authenticated: false }); assert.equal(p.status, 200);
      const b = await request("/api/playlist-batches", { method: "POST", body: { previewId: p.data.previewId, entryIds: p.data.entries.slice(0, 6).map(e => e.id), kind: "video" }, authenticated: false }); assert.equal(b.status, 201); assert.equal(b.data.entries.length, 6);
      const row = b.data.entries[0], path = `/api/playlist-batches/${b.data.id}`;
      const job = await request(`${path}/items/${row.id}/start`, { method: "POST", body: { attemptId: randomUUID() }, authenticated: false }); assert.equal(job.status, 202);
      await until(async () => { const state = await request(path, { authenticated: false }); assert.equal(state.status, 200); return state.data.entries[0].status === "ready"; });
      assert.equal((await request(`/api/jobs/${job.data.jobId}/ticket`, { method: "POST", authenticated: false })).status, 200);
      assert.equal((await request(path, { method: "DELETE", authenticated: false })).status, 200);
      assert.equal((await request(`${path}?discard=true`, { method: "DELETE", authenticated: false })).status, 200); await empty();
    });
    await stop();
    await test("Real pinned CLI enumerates three deferred page ranges, never media, and keeps sandbox/proxy", async () => {
      const { createEgressProxy } = require("/app/egress-proxy"); const proxy = await createEgressProxy("/tmp/yt-dlp/real-playlist-proxy"), session = proxy.createSession();
      try {
        for (const [span, size, first] of [["1:51", 51, "pl000000000"], ["51:101", 51, "pl000000050"], ["101:151", 23, "pl000000100"]]) {
          const child = spawn("/usr/local/bin/download-sandbox", ["/usr/bin/python3", "-I", "/private-tests/playlist-real.py", "--flat-playlist", "--dump-single-json", "--skip-download", "--lazy-playlist", "--playlist-items", span, "--no-cache-dir", "https://www.youtube.com/playlist?list=PLcontrolled"], { env: { PATH: process.env.PATH, HOME: "/tmp", TMPDIR: "/tmp/yt-dlp", APP_MEDIA_MODE: "playlist_preview", ...session.env }, stdio: ["ignore", "pipe", "pipe"] });
          let output = "", error = ""; child.stdout.on("data", p => { output += p; }); child.stderr.on("data", p => { error += p; });
          const [code] = await once(child, "close"); assert.equal(code, 0, error.slice(-500)); const data = JSON.parse(output); assert.equal(data.entries.length, size); assert.equal(data.entries[0].id, first); assert(data.entries.every(e => !e.filepath));
        }
      } finally { session.close(); await proxy.close(); }
    });
    assert.deepEqual(await fs.readFile(source), original);
  } finally { await stop(); }
  console.log(JSON.stringify({ summary: { passed: results.filter(r => r.status === "pass").length, failed: results.filter(r => r.status === "fail").length, scope: "Local synthetic playlist API under real seccomp, 512MiB/0.1CPU; no real cookies, external YouTube or Render" }, results }));
  process.exitCode = results.some(r => r.status === "fail") ? 1 : 0;
})().catch(async () => { console.error("Controlled playlist suite could not finish"); await stop(); process.exitCode = 1; });
