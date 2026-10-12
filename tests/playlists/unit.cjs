"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { classify } = require("../../playlist-links");
const { PlaylistStore, normalizeMetadata } = require("../../playlist-store");
const tests = [];
async function test(name, fn) { try { await fn(); tests.push({ name, status: "pass" }); } catch (error) { tests.push({ name, status: "fail", error: error.message }); } }
const raw = (count = 5) => ({ _type: "playlist", title: "Lista ficticia", entries: Array.from({ length: count }, (_, i) => ({ id: String(i).padStart(11, "a"), title: `Tema ${i}`, duration: 12 })) });
function fixture() {
  const jobs = new Map(); let now = 1000, launches = 0, gate;
  const store = new PlaylistStore({ jobs, now: () => now, jobTtl: 1000,
    startJob: async kind => { launches++; if (gate) await gate; const job = { id: randomUUID(), kind, status: "running", createdAt: now, message: "Procesando", progress: 0 }; jobs.set(job.id, job); return job; },
    cancelJob: async job => { if (!job.deliveryInProgress) job.status = "cancelled"; } });
  const preview = store.addPreview(normalizeMetadata(raw(), "music.youtube.com"));
  const create = ids => store.create({ previewId: preview.previewId, entryIds: ids || preview.entries.map(e => e.id), kind: "audio" });
  return { store, jobs, preview, create, launches: () => launches, clock: value => { now = value; }, now: () => now, gate: value => { gate = value; } };
}
(async () => {
  await test("Frontend and backend classify the same independent URL fixtures", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../../video-audio-dl-frontend/public/playlist-links.js"), "utf8");
    const context = { window: {}, URL }; vm.runInNewContext(source, context);
    const inputs = [
      ["https://music.youtube.com/playlist?list=PLtest&si=tracking", "playlist"],
      ["https://www.youtube.com/playlist?list=PLtest", "playlist"],
      ["https://music.youtube.com/watch?v=abcdefghijk&list=PLtest&si=tracking", "individual"],
      ["https://youtu.be/abcdefghijk?si=tracking", "individual"],
      ["https://youtube.com/shorts/abcdefghijk", "individual"],
      ["http://youtube.com/playlist?list=PLtest", "unsupported"],
      ["https://youtube.com/playlist?list=RDtest", "unsupported"],
      ["https://youtube.com/@channel/videos", "unsupported"],
      ["https://youtube.com.evil.example/playlist?list=PLtest", "individual"],
      ["https://youtube.com@evil.example/playlist?list=PLtest", "invalid"],
      ["data:text/plain,x", "invalid"], ["not a url", "invalid"]
    ];
    for (const [url, type] of inputs) { assert.equal(classify(url).type, type); assert.equal(JSON.stringify(classify(url)), JSON.stringify(context.window.MediaLinks.classify(url))); }
    assert.equal(classify(inputs[2][0]).url, "https://music.youtube.com/watch?v=abcdefghijk");
  });
  await test("Preview allowlist, truncation, missing data and canonical music host", () => {
    const source = raw(51); source.headers = { Cookie: "synthetic-secret" }; source.entries[0].url = "http://127.0.0.1/";
    source.entries[1] = { id: "bad", title: null }; source.entries[2].availability = "private";
    const result = normalizeMetadata(source, "music.youtube.com");
    assert.equal(result.entries.length, 50); assert.equal(result.truncated, true);
    assert.equal(result.entries[0].url, "https://music.youtube.com/watch?v=aaaaaaaaaa0");
    assert.equal(result.entries[1].available, false); assert.equal(result.entries[2].available, false);
    assert(!JSON.stringify(result).includes("synthetic-secret"));
  });
  await test("Selection rejects empty, foreign, duplicate and unsupported fields", () => {
    const f = fixture(); const good = { previewId: f.preview.previewId, entryIds: [f.preview.entries[0].id], kind: "audio" };
    for (const bad of [{ ...good, entryIds: [] }, { ...good, entryIds: Array(6).fill(good.entryIds[0]) }, { ...good, entryIds: [randomUUID()] }, { ...good, entryIds: [good.entryIds[0], good.entryIds[0]] }, { ...good, url: "https://evil.example" }, { ...good, kind: "other" }]) assert.throws(() => f.store.create(bad));
  });
  await test("No fixed selected-song cap; multiple pages preserve identities and absolute order", () => {
    const f = fixture(), source = raw(51);
    const p = f.store.addPreview(normalizeMetadata(source, "music.youtube.com"), { url: "https://music.youtube.com/playlist?list=PLpages", host: "music.youtube.com" });
    assert.equal(p.limits.batchItems, null); assert.equal(p.entries.length, 50); assert(p.nextPageToken);
    const nav = f.store.pageRequest({ previewId: p.previewId, pageToken: p.nextPageToken }); assert.equal(nav.start, 51); assert.equal(nav.cached, false);
    const last = f.store.savePage(nav.preview, nav.token, normalizeMetadata(raw(7), "music.youtube.com", nav.start));
    assert.equal(last.page, 2); assert.equal(last.entries[0].position, 51); assert.equal(last.nextPageToken, null); assert.equal(last.previousPageToken, p.pageToken);
    const cached = f.store.pageRequest({ previewId: p.previewId, pageToken: p.pageToken }); assert(cached.cached); assert.deepEqual(f.store.publicPage(cached.preview, cached.token).entries, p.entries);
    const again = f.store.savePage(nav.preview, nav.token, normalizeMetadata(raw(7), "music.youtube.com", 51)); assert.deepEqual(again.entries, last.entries);
    const b = f.store.create({ previewId: p.previewId, kind: "audio", entryIds: [...last.entries, ...p.entries].map(e => e.id) });
    assert.equal(b.entries.length, 57); assert.equal(b.entries[56].position, 57); assert.equal(f.launches(), 0);
  });
  await test("Page tokens reject foreign/expired/arbitrary ranges; unknown source size ends on lookahead", () => {
    const f = fixture(), p = f.store.addPreview(normalizeMetadata(raw(51), "youtube.com"));
    assert.throws(() => f.store.pageRequest({ previewId: f.preview.previewId, pageToken: p.nextPageToken }));
    assert.throws(() => f.store.pageRequest({ previewId: p.previewId, pageToken: randomUUID() }));
    assert.throws(() => f.store.pageRequest({ previewId: p.previewId, pageToken: p.nextPageToken, start: 500 }));
    const misleading = raw(2); misleading.playlist_count = 999;
    assert.equal(normalizeMetadata(misleading, "youtube.com", 101).truncated, false);
    f.clock(601001); assert.throws(() => f.store.pageRequest({ previewId: p.previewId, pageToken: p.nextPageToken }), /venció/);
  });
  await test("Metadata byte budget rejects additions atomically and preserves existing pages", () => {
    const f = fixture(), p = f.store.addPreview(normalizeMetadata(raw(51), "youtube.com")), before = f.store.metadataBytes();
    f.store.maxMetadataBytes = before + 50;
    const nav = f.store.pageRequest({ previewId: p.previewId, pageToken: p.nextPageToken });
    assert.throws(() => f.store.savePage(nav.preview, nav.token, normalizeMetadata(raw(51), "youtube.com", 51)), /memoria/);
    assert.equal(nav.preview.pages.size, 1); assert.equal(nav.preview.entries.length, 50);
    assert.throws(() => f.store.create({ previewId: p.previewId, entryIds: p.entries.map(e => e.id), kind: "audio" }), /memoria/); assert.equal(f.store.batches.size, 0);
  });
  await test("Snapshot expires and selected positions keep source order", () => {
    const f = fixture(); const batch = f.create([f.preview.entries[4].id, f.preview.entries[0].id]);
    assert.deepEqual(batch.entries.map(row => row.position), [1, 5]);
    f.clock(601001); assert.throws(() => f.create(), /venció/);
  });
  await test("Duplicate video positions retain different entry identities", () => {
    const f = fixture(), source = raw(2); source.entries[1].id = source.entries[0].id;
    const p = f.store.addPreview(normalizeMetadata(source, "youtube.com"));
    const b = f.store.create({ previewId: p.previewId, entryIds: p.entries.map(e => e.id), kind: "video" });
    assert.equal(b.entries[0].videoId, b.entries[1].videoId); assert.notEqual(b.entries[0].id, b.entries[1].id);
  });
  await test("Concurrent repeats reuse a single preparation attempt", async () => {
    const f = fixture(), b = f.create(), id = b.entries[0].id, attemptId = randomUUID(); let release;
    f.gate(new Promise(resolve => { release = resolve; }));
    const a = f.store.start(b.id, id, { attemptId }, () => {}), c = f.store.start(b.id, id, { attemptId }, () => {});
    assert.equal(f.launches(), 1); await assert.rejects(f.store.start(b.id, b.entries[1].id, { attemptId: randomUUID() }, () => {}), /activo/);
    release(); assert.equal((await a).jobId, (await c).jobId); assert.equal(f.launches(), 1);
    const job = [...f.jobs.values()][0];
    await assert.rejects(f.store.start(b.id, id, { attemptId: randomUUID() }, () => {}), error => error.status === 429);
    Object.assign(job, { status: "complete", completedAt: 1000 });
    await assert.rejects(f.store.start(b.id, id, { attemptId: randomUUID() }, () => {}), error => error.status === 409);
    assert.equal(f.launches(), 1);
  });
  await test("Two retained outputs pause new work until delivery completes", async () => {
    const f = fixture(), b = f.create();
    for (const row of b.entries.slice(0, 2)) { const started = await f.store.start(b.id, row.id, { attemptId: randomUUID() }, () => {}); Object.assign(f.jobs.get(started.jobId), { status: "complete", completedAt: 1000 }); }
    await assert.rejects(f.store.start(b.id, b.entries[2].id, { attemptId: randomUUID() }, () => {}), /Guardá/);
    const first = [...f.jobs.values()][0]; first.deliveryInProgress = true; first.delivered = true;
    assert.equal(f.store.publicBatch(f.store.get(b.id)).readyCount, 2);
    first.deliveryInProgress = false; first.status = "delivered";
    await f.store.start(b.id, b.entries[2].id, { attemptId: randomUUID() }, () => {}); assert.equal(f.launches(), 3);
  });
  await test("Only explicit new attempts retry failures and expired files", async () => {
    const f = fixture(), b = f.create(), row = b.entries[0]; const old = randomUUID();
    const one = await f.store.start(b.id, row.id, { attemptId: old }, () => {});
    Object.assign(f.jobs.get(one.jobId), { status: "failed", failureReason: "source_unavailable" });
    await f.store.start(b.id, row.id, { attemptId: old }, () => {}); assert.equal(f.launches(), 1);
    const two = await f.store.start(b.id, row.id, { attemptId: randomUUID() }, () => {}); assert.equal(f.launches(), 2);
    Object.assign(f.jobs.get(two.jobId), { status: "complete", completedAt: 1000 }); f.clock(2001);
    assert.equal(f.store.publicBatch(f.store.get(b.id)).entries[0].status, "expired");
    await f.store.start(b.id, row.id, { attemptId: randomUUID() }, () => {}); assert.equal(f.launches(), 3);
  });
  await test("Cancellation during a starting request cancels the resulting job", async () => {
    const f = fixture(), b = f.create(); let release; f.gate(new Promise(resolve => { release = resolve; }));
    const start = f.store.start(b.id, b.entries[0].id, { attemptId: randomUUID() }, () => {});
    const cancel = f.store.cancel(b.id); release(); await start; const ended = await cancel;
    assert(ended.entries.every(row => row.status === "cancelled"));
  });
  await test("Cancel preserves ready outputs; discard preserves an open delivery", async () => {
    const f = fixture(), b = f.create(); const s = await f.store.start(b.id, b.entries[0].id, { attemptId: randomUUID() }, () => {});
    Object.assign(f.jobs.get(s.jobId), { status: "complete", completedAt: 1000 });
    assert.equal((await f.store.cancel(b.id)).entries[0].status, "ready");
    f.jobs.get(s.jobId).deliveryInProgress = true;
    await f.store.cancel(b.id, true); assert.equal(f.jobs.get(s.jobId).status, "complete");
    f.jobs.get(s.jobId).status = "delivered"; f.jobs.get(s.jobId).deliveryInProgress = false; f.store.sweep(); assert.equal(f.store.batches.size, 0);
  });
  await test("Live work survives record TTL; idle records and snapshots are bounded", async () => {
    const f = fixture(), b = f.create(); await f.store.start(b.id, b.entries[0].id, { attemptId: randomUUID() }, () => {});
    f.clock(1000001); f.store.sweep(); assert.equal(f.store.batches.size, 1);
    [...f.jobs.values()][0].status = "failed"; f.store.sweep(); assert.equal(f.store.batches.size, 0);
    for (let i = 0; i < 20; i++) f.store.addPreview(normalizeMetadata(raw(1), "youtube.com"));
    assert.throws(() => f.store.addPreview(normalizeMetadata(raw(1), "youtube.com")), /demasiadas/);
  });
  await test("Public state never exposes canonical URLs or idempotency maps", () => {
    const f = fixture(), b = f.create(); const serialized = JSON.stringify(b);
    assert(!serialized.includes("https://")); assert(!serialized.includes("attempts")); assert(!serialized.includes("cookies"));
  });
  await test("Delivery modes are advertised, optional manual default, immutable and reject unknown/private input", async () => {
    const f = fixture(), body = { previewId: f.preview.previewId, entryIds: [f.preview.entries[0].id], kind: "audio" };
    assert.deepEqual(f.preview.limits.deliveryModes, ["manual", "automatic", "zip"]);
    assert.equal(f.store.create(body).deliveryMode, "manual");
    for (const deliveryMode of ["manual", "automatic", "zip"]) assert.equal(f.store.create({ ...body, deliveryMode }).deliveryMode, deliveryMode);
    for (const deliveryMode of [null, "other", "", {}, 1]) assert.throws(() => f.store.create({ ...body, deliveryMode }));
    for (const field of ["folder", "cookies", "path", "title", "flags"]) assert.throws(() => f.store.create({ ...body, [field]: "fictitious" }));
    const b = f.store.create({ ...body, deliveryMode: "automatic" });
    await assert.rejects(f.store.start(b.id, b.entries[0].id, { attemptId: randomUUID(), deliveryMode: "zip" }, () => {}));
    assert.equal(f.launches(), 0);
  });
  await test("Consumed receipts survive job sweep, bind exact ACK and forbid preparing another copy", async () => {
    const { automaticDelivery } = require("../../automatic-delivery");
    const f = fixture(), b = f.store.create({ previewId: f.preview.previewId, entryIds: f.preview.entries.slice(0, 2).map(e => e.id), kind: "audio", deliveryMode: "automatic" });
    const started = await f.store.start(b.id, b.entries[0].id, { attemptId: randomUUID() }, () => {}), row = f.store.get(b.id).rows[0];
    const job = f.jobs.get(started.jobId); Object.assign(job, { status: "complete", completedAt: 1000, outputPath: "synthetic", filename: "Ficticio.mp3" });
    await assert.rejects(f.store.start(b.id, b.entries[1].id, { attemptId: randomUUID() }, () => {}), /Confirmá/);
    const deliveryId = randomUUID(); row.delivery = { id: deliveryId, jobId: job.id, attemptId: row.attemptId, transferred: true };
    let removed = 0;
    const auto = automaticDelivery({ store: f.store, tickets: new Map(), remove: async () => { removed++; }, jobTtl: 1000, now: f.now });
    const body = { jobId: job.id, deliveryId };
    await assert.rejects(auto.confirm(b.id, row.id, { ...body, deliveryId: randomUUID() }));
    assert.equal((await auto.confirm(b.id, row.id, body)).status, "saved");
    f.jobs.delete(job.id); f.clock(3000);
    assert.equal((await auto.confirm(b.id, row.id, body)).status, "saved"); assert.equal(removed, 1);
    await assert.rejects(f.store.start(b.id, row.id, { attemptId: randomUUID() }, () => {}), /entregado/);
    assert.equal(f.store.publicBatch(f.store.get(b.id)).readyCount, 0);
  });
  await test("Automatic expiry and foreign confirmations never delete another output or extend retention", async () => {
    const { automaticDelivery } = require("../../automatic-delivery");
    const f = fixture(), b = f.store.create({ previewId: f.preview.previewId, entryIds: f.preview.entries.slice(0, 2).map(e => e.id), kind: "audio", deliveryMode: "automatic" });
    const started = await f.store.start(b.id, b.entries[0].id, { attemptId: randomUUID() }, () => {}), row = f.store.get(b.id).rows[0], job = f.jobs.get(started.jobId);
    Object.assign(job, { status: "complete", completedAt: 1000, outputPath: "synthetic" }); const deliveryId = randomUUID(); row.delivery = { id: deliveryId, jobId: job.id, attemptId: row.attemptId, transferred: true };
    let removed = 0; const auto = automaticDelivery({ store: f.store, tickets: new Map(), remove: async () => { removed++; }, jobTtl: 1000, now: f.now });
    const body = { jobId: job.id, deliveryId };
    await assert.rejects(auto.confirm(b.id, b.entries[1].id, body), error => error.status === 409);
    await assert.rejects(auto.confirm(b.id, row.id, { ...body, cookies: "synthetic" }), error => error.status === 400);
    f.clock(2001); await assert.rejects(auto.confirm(b.id, row.id, body), error => error.status === 410);
    await assert.rejects(auto.ticket(b.id, row.id, { jobId: job.id }), error => error.status === 410);
    assert.equal(removed, 0); assert.equal(job.completedAt, 1000); assert.equal(f.store.readyCount(f.store.get(b.id)), 0);
  });
  await test("ZIP total deadline includes pauses; recovery TTL and consumed row identity do not renew on polling", () => {
    const { playlistArchive } = require("../../playlist-archive");
    const f = fixture(), b = f.store.create({ previewId: f.preview.previewId, entryIds: [f.preview.entries[0].id], kind: "video", deliveryMode: "zip" });
    let now = 0;
    playlistArchive({ store: f.store, root: "/synthetic-root", jobTtl: 1000, totalMs: 100, now: () => now });
    const internal = f.store.get(b.id); f.store.afterStart(internal);
    const deadline = internal.archive.deadline; assert.equal(deadline, 100);
    internal.rows[0].receipt = { status: "archived", jobId: "fictitious", filename: "0001.mp4" };
    now = 101; const first = f.store.publicBatch(internal); assert.equal(first.archive.state, "paused"); assert(first.cancelled); assert.equal(first.archive.expiresAt, 1101);
    now = 500; assert.equal(f.store.publicBatch(internal).archive.expiresAt, 1101); assert.equal(internal.archive.deadline, deadline); assert.equal(f.store.rowState(internal.rows[0]), "archived");
    assert.throws(() => f.store.beforeStart(internal));
    now = 1102; assert.equal(f.store.publicBatch(internal).archive.state, "expired"); assert.equal(f.store.rowState(internal.rows[0]), "archived");
  });
  await test("ZIP filenames retain readable Unicode and reject path characters and Windows reserved names", () => {
    const { archiveFilename } = require("../../playlist-archive");
    assert.equal(archiveFilename("Música ñ", false), "Música ñ.zip");
    assert.equal(archiveFilename("CON", true), "Lista - CON - parcial.zip");
    assert(!/[\\/:*?<>|]/.test(archiveFilename("../ruta\\archivo:*", false)));
  });
  await test("Explicit ZIP retry can reactivate a recoverable partial; rejected admission never renews it", async () => {
    const { playlistArchive } = require("../../playlist-archive");
    const f = fixture(), b = f.store.create({ previewId: f.preview.previewId, entryIds: [f.preview.entries[0].id], kind: "audio", deliveryMode: "zip" });
    playlistArchive({ store: f.store, root: "/synthetic-root", jobTtl: 1000, totalMs: 5000, now: f.now });
    const internal = f.store.get(b.id); f.store.afterStart(internal);
    Object.assign(internal.archive, { state: "paused", expiresAt: 2000 }); const deadline = internal.archive.deadline;
    await assert.rejects(f.store.start(b.id, b.entries[0].id, { attemptId: randomUUID() }, () => { throw Object.assign(new Error("synthetic quota"), { code: "E_MEDIA_ADMISSION_RATE" }); }));
    assert.equal(internal.archive.expiresAt, 2000); assert.equal(internal.archive.state, "paused");
    await f.store.start(b.id, b.entries[0].id, { attemptId: randomUUID() }, () => {});
    assert.equal(internal.archive.state, "building"); assert.equal(internal.archive.expiresAt, null); assert.equal(internal.archive.deadline, deadline);
  });
  console.log(JSON.stringify({ summary: { passed: tests.filter(t => t.status === "pass").length, failed: tests.filter(t => t.status === "fail").length }, results: tests }, null, 2));
  process.exitCode = tests.some(t => t.status === "fail") ? 1 : 0;
})();
