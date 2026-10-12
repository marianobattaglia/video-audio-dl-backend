"use strict";
// Integration evidence uses ONLY the controlled fixture, fictitious session/key.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const credential = "synthetic-mode-access", source = "/fixtures/youtube-cookies.txt";
const results = []; let api, logs = "", original;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 45000; while (Date.now() < end) { const result = await fn(); if (result) return result; await wait(100); } throw new Error("Fixture timeout"); }
async function request(path, { method = "GET", body, auth = true, headers = {} } = {}) {
  const res = await fetch("http://127.0.0.1:3000" + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${credential}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(130000) });
  return { status: res.status, headers: res.headers, data: res.headers.get("content-type")?.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
async function stop() { if (api?.exitCode === null && !api.signalCode) { const done = once(api, "close"); api.kill("SIGTERM"); await done; } }
async function start(env = {}) {
  await stop(); logs = "";
  api = spawn("node", ["--require", "/private-tests/bootstrap.cjs", "/app/server.js"], { env: { ...process.env, AUTH_REQUIRED: "true", ACCESS_CREDENTIAL: credential, YOUTUBE_COOKIES_FILE: source, YTDLP_PATH: "/private-tests/fake-downloader.py", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [api.stdout, api.stderr]) stream.on("data", part => { logs = (logs + part).slice(-40000); });
  await until(async () => { if (api.exitCode !== null) throw new Error("Fixture API exited"); try { return (await request("/healthz")).status === 200; } catch { return false; } });
}
async function test(name, fn) { try { await fn(); results.push({ name, status: "pass" }); } catch (error) { results.push({ name, status: "fail", error: error.message.slice(0, 500) }); } console.log(JSON.stringify(results.at(-1))); }
async function create(mode, kind = "audio", list = "PLtest", count = 3) {
  const preview = await request("/api/playlists/preview", { method: "POST", body: { url: `https://music.youtube.com/playlist?list=${list}` } }); assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.limits.deliveryModes, ["manual", "automatic", "zip"]);
  const response = await request("/api/playlist-batches", { method: "POST", body: { previewId: preview.data.previewId, entryIds: preview.data.entries.filter(e => e.available).slice(0, count).map(e => e.id), kind, deliveryMode: mode } });
  assert.equal(response.status, 201); assert.equal(response.data.deliveryMode, mode); return response.data;
}
const path = b => `/api/playlist-batches/${b.id}`;
async function state(b) { const r = await request(path(b)); assert.equal(r.status, 200); return r.data; }
async function prepare(b, item) {
  const r = await request(`${path(b)}/items/${item.id}/start`, { method: "POST", body: { attemptId: randomUUID() } }); assert.equal(r.status, 202, JSON.stringify(r.data));
  return until(async () => { const row = (await state(b)).entries.find(e => e.id === item.id); return ["ready", "failed"].includes(row.status) && row; });
}
async function discard(b) { assert.equal((await request(path(b) + "?discard=true", { method: "DELETE" })).status, 200); }
async function append(b, row) { return request(path(b) + "/archive/append", { method: "POST", body: { entryId: row.id, jobId: row.jobId, attemptId: row.attemptId } }); }
async function zipEntries(bytes) {
  const filename = `/tmp/yt-dlp/inspect-${randomUUID()}.zip`; await fs.writeFile(filename, bytes);
  const child = spawn("/usr/bin/python3", ["-c", "import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'names':z.namelist(),'summary':z.read('resultado.txt').decode(),'sizes':[i.file_size for i in z.infolist()],'stored':all(i.compress_type==0 for i in z.infolist()),'valid':z.testzip() is None}))", filename]);
  let out = ""; child.stdout.on("data", chunk => { out += chunk; }); const [code] = await once(child, "close"); await fs.rm(filename); assert.equal(code, 0); return JSON.parse(out);
}
(async () => {
  original = await fs.readFile(source);
  await fs.mkdir("/tmp/yt-dlp", { recursive: true });
  await fs.writeFile("/tmp/yt-dlp/qualification-media.mp4", Buffer.from(await (await fetch("http://fixture.test/media.mp4")).arrayBuffer()));
  try {
    await start();
    await test("All confirmation/archive operations authorize independently of Origin; no secret echo", async () => {
      const id = randomUUID();
      for (const route of [`/api/playlist-batches/${id}/items/${id}/transfer-ticket`, `/api/playlist-batches/${id}/items/${id}/save-confirmation`, ...["append", "finalize", "ticket"].map(action => `/api/playlist-batches/${id}/archive/${action}`)]) {
        for (const headers of [{}, { Origin: "http://localhost:5173" }, { Authorization: "Bearer wrong" }]) assert.equal((await request(route, { method: "POST", body: {}, auth: false, headers })).status, 401);
        assert.equal((await request(route, { method: "POST", body: {}, headers: { Origin: "https://forged.invalid" } })).status, 403);
      }
    });
    await test("Automatic MP3/MP4 retain after transfer, reject cross-type tickets and stale ACK; confirm idempotently", async () => {
      for (const kind of ["audio", "video"]) {
        const b = await create("automatic", kind), row = await prepare(b, b.entries[0]);
        const base = `${path(b)}/items/${row.id}`;
        assert.equal((await request(`/api/jobs/${row.jobId}/ticket`, { method: "POST" })).status, 409);
        assert.equal((await request(base + "/transfer-ticket", { method: "POST", body: { jobId: row.jobId, folder: "forbidden" } })).status, 400);
        let t = await request(base + "/transfer-ticket", { method: "POST", body: { jobId: row.jobId } }); assert.equal(t.status, 200);
        const token = new URL(t.data.downloadUrl, "http://localhost").searchParams.get("ticket");
        assert.equal((await request(`/api/jobs/${row.jobId}/file?ticket=${token}`, { auth: false })).status, 401);
        assert.equal((await request(path(b) + `/archive/file?ticket=${token}`, { auth: false })).status, 401);
        const file = await request(t.data.downloadUrl, { auth: false }); assert.equal(file.status, 200); assert(file.data.length > 100);
        const transferred = await until(async () => { const r = (await state(b)).entries[0]; return r.status === "awaiting_save_confirmation" && r; });
        assert.equal(transferred.expiresAt, row.expiresAt); assert((await fs.readdir(`/tmp/downloads/${row.jobId}`)).length > 0);
        assert.equal((await request(t.data.downloadUrl, { auth: false })).status, 401);
        if (kind === "audio") {
          const oldDelivery = t.data.deliveryId;
          t = await request(base + "/transfer-ticket", { method: "POST", body: { jobId: row.jobId } }); assert.equal(t.status, 200);
          assert.equal((await request(base + "/save-confirmation", { method: "POST", body: { jobId: row.jobId, deliveryId: oldDelivery } })).status, 409);
          assert.equal((await request(t.data.downloadUrl, { auth: false })).status, 200);
          await until(async () => (await state(b)).entries[0].status === "awaiting_save_confirmation");
          assert.equal((await state(b)).entries[0].expiresAt, row.expiresAt);
        }
        const confirmation = { jobId: row.jobId, deliveryId: t.data.deliveryId };
        assert.equal((await request(base + "/save-confirmation", { method: "POST", body: { ...confirmation, deliveryId: randomUUID() } })).status, 409);
        assert.equal((await request(base + "/save-confirmation", { method: "POST", body: confirmation })).data.status, "saved");
        assert.equal((await request(base + "/save-confirmation", { method: "POST", body: confirmation })).data.status, "saved");
        assert.equal((await state(b)).entries[0].status, "saved");
        await assert.rejects(fs.stat(`/tmp/downloads/${row.jobId}`), error => error.code === "ENOENT");
        assert.equal((await request(base + "/start", { method: "POST", body: { attemptId: randomUUID() } })).status, 409);
        await discard(b);
      }
    });
    await start();
    await test("ZIP MP3/MP4 sequential append/idempotency/finalization and one native file, public manifest only", async () => {
      for (const kind of ["audio", "video"]) {
        const b = await create("zip", kind);
        assert.equal((await request(path(b) + "/archive/ticket", { method: "POST", body: {} })).status, 409);
        for (const item of b.entries) {
          const row = await prepare(b, item); assert.equal(row.status, "ready");
          const a = await append(b, row); assert.equal(a.status, 200, JSON.stringify(a.data));
          assert.equal((await append(b, row)).status, 200); assert.equal(a.data.entries.find(e => e.id === row.id).status, "archived");
          await assert.rejects(fs.stat(`/tmp/downloads/${row.jobId}`), error => error.code === "ENOENT");
        }
        const finalized = await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: false } }); assert.equal(finalized.status, 200, JSON.stringify(finalized.data)); assert.equal(finalized.data.archive.state, "ready");
        assert.equal((await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: false } })).status, 200);
        const ticket = await request(path(b) + "/archive/ticket", { method: "POST", body: {} }); assert.equal(ticket.status, 200);
        const file = await request(ticket.data.downloadUrl, { auth: false }); assert.equal(file.status, 200); assert.equal(file.headers.get("content-type"), "application/zip");
        const archive = await zipEntries(file.data); assert(archive.stored && archive.valid); assert.equal(archive.names.length, 4); assert.equal(new Set(archive.names).size, 4); assert.equal(archive.names.at(-1), "resultado.txt");
        for (const secret of [credential, source, original.toString().trim().split("\t").at(-1), "/tmp/", "http", "Cookie"]) assert(!JSON.stringify(archive).includes(secret));
        assert.equal((await request(ticket.data.downloadUrl, { auth: false })).status, 401);
        await discard(b);
      }
    });
    await start();
    await test("ZIP cancellation preserves committed partial; explicit finalize omits pending", async () => {
      const b = await create("zip"), row = await prepare(b, b.entries[0]); assert.equal((await append(b, row)).status, 200);
      await request(path(b), { method: "DELETE" });
      assert.equal((await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: false } })).status, 409);
      const final = await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: true } }); assert.equal(final.status, 200); assert.equal(final.data.archive.state, "partial_ready");
      const t = await request(path(b) + "/archive/ticket", { method: "POST", body: {} }), file = await request(t.data.downloadUrl, { auth: false });
      const zip = await zipEntries(file.data); assert.equal(zip.names.length, 2); assert(zip.summary.includes("no incluido")); await discard(b);
    });
    await start();
    await test("Failed ZIP worker rolls back staging, preserves prior ZIP and source; retry commits once", async () => {
      const b = await create("zip", "video"), one = await prepare(b, b.entries[0]); assert.equal((await append(b, one)).status, 200);
      const before = await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`);
      const two = await prepare(b, b.entries[1]); await fs.writeFile("/tmp/fixture-archive-failure", "synthetic");
      try { assert.equal((await append(b, two)).status, 422); } finally { await fs.rm("/tmp/fixture-archive-failure"); }
      assert.deepEqual(await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`), before);
      assert.equal((await state(b)).entries[1].status, "ready");
      assert((await fs.readdir(`/tmp/downloads/${two.jobId}`)).length > 0);
      assert.deepEqual(await fs.readdir(`/tmp/downloads/${b.id}`), ["archive.zip"]);
      assert.equal((await append(b, two)).status, 200); assert.equal((await append(b, two)).status, 200);
      await discard(b);
    });
    await start();
    await test("Specific source failure produces an explicit partial ZIP with ordered unique positions", async () => {
      const b = await create("zip", "video", "PLpartial");
      for (const item of b.entries) { const row = await prepare(b, item); if (row.status === "ready") assert.equal((await append(b, row)).status, 200); else assert.equal(row.reason, "source_unavailable"); }
      assert.equal((await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: false } })).status, 409);
      assert.equal((await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: true } })).data.archive.state, "partial_ready");
      const t = await request(path(b) + "/archive/ticket", { method: "POST", body: {} }); const zip = await zipEntries((await request(t.data.downloadUrl, { auth: false })).data);
      assert.equal(zip.names.length, 3); assert(zip.names[0].startsWith("0001") && zip.names[1].startsWith("0003")); assert(zip.summary.includes("source_unavailable")); await discard(b);
      const duplicate = await create("zip", "video", "PLmixed", 2);
      assert.equal(duplicate.entries[0].videoId, duplicate.entries[1].videoId);
      for (const item of duplicate.entries) assert.equal((await append(duplicate, await prepare(duplicate, item))).status, 200);
      assert.equal((await request(path(duplicate) + "/archive/finalize", { method: "POST", body: { allowPartial: false } })).status, 200);
      const ticket = await request(path(duplicate) + "/archive/ticket", { method: "POST", body: {} });
      const members = await zipEntries((await request(ticket.data.downloadUrl, { auth: false })).data);
      assert.equal(members.names.length, 3); assert(members.names[0].startsWith("0001") && members.names[1].startsWith("0002")); await discard(duplicate);
    });
    await start({ MAX_OUTPUT_MB: "1", MAX_TEMP_MB: "3" });
    await test("Shared peak budget stops growing ZIP before writing, preserving source and package for partial finalization", async () => {
      const b = await create("zip", "video", "PLpages", 10); let limited = false, included = 0, discardedJob;
      for (const item of b.entries) {
        const started = await request(`${path(b)}/items/${item.id}/start`, { method: "POST", body: { attemptId: randomUUID() } });
        if (started.status === 429) { limited = true; break; }
        assert.equal(started.status, 202);
        const row = await until(async () => { const r = (await state(b)).entries.find(e => e.id === item.id); return r.status === "ready" && r; });
        const before = included ? await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`) : null;
        const response = await append(b, row);
        if (response.status === 429) { limited = true; discardedJob = row.jobId; if (before) assert.deepEqual(await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`), before); assert((await fs.readdir(`/tmp/downloads/${row.jobId}`)).length > 0); break; }
        assert.equal(response.status, 200); included++;
      }
      assert(limited && included > 0);
      const final = await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: true } }); assert.equal(final.status, 200); assert.equal(final.data.archive.state, "partial_ready");
      assert(discardedJob, "Capacity fixture must retain an unincorporated source before explicit partial finalization");
      await assert.rejects(fs.stat(`/tmp/downloads/${discardedJob}`), error => error.code === "ENOENT");
      await discard(b);
    });
    await start();
    await test("Archive validator refuses altered bytes and links; discard preserves synthetic secret source", async () => {
      for (const attack of ["bytes", "link"]) {
        const b = await create("zip", "video", "PLtest", 1), row = await prepare(b, b.entries[0]); assert.equal((await append(b, row)).status, 200);
        assert.equal((await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: false } })).status, 200);
        const output = `/tmp/downloads/${b.id}/archive.zip`;
        if (attack === "bytes") await fs.appendFile(output, "synthetic-corruption");
        else { await fs.unlink(output); await fs.symlink(source, output); }
        assert.equal((await request(path(b) + "/archive/ticket", { method: "POST", body: {} })).status, 500); await discard(b); assert.deepEqual(await fs.readFile(source), original);
      }
    });
    await start({ AUTH_REQUIRED: "false", ACCESS_CREDENTIAL: "", YOUTUBE_COOKIES_FILE: "" });
    await test("Open access without source session supports automatic confirmation and ZIP independently", async () => {
      const b = await create("zip", "video", "PLtest", 1), row = await prepare(b, b.entries[0]); assert.equal((await append(b, row)).status, 200);
      assert.equal((await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: false }, auth: false })).status, 200);
      const t = await request(path(b) + "/archive/ticket", { method: "POST", body: {}, auth: false }); assert.equal(t.status, 200); assert.equal((await request(t.data.downloadUrl, { auth: false })).status, 200); await discard(b);
      const a = await create("automatic", "video", "PLtest", 1), item = await prepare(a, a.entries[0]), base = `${path(a)}/items/${item.id}`;
      const ticket = await request(base + "/transfer-ticket", { method: "POST", body: { jobId: item.jobId }, auth: false }); assert.equal(ticket.status, 200);
      assert.equal((await request(ticket.data.downloadUrl, { auth: false })).status, 200);
      await until(async () => (await state(a)).entries[0].status === "awaiting_save_confirmation");
      assert.equal((await request(base + "/save-confirmation", { method: "POST", body: { jobId: item.jobId, deliveryId: ticket.data.deliveryId }, auth: false })).status, 200); await discard(a);
    });
    await start({ MAX_ARCHIVE_OPERATION_SECONDS: "2" });
    await test("Archive deadline and cancellation stop workers before releasing shared admission and preserve committed bytes", async () => {
      const b = await create("zip", "video"), first = await prepare(b, b.entries[0]); assert.equal((await append(b, first)).status, 200);
      const previous = await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`), second = await prepare(b, b.entries[1]);
      await fs.writeFile("/tmp/fixture-archive-slow", "synthetic");
      const began = Date.now(); const pending = append(b, second);
      try {
        await until(async () => (await state(b)).entries[1].status === "archiving");
        assert.equal((await append(b, second)).status, 409);
        assert((await fs.readdir(`/tmp/downloads/${second.jobId}`)).length > 0);
        assert.equal((await request("/api/playlists/preview", { method: "POST", body: { url: "https://youtube.com/playlist?list=PLtest" } })).status, 429);
        assert.equal((await pending).status, 422); assert(Date.now() - began >= 1800 && Date.now() - began < 10000);
      } finally { await fs.rm("/tmp/fixture-archive-slow"); }
      assert.deepEqual(await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`), previous); assert.equal((await state(b)).entries[1].status, "ready");
      assert.equal((await append(b, second)).status, 200);
      const committed = await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`), third = await prepare(b, b.entries[2]);
      await fs.writeFile("/tmp/fixture-archive-slow", "synthetic"); const interrupted = append(b, third);
      try {
        await until(async () => (await state(b)).entries[2].status === "archiving");
        assert.equal((await request(path(b), { method: "DELETE" })).status, 200); assert.equal((await interrupted).status, 422);
      } finally { await fs.rm("/tmp/fixture-archive-slow"); }
      assert.deepEqual(await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`), committed);
      assert.deepEqual(await fs.readdir(`/tmp/downloads/${b.id}`), ["archive.zip"]);
      assert.equal((await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: true } })).status, 200); await discard(b);
    });
    await start({ MAX_ZIP_BATCH_SECONDS: "1" });
    await test("Total ZIP deadline stops new preparation without silently dropping pending selection", async () => {
      const b = await create("zip", "video", "PLtest", 2), row = await prepare(b, b.entries[0]); assert.equal(row.status, "ready");
      await wait(1100); const stopped = await state(b); assert(stopped.cancelled); assert.equal(stopped.archive.state, "paused");
      const expiry = stopped.archive.expiresAt; await wait(100); assert.equal((await state(b)).archive.expiresAt, expiry);
      assert.equal((await request(`${path(b)}/items/${b.entries[1].id}/start`, { method: "POST", body: { attemptId: randomUUID() } })).status, 409);
      assert.equal((await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: true } })).status, 409); await discard(b);
    });
    await start();
    await test("Renewed ZIP ticket never extends package TTL; expired ticket and restarted archive are unavailable", async () => {
      const b = await create("zip", "video", "PLtest", 1), row = await prepare(b, b.entries[0]); assert.equal((await append(b, row)).status, 200);
      const final = await request(path(b) + "/archive/finalize", { method: "POST", body: { allowPartial: false } }); assert.equal(final.status, 200);
      const expiresAt = final.data.archive.expiresAt;
      const old = await request(path(b) + "/archive/ticket", { method: "POST", body: {} }); assert.equal(old.status, 200);
      await wait(11000); assert.equal((await request(old.data.downloadUrl, { auth: false })).status, 401);
      const renewed = await request(path(b) + "/archive/ticket", { method: "POST", body: {} }); assert.equal(renewed.status, 200); assert.equal((await state(b)).archive.expiresAt, expiresAt);
      await start(); assert.equal((await request(path(b))).status, 404); assert.equal((await request(renewed.data.downloadUrl, { auth: false })).status, 401);
      assert.deepEqual(await fs.readdir("/tmp/downloads"), []); assert.deepEqual(await fs.readFile(source), original);
    });
    await start();
    await test("Shutdown stops an active archive worker, removes staging and sweeps its transient package at restart", async () => {
      const b = await create("zip", "video", "PLtest", 2), first = await prepare(b, b.entries[0]); assert.equal((await append(b, first)).status, 200);
      const previousPid = JSON.parse(await fs.readFile("/tmp/yt-dlp/archive-audit.json", "utf8")).pid;
      const before = await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`), second = await prepare(b, b.entries[1]);
      await fs.writeFile("/tmp/fixture-archive-slow", "synthetic"); const pending = append(b, second).catch(() => null);
      try {
        await until(async () => {
          const audit = JSON.parse(await fs.readFile("/tmp/yt-dlp/archive-audit.json", "utf8")); assert(!audit.hasCredentialEnv && !audit.hasSourceEnv);
          return audit.pid !== previousPid && (await state(b)).entries[1].status === "archiving";
        }); await stop(); await pending; assert.equal(api.exitCode, 0);
        assert.deepEqual(await fs.readdir(`/tmp/downloads/${b.id}`), ["archive.zip"]); assert.deepEqual(await fs.readFile(`/tmp/downloads/${b.id}/archive.zip`), before);
      } finally { await fs.rm("/tmp/fixture-archive-slow"); }
      await start(); assert.equal((await request(path(b))).status, 404); assert.deepEqual(await fs.readdir("/tmp/downloads"), []); assert.deepEqual(await fs.readFile(source), original);
    });
    await test("Fictitious source stays unchanged and private diagnostics never enter logs", async () => { assert.deepEqual(await fs.readFile(source), original); for (const secret of [credential, source, original.toString().trim().split("\t").at(-1)]) assert(!logs.includes(secret)); });
  } finally { await stop(); }
  const metrics = {};
  for (const [name, location] of [["memoryPeakBytes", "/sys/fs/cgroup/memory.peak"], ["memoryEvents", "/sys/fs/cgroup/memory.events"], ["cpuMax", "/sys/fs/cgroup/cpu.max"]]) metrics[name] = await fs.readFile(location, "utf8").catch(() => "unavailable");
  console.log(JSON.stringify({ summary: { passed: results.filter(r => r.status === "pass").length, failed: results.filter(r => r.status === "fail").length, scope: "controlled Docker API; not browser or Render", metrics }, results }));
  process.exitCode = results.some(r => r.status === "fail") ? 1 : 0;
})();
