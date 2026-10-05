"use strict";
// Executes the actual client with a simulated DOM/fetch. This is not a browser E2E test.
const fs = require("node:fs/promises");
const vm = require("node:vm");
const assert = require("node:assert/strict");
function element() {
  return { hidden: true, disabled: false, open: false, value: "", textContent: "", style: {}, events: {}, classList: { add() {}, remove() {} },
    addEventListener(name, fn) { this.events[name] = fn; }, querySelector() { return this.label || (this.label = element()); }, querySelectorAll() { return []; },
    removeAttribute(name) { delete this[name]; }, setAttribute(name, value) { this[name] = value; }, showModal() { this.open = true; }, close() { this.open = false; }, focus() {} };
}
function client(source, fetch, sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} }) {
  const elements = new Map(), timers = new Map(); let sequence = 0;
  const windowEvents = {};
  const document = { querySelector(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, body: { append() {} } };
  const context = vm.createContext({ document, window: { APP_CONFIG: { apiBaseUrl: "http://localhost:3000" }, addEventListener(name, action) { windowEvents[name] = action; } }, sessionStorage, URL, AbortController, console, fetch,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(source, context);
  return { context, elements, timers, windowEvents, evaluate: code => vm.runInContext(code, context) };
}
function response(status, body, type = "application/json") { return { ok: status < 400, status, headers: { get() { return type; } }, async json() { return body; } }; }
module.exports = async test => {
  const source = await fs.readFile("/frontend/app.js", "utf8");
  await test("Client reports a lost job after restart and permits retry (simulated DOM)", async () => {
    const app = client(source, async () => response(404, { error: "Esa descarga ya no está disponible. Envía el enlace otra vez." }));
    app.evaluate("activeJobId='lost'; busy=true;");
    await app.context.pollJob();
    assert.equal(app.elements.get("#job-title").textContent, "La descarga se interrumpió");
    assert.equal(app.elements.get("#submit-button").disabled, false);
    assert.equal(app.elements.get("#file-link").hidden, true);
    assert.equal(app.evaluate("activeJobId"), null);
  });
  await test("Client distinguishes a lost output file (simulated DOM)", async () => {
    const app = client(source, async () => response(410, { error: "El archivo temporal ya no está disponible." }));
    app.evaluate("activeJobId='lost-file';");
    await app.elements.get("#file-link").events.click({ preventDefault() {} });
    assert.equal(app.elements.get("#job-title").textContent, "El archivo ya no está disponible");
    assert.equal(app.elements.get("#file-link").hidden, true);
  });
  await test("Wake request is shared and requires manual retry after waiting (simulated DOM)", async () => {
    let resolve, calls = 0;
    const app = client(source, (url, options) => {
      calls++; assert(url.endsWith("/healthz")); assert.equal(options.headers.Authorization, undefined);
      return new Promise(done => { resolve = done; });
    });
    const first = app.context.checkReadiness(), second = app.context.checkReadiness();
    assert.equal(first, second); assert.equal(calls, 1);
    const waiting = [...app.timers.values()].find(timer => timer.delay === 1000); waiting.fn();
    assert.equal(app.elements.get("#connection-title").textContent, "Preparando el servicio");
    resolve(response(200, { status: "ok", authRequired: false }));
    assert.equal(await first, false);
    assert.equal(app.elements.get("#connection-title").textContent, "El servicio está listo");
    assert.equal(app.elements.get("#submit-button").disabled, false); assert.equal(calls, 1);
  });
  await test("Wake timeout ends the waiting state without creating jobs (simulated DOM)", async () => {
    const app = client(source, (url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const attempt = app.context.checkReadiness();
    [...app.timers.values()].find(timer => timer.delay === 120000).fn();
    assert.equal(await attempt, false);
    assert.equal(app.elements.get("#connection-title").textContent, "No pudimos conectar");
    assert.equal(app.elements.get("#submit-button").disabled, false);
    assert.equal(app.timers.size, 0);
  });
  await test("Wake rejects provider HTML and preserves the URL (simulated DOM)", async () => {
    const app = client(source, async () => response(200, {}, "text/html"));
    app.elements.get("#media-url").value = "http://fixture.test/media.mp4";
    assert.equal(await app.context.checkReadiness(), false);
    assert.equal(app.elements.get("#media-url").value, "http://fixture.test/media.mp4");
    assert.equal(app.elements.get("#connection-title").textContent, "No pudimos conectar");
  });
};
module.exports.client = client;
