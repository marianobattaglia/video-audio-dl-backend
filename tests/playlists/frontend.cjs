"use strict";
// Actual controller with a simulated DOM/clock/network. Browser evidence is separate.
const assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const source = fs.readFileSync(path.resolve(__dirname, "../../../video-audio-dl-frontend/public/playlist-controller.js"), "utf8");
class Element {
  constructor() { this.hidden = false; this.disabled = false; this.children = []; this.events = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  addEventListener(event, fn) { this.events[event] = fn; }
}
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture(deliveryMode = "manual") {
  const elements = new Map(), timers = new Map(), requests = [], jobs = new Map(), faults = new Map(); let sequence = 0, clock = 100000, b, nextError, health = true;
  const preview = { previewId: randomUUID(), title: "Lista <img src=x>", limits: { batchItems: null }, page: 1, pageToken: randomUUID(), previousPageToken: null, nextPageToken: null, entries: Array.from({ length: 7 }, (_, i) => ({ id: randomUUID(), position: i + 1, title: `<img src=x> ${i}`, duration: i ? 3 : null, available: i !== 6 })) };
  const pages = new Map([[preview.pageToken, preview]]);
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }; el("#playlist-panel").hidden = true;
  const saves = [], actions = []; let saveFault = null;
  if (deliveryMode !== "manual") preview.limits.deliveryModes = ["manual", "automatic", "zip"];
  el("#playlist-mode").value = deliveryMode;
  el("#playlist-mode").options = ["manual", "automatic", "zip"].map(value => ({ value, disabled: false }));
  const saver = { supported: () => true, authorized: false, choose() { actions.push("picker"); this.authorized = true; return Promise.resolve(); },
    async save(batchId, item, ticket) { saves.push(item.id); actions.push("write-close"); if (saveFault) throw new Error("Synthetic write failed"); return { jobId: item.jobId, deliveryId: ticket.deliveryId }; }, abort() {}, leave() { this.authorized = false; } };
  async function request(url, options = {}) {
    requests.push({ url, ...options });
    for (const [fragment, fn] of faults) if (url.includes(fragment)) { faults.delete(fragment); return fn(url, options); }
    if (nextError) { const fn = nextError; nextError = null; return fn(url, options); }
    if (url === "/api/playlists/preview") return structuredClone(options.body.pageToken ? pages.get(options.body.pageToken) : preview);
    if (url === "/api/playlist-batches") {
      b = { id: randomUUID(), title: preview.title, limits: { readyFiles: 2 }, kind: options.body.kind, deliveryMode: options.body.deliveryMode || "manual", archive: options.body.deliveryMode === "zip" ? { state: "building", included: 0 } : null, cancelled: false, state: "pending", readyCount: 0,
        entries: [...pages.values()].flatMap(p => p.entries).filter(e => options.body.entryIds.includes(e.id)).sort((a, b) => a.position - b.position).map(e => ({ ...e, status: "pending", jobId: null, message: "Pendiente" })) };
      return snapshot();
    }
    if (url.includes("/start")) {
      const row = b.entries.find(e => url.includes(e.id)); row.status = "running"; row.jobId = randomUUID(); row.attemptId = options.body.attemptId; jobs.set(row.jobId, row); return structuredClone(row);
    }
    if (url.endsWith("/transfer-ticket")) {
      const row = b.entries.find(e => url.includes(e.id)); return { deliveryId: randomUUID(), filename: "Canción ñ.mp3", downloadUrl: `/api/playlist-batches/${b.id}/items/${row.id}/file?ticket=${"T".repeat(43)}`, expiresAt: clock + 10000 };
    }
    if (url.endsWith("/save-confirmation")) { actions.push("ack"); const row = b.entries.find(e => url.includes(e.id)); row.status = "saved"; return structuredClone(row); }
    if (url.endsWith("/archive/append")) { const row = b.entries.find(e => e.id === options.body.entryId); row.status = "archived"; b.archive.included++; return snapshot(); }
    if (url.endsWith("/archive/finalize")) { b.archive.state = "ready"; b.archive.canDownload = true; return snapshot(); }
    if (url.endsWith("/archive/ticket")) return { downloadUrl: `/api/playlist-batches/${b.id}/archive/file?ticket=${"Z".repeat(43)}`, filename: "Lista.zip", expiresAt: clock + 10000 };
    if (url.endsWith("/ticket")) { const row = [...jobs.values()].find(e => url.includes(e.jobId)); return { downloadUrl: `/api/jobs/${row.jobId}/file?ticket=${"X".repeat(43)}`, expiresAt: clock + 10000, filename: "Canción ñ.mp3" }; }
    if (options.method === "DELETE") { if (url.includes("discard")) return {}; b.cancelled = true; b.entries.filter(e => ["pending", "running"].includes(e.status)).forEach(e => { e.status = "cancelled"; }); }
    return snapshot();
  }
  function snapshot() { b.readyCount = b.entries.filter(e => ["ready", "delivering"].includes(e.status)).length; b.pauseReason = b.readyCount >= 2 && b.entries.some(e => e.status === "pending") ? "ready_files" : null; return structuredClone(b); }
  const context = vm.createContext({ window: { createDirectorySaver: () => saver }, document: { querySelector: el, createElement: () => new Element() }, crypto: { randomUUID }, URL, Date: { now: () => clock },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(source, context);
  const controller = context.window.createPlaylistController({ request, readiness: async () => { actions.push("health"); return health; }, access: () => true, apiOrigin: "http://localhost:3000", getKind: () => "audio", notify() {}, abortRequests() {} });
  async function tick(delay = 1200) { const entry = [...timers].find(([, value]) => value.delay === delay); assert(entry, "Timer missing"); timers.delete(entry[0]); await entry[1].fn(); await settle(); }
  async function select(n = 5) { await controller.preview("https://music.youtube.com/playlist?list=PLtest"); for (let i = 0; i < n; i++) { const checkbox = el("#playlist-choices").children[i].children[0].children[0]; checkbox.checked = true; checkbox.events.change(); } }
  const start = async () => { await el("#playlist-start").events.click(); await settle(); };
  return { controller, el, requests, timers, select, start, tick, settle, saves, actions, saveFault: value => { saveFault = value; }, batch: () => b, rows: () => el("#playlist-results").children,
    addPage() { const last = [...pages.values()].at(-1), token = randomUUID(); last.nextPageToken = token; last.truncated = true;
      const page = { ...preview, page: last.page + 1, pageToken: token, previousPageToken: last.pageToken, nextPageToken: null, entries: Array.from({ length: 3 }, (_, i) => ({ id: randomUUID(), position: last.page * 50 + i + 1, title: `Page ${last.page + 1}: ${i}`, available: true })) }; pages.set(token, page); return page; },
    error: fn => { nextError = fn; }, fault: (fragment, fn) => faults.set(fragment, fn), clock: value => { clock = value; }, health: value => { health = value; },
    started: () => requests.filter(r => r.url.includes("/start")), tickets: () => requests.filter(r => r.url.endsWith("/ticket")) };
}
const results = [];
async function test(name, fn) { try { await fn(); results.push({ name, status: "pass" }); } catch (error) { results.push({ name, status: "fail", error: error.message }); } }
(async () => {
  await test("Text-only choices, unavailable row and more than five selections without thumbnails", async () => {
    const f = fixture(); await f.select(6); assert.equal(f.el("#playlist-count").textContent, "6 canciones seleccionadas");
    assert.equal(f.el("#playlist-choices").children[5].children[0].children[0].checked, true);
    assert(f.el("#playlist-choices").children[6].children[0].children[0].disabled);
    assert.equal(f.el("#playlist-choices").children[0].children[0].children[1].children[0].textContent, "1. <img src=x> 0");
    assert(!source.includes("innerHTML") && !source.includes("Blob") && !source.includes("localStorage"));
  });
  await test("Pagination retains selections/checkboxes; select page, back, forward and cross-page batch", async () => {
    const f = fixture(); f.addPage(); await f.select(6); await f.el("#playlist-next").events.click();
    assert.equal(f.el("#playlist-page").textContent, "Página 2"); await f.el("#playlist-select-page").events.click();
    assert.equal(f.el("#playlist-count").textContent, "9 canciones seleccionadas"); assert(f.el("#playlist-next").disabled);
    await f.el("#playlist-unselect-page").events.click(); assert.equal(f.el("#playlist-count").textContent, "6 canciones seleccionadas");
    await f.el("#playlist-select-page").events.click(); assert.equal(f.el("#playlist-count").textContent, "9 canciones seleccionadas");
    await f.el("#playlist-previous").events.click(); assert(f.el("#playlist-choices").children.slice(0, 6).every(li => li.children[0].children[0].checked));
    await f.start(); assert.equal(f.batch().entries.length, 9); assert.equal(f.batch().entries.at(-1).position, 53); assert.equal(f.started().length, 1);
  });
  await test("Failed/uncertain page preserves selection; manual retry uses same token without resetting source", async () => {
    const f = fixture(); const page = f.addPage(); await f.select(6);
    f.fault("/api/playlists/preview", async () => { throw Object.assign(new Error("Try later"), { status: 429, retryAfter: 1 }); });
    await f.el("#playlist-next").events.click(); assert.equal(f.el("#playlist-page").textContent, "Página 1"); assert.equal(f.el("#playlist-count").textContent, "6 canciones seleccionadas");
    f.clock(102000); await f.el("#playlist-continue").events.click(); assert.equal(f.el("#playlist-page").textContent, "Página 2");
    assert.equal(f.el("#playlist-count").textContent, "6 canciones seleccionadas");
    const requests = f.requests.filter(r => r.body?.pageToken); assert.equal(requests.length, 2); assert(requests.every(r => r.body.pageToken === page.pageToken)); assert.equal(f.started().length, 0);
  });
  await test("Page departure and discard ignore late page metadata and release UI busy state", async () => {
    for (const discard of [false, true]) {
      const f = fixture(), page = f.addPage(); await f.select(6); let release;
      f.fault("/api/playlists/preview", () => new Promise(resolve => { release = resolve; }));
      const request = f.el("#playlist-next").events.click(); await settle();
      if (discard) { await f.el("#playlist-discard").events.click(); assert(!f.controller.active); }
      else { f.controller.leave(); f.controller.restore(); assert(!f.controller.pending); }
      release(page); await request; assert.equal(f.el("#playlist-page").textContent, "Página 1");
      if (!discard) { assert.equal(f.el("#playlist-count").textContent, "6 canciones seleccionadas"); await f.el("#playlist-continue").events.click(); assert.equal(f.el("#playlist-page").textContent, "Página 2"); }
      assert.equal(f.started().length, 0);
    }
  });
  await test("Queue ordered, one preparation, two retained outputs pause and explicit continuation", async () => {
    const f = fixture(); await f.select(); await f.start(); assert.equal(f.started().length, 1);
    f.batch().entries[0].status = "ready"; await f.tick(); assert.equal(f.started().length, 2);
    f.batch().entries[1].status = "ready"; await f.tick(); assert.equal(f.started().length, 2); assert(!f.el("#playlist-continue").hidden);
    f.batch().entries[0].status = "delivered"; await f.tick(); assert.equal(f.started().length, 2);
    await f.el("#playlist-continue").events.click(); assert.equal(f.started().length, 3);
  });
  await test("Specific failure advances; general failure pauses until manually acknowledged", async () => {
    for (const general of [false, true]) {
      const f = fixture(); await f.select(); await f.start(); Object.assign(f.batch().entries[0], { status: "failed", message: "Safe failure", pauseOnFailure: general });
      await f.tick(); assert.equal(f.started().length, general ? 1 : 2);
      if (general) { await f.tick(); assert.equal(f.started().length, 1); await f.el("#playlist-continue").events.click(); assert.equal(f.started().length, 2); }
    }
  });
  await test("Unknown start result never replays; state check before manual continuation", async () => {
    const f = fixture(); await f.select();
    f.fault("/start", async () => { Object.assign(f.batch().entries[0], { status: "running", jobId: randomUUID() }); throw new Error("lost start response"); });
    await f.start(); assert.equal(f.started().length, 1); await f.tick(); await f.tick(); assert.equal(f.started().length, 1);
    await f.el("#playlist-continue").events.click(); assert.equal(f.started().length, 1);
    Object.assign(f.batch().entries[0], { status: "failed", pauseOnFailure: true, message: "Safe failure" }); await f.tick(); assert.equal(f.started().length, 1);
    await f.el("#playlist-continue").events.click(); assert.equal(f.started().length, 2);
  });
  await test("Native links: expired ticket renews on click, no auto delivery and double click prevented", async () => {
    const f = fixture(); await f.select(1); await f.start(); f.batch().entries[0].status = "ready"; await f.tick(); await f.settle();
    const link = f.rows()[0].children[3].children[0]; assert.equal(link.target, "_blank"); assert.equal(link.referrerPolicy, "no-referrer"); assert.equal(link.download, "Canción ñ.mp3");
    f.clock(109000); let prevented = 0; link.events.click({ preventDefault() { prevented++; } }); await f.settle(); assert.equal(prevented, 1); assert.equal(f.tickets().length, 2);
    link.events.click({ preventDefault() { prevented++; } }); link.events.click({ preventDefault() { prevented++; } }); assert.equal(prevented, 2);
    assert(!f.requests.some(r => r.url.includes("/file?"))); assert.equal(f.started().length, 1);
    f.clock(125000); await f.tick(); const retry = f.rows()[0].children[3].children[1]; assert(!retry.hidden); await retry.events.click(); await f.settle(); assert.equal(f.started().length, 1);
  });
  await test("Ticket failure has bounded retries; user requests a new link explicitly", async () => {
    const f = fixture(); await f.select(1); await f.start(); f.batch().entries[0].status = "ready";
    // GET consumes this interceptor and injects failure for the next ticket request.
    f.error(async () => { f.error(async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); }); return structuredClone(f.batch()); });
    await f.tick(); await f.settle(); assert.equal(f.tickets().length, 1); await f.tick(); assert.equal(f.tickets().length, 1);
    await f.rows()[0].children[3].children[1].events.click(); await f.settle(); assert.equal(f.tickets().length, 2);
  });
  await test("Older backend fallback never sends a playlist to individual endpoint", async () => {
    const f = fixture(); f.error(async () => { throw Object.assign(new Error("404"), { status: 404 }); }); await f.controller.preview("https://youtube.com/playlist?list=PLtest");
    assert.match(f.el("#playlist-message").textContent, /todavía no admite listas/); assert(!f.requests.some(r => r.url === "/api/jobs"));
    await f.el("#playlist-discard").events.click(); assert(!f.controller.active);
  });
  await test("Late preview ignored after reset/pagehide; backend lost can be discarded", async () => {
    const f = fixture(); let release; f.error(() => new Promise(resolve => { release = resolve; }));
    const preview = f.controller.preview("https://youtube.com/playlist?list=PLtest"); await f.el("#playlist-discard").events.click(); release({ entries: [], limits: { batchItems: null } }); await preview; assert(!f.controller.active);
    await f.select(); await f.start(); f.controller.leave(); const count = f.started().length; assert(!f.timers.size); f.controller.restore();
    assert(!f.el("#playlist-continue").hidden); assert.equal(f.started().length, count);
    f.error(async () => { throw Object.assign(new Error("lost"), { status: 404 }); }); await f.el("#playlist-continue").events.click();
    f.error(async () => { throw Object.assign(new Error("lost"), { status: 404 }); }); await f.el("#playlist-discard").events.click(); assert(!f.controller.active);
  });
  await test("Automatic picker precedes health and media; sequential write-close/ACK gates next preparation", async () => {
    const f = fixture("automatic"); await f.select(3); await f.start(); assert.deepEqual(f.actions.slice(0, 2), ["picker", "health"]);
    f.batch().entries[0].status = "ready"; await f.tick(); assert.equal(f.saves.length, 1); assert.equal(f.started().length, 1);
    assert.deepEqual(f.actions.slice(-2), ["write-close", "ack"]); assert.equal(f.batch().entries[0].status, "saved");
    assert.equal(f.tickets().length, 0); await f.tick(); assert.equal(f.started().length, 2);
  });
  await test("Lost save ACK reconciles same receipt without saving twice; local write failure pauses", async () => {
    const f = fixture("automatic"); await f.select(3); await f.start(); f.batch().entries[0].status = "ready";
    f.fault("/save-confirmation", async () => { throw new Error("uncertain ack"); }); await f.tick(); assert.equal(f.saves.length, 1); assert.equal(f.started().length, 1);
    assert(!f.el("#playlist-continue").hidden); await f.el("#playlist-continue").events.click(); assert.equal(f.saves.length, 1); assert.equal(f.batch().entries[0].status, "saved");
    await f.tick(); assert.equal(f.started().length, 2); f.batch().entries[1].status = "ready"; f.saveFault(true); await f.tick();
    assert(!f.el("#playlist-continue").hidden); assert.equal(f.started().length, 2); assert.equal(f.batch().entries[1].status, "ready");
  });
  await test("Known pre-creation admission waits at most twice with one timer; uncertain/source errors never retry", async () => {
    const f = fixture("zip"); await f.select(3);
    const rejection = async () => { throw Object.assign(new Error("admission"), { status: 429, code: "E_MEDIA_ADMISSION_RATE", retryAfter: 1 }); };
    f.fault("/start", rejection); await f.start(); assert.equal(f.timers.size, 1);
    f.fault("/start", rejection); f.clock(101000); await f.tick(1000); assert.equal(f.timers.size, 1);
    f.fault("/start", rejection); f.clock(102000); await f.tick(1000);
    assert.equal(f.started().length, 3); assert(!f.el("#playlist-continue").hidden);
    f.clock(104000); await f.tick(); assert.equal(f.started().length, 3);
    const g = fixture("zip"); await g.select(3); g.fault("/start", async () => { throw Object.assign(new Error("source/unknown"), { status: 429, retryAfter: 1 }); }); await g.start();
    g.clock(102000); await g.tick(); assert.equal(g.started().length, 1);
  });
  await test("ZIP progresses only after append; lost committed response reconciles; final link stays native", async () => {
    const f = fixture("zip"); await f.select(2); await f.start(); f.batch().entries[0].status = "ready";
    f.fault("/archive/append", async () => { f.batch().entries[0].status = "archived"; f.batch().archive.included = 1; throw new Error("lost committed response"); });
    await f.tick(); assert.equal(f.started().length, 1); await f.el("#playlist-continue").events.click(); assert.equal(f.started().length, 2);
    f.batch().entries[1].status = "ready"; await f.tick(); await f.tick(); await f.settle();
    assert.equal(f.requests.filter(r => r.url.includes("/archive/append")).length, 2);
    assert.equal(f.batch().archive.state, "ready"); assert(!f.el("#playlist-archive-link").hidden);
    assert(!f.requests.some(r => r.url.includes("/file?"))); assert.equal(f.saves.length, 0);
    let blocked = 0; const link = f.el("#playlist-archive-link"); link.events.click({ preventDefault() { blocked++; } }); link.events.click({ preventDefault() { blocked++; } }); assert.equal(blocked, 1);
  });
  await test("Pause/pagehide cancel admission timer and never advance; older playlist backend sends no mode", async () => {
    const f = fixture("zip"); await f.select(3); f.fault("/start", async () => { throw Object.assign(new Error("admission"), { code: "E_MEDIA_ADMISSION_RATE", retryAfter: 2 }); }); await f.start();
    f.el("#playlist-pause").events.click(); assert.equal(f.timers.size, 0); const count = f.started().length;
    f.controller.leave(); assert.equal(f.timers.size, 0); f.controller.restore(); assert.equal(f.started().length, count);
    const g = fixture(); await g.select(1); await g.start(); const body = g.requests.find(r => r.url === "/api/playlist-batches").body; assert(!("deliveryMode" in body));
  });
  await test("Cancel remains available during initial start; late reply cannot lock a subsequent batch", async () => {
    const f = fixture("zip"); await f.select(2); let release;
    f.fault("/start", () => new Promise(resolve => { release = resolve; }));
    const starting = f.start(); await settle(); assert(!f.el("#playlist-cancel").disabled);
    await f.el("#playlist-cancel").events.click(); assert(f.batch().cancelled);
    release({}); await starting; await f.el("#playlist-discard").events.click();
    await f.select(2); await f.start(); assert.equal(f.started().length, 2); assert.equal(f.batch().entries[0].status, "running");
  });
  console.log(JSON.stringify({ summary: { passed: results.filter(r => r.status === "pass").length, failed: results.filter(r => r.status === "fail").length, scope: "Actual playlist controller, simulated DOM/network/clock; not browser or Render" }, results }, null, 2));
  process.exitCode = results.some(r => r.status === "fail") ? 1 : 0;
})();
