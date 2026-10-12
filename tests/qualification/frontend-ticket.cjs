"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { client } = require("./frontend.cjs");
const id = "00000000-0000-4000-8000-000000000001";
function reply(data, status = 200) { return { ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => data }; }
function ticket(extra = {}) { return { downloadUrl: `/api/jobs/${id}/file?ticket=${"a".repeat(43)}`, expiresAt: Date.now() + 60000, filename: "Canción de prueba.mp3", ...extra }; }
module.exports = async test => {
  const source = await fs.readFile("/frontend/app.js", "utf8");
  await test("Ready link uses a validated ticket and native navigation without file buffering", async () => {
    const calls = [], app = client(source, async (url, options) => { calls.push({ url, options }); return reply(ticket()); });
    app.evaluate(`activeJobId='${id}'; setAccessMode(true);`);
    app.elements.get("#access-credential").value = "synthetic-only";
    await app.context.prepareFileLink("fallback.mp3");
    const link = app.elements.get("#file-link");
    assert.equal(link.hidden, false); assert(link.href.startsWith(`http://localhost:3000/api/jobs/${id}/file?ticket=`));
    assert.equal(link.download, "Canción de prueba.mp3"); assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "POST");
    let prevented = false; link.events.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, false); assert.equal(calls.length, 1); assert.equal(app.evaluate("fileDeliveryRequested"), true);
    assert(link.href); [...app.timers.values()].find(x => x.delay === 0).fn(); assert.equal(link.hidden, true); assert.equal(link.href, undefined);
  });
  await test("Expiring ticket refreshes and requires another explicit click", async () => {
    let calls = 0; const app = client(source, async () => { calls++; return reply(ticket()); });
    app.evaluate(`activeJobId='${id}';`); await app.context.prepareFileLink("fallback.mp3");
    app.evaluate("fileTicket.expiresAt=Date.now()+1000");
    let prevented = false; await app.elements.get("#file-link").events.click({ preventDefault() { prevented = true; } });
    assert(prevented); assert.equal(calls, 2); assert.equal(app.evaluate("fileDeliveryRequested"), false);
    assert.match(app.elements.get("#job-message").textContent, /Pulsá Descargar archivo nuevamente/);
  });
  await test("Untrusted ticket URLs and expired capabilities never become links", async () => {
    for (const extra of [
      { downloadUrl: `https://unrelated.example/api/jobs/${id}/file?ticket=${"a".repeat(43)}` },
      { downloadUrl: `/api/jobs/${id}/file?ticket=short` },
      { downloadUrl: `/api/jobs/${id}/file?ticket=${"a".repeat(43)}&extra=1` },
      { expiresAt: Date.now() - 1000 }
    ]) {
      const app = client(source, async () => reply(ticket(extra))); app.evaluate(`activeJobId='${id}';`);
      await app.context.prepareFileLink("fallback.mp3"); assert.equal(app.elements.get("#file-link").hidden, true); assert.equal(app.elements.get("#file-link").href, undefined);
    }
  });
  await test("Reset discards a late ticket response", async () => {
    let done; const app = client(source, () => new Promise(resolve => { done = resolve; }));
    app.evaluate(`activeJobId='${id}';`); const pending = app.context.prepareFileLink("fallback.mp3");
    app.elements.get("#reset-button").events.click(); done(reply(ticket())); await pending;
    assert.equal(app.elements.get("#file-link").hidden, true); assert.equal(app.elements.get("#file-link").href, undefined); assert.equal(app.evaluate("activeJobId"), null);
  });
  await test("Page departure discards late ticket and clears the credential", async () => {
    let done; const app = client(source, () => new Promise(resolve => { done = resolve; }));
    app.evaluate(`activeJobId='${id}';`); app.elements.get("#access-credential").value = "synthetic-only";
    const pending = app.context.prepareFileLink("fallback.mp3"); app.windowEvents.pagehide(); done(reply(ticket())); await pending;
    assert.equal(app.elements.get("#file-link").hidden, true); assert.equal(app.elements.get("#access-credential").value, "");
  });
  await test("Missing output while preparing the ticket shows an interruption", async () => {
    const app = client(source, async () => reply({ error: "El archivo temporal ya no está disponible." }, 410));
    app.evaluate(`activeJobId='${id}';`); await app.context.prepareFileLink("fallback.mp3");
    assert.equal(app.elements.get("#job-title").textContent, "El archivo ya no está disponible"); assert.equal(app.elements.get("#file-link").hidden, true);
  });
};
