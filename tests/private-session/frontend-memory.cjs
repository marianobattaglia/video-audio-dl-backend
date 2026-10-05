"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { client } = require("/qualification/frontend.cjs");
module.exports = async test => {
  const source = await fs.readFile("/frontend/app.js", "utf8");
  await test("Frontend removes legacy session entry without reading or writing a credential", () => {
    const removed = [];
    const storage = { getItem() { throw new Error("Storage read forbidden"); }, setItem() { throw new Error("Storage write forbidden"); }, removeItem(key) { removed.push(key); } };
    const app = client(source, async () => {}, storage);
    assert.equal(app.elements.get("#access-credential").value, "");
    assert.deepEqual(removed, ["videoAudioDl.accessCredential"]);
    app.evaluate("setAccessMode(true)"); app.elements.get("#access-credential").value = "synthetic-memory-key";
    const reloaded = client(source, async () => {}, storage);
    assert.equal(reloaded.elements.get("#access-credential").value, "");
    app.windowEvents.pagehide(); assert.equal(app.elements.get("#access-credential").value, "");
  });
  await test("Frontend uses Authorization in protected mode, health omits it and open mode erases it", async () => {
    const requests = [];
    const app = client(source, async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, headers: { get() { return "application/json"; } }, async json() { return { status: "ok" }; } }; });
    app.evaluate("setAccessMode(true)"); app.elements.get("#access-credential").value = "synthetic-memory-key";
    await app.context.request("/api/jobs", { method: "POST", body: { kind: "video", url: "https://fixture.test/media.mp4" } });
    assert.equal(requests[0].options.headers.Authorization, "Bearer synthetic-memory-key"); assert(!requests[0].url.includes("synthetic-memory-key"));
    await app.context.request("/healthz", { health: true }); assert.equal(requests[1].options.headers.Authorization, undefined);
    app.evaluate("setAccessMode(false)"); assert.equal(app.elements.get("#access-credential").value, "");
    await app.context.request("/api/jobs"); assert.equal(requests[2].options.headers.Authorization, undefined);
  });
};
