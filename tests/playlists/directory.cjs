"use strict";
// Actual saver, simulated File System Access/streams. Not a browser permission test.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const source = fs.readFileSync(path.resolve(__dirname, "../../../video-audio-dl-frontend/public/directory-saver.js"), "utf8");
const results = [];
async function test(name, fn) { try { await fn(); results.push({ name, status: "pass" }); } catch (error) { results.push({ name, status: "fail", error: error.message }); } }
function fixture({ denied = false, rejectPicker = false, writeFails = false, truncated = false, secure = true, stalled = false } = {}) {
  const contents = new Map([["original.txt", Buffer.from("pre-existing")]]), events = [], calls = [], timers = new Map(); let sequence = 0;
  const missing = () => Object.assign(new Error("synthetic-not-found"), { name: "NotFoundError" });
  function directory(prefix = "") {
    return { queryPermission: async () => denied ? "denied" : "granted",
      async getDirectoryHandle(name, options = {}) {
        const key = prefix + name + "/";
        if (!contents.has(key)) { if (!options.create) throw missing(); contents.set(key, null); }
        return directory(key);
      }, async getFileHandle(name, options = {}) {
        const key = prefix + name;
        if (!contents.has(key)) { if (!options.create) throw missing(); contents.set(key, Buffer.alloc(0)); }
        return { async createWritable() { return { async write(chunk) { events.push("write"); if (writeFails) throw new Error("synthetic-write-error"); contents.set(key, Buffer.concat([contents.get(key), Buffer.from(chunk)])); }, async close() { events.push("close"); }, async abort() { events.push("abort"); } }; } };
      }, async removeEntry(name) { events.push("remove"); contents.delete(prefix + name); } };
  }
  const root = directory(), window = { isSecureContext: secure, showDirectoryPicker: async () => { if (rejectPicker) throw new Error("denied"); return root; } };
  const context = vm.createContext({ window, crypto: { randomUUID: () => `synthetic-${++sequence}` }, ReadableStream, AbortController,
    fetch: async (url, options) => { calls.push({ url, options }); const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([73, 68, 51, 0])); if (stalled) return; if (!truncated) controller.enqueue(new Uint8Array([0, 0, 0, 0])); controller.close(); } }); return new Response(body, { headers: { "Content-Type": "audio/mpeg", "Content-Length": "8" } }); },
    setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context); const saver = window.createDirectorySaver();
  const save = () => saver.save("synthetic-batch", { position: 1, jobId: "synthetic-job" }, { filename: "Canción ñ.mp3", deliveryId: "synthetic-delivery" }, "https://api.ficticia.example/transfer");
  return { saver, save, contents, calls, events, timers };
}
(async () => {
  await test("Streaming closes before returning bound receipt, keeps Unicode names and existing files", async () => {
    const f = fixture(); await f.saver.choose(); const receipt = await f.save(); assert.equal(receipt.deliveryId, "synthetic-delivery");
    assert.deepEqual(f.events, ["write", "write", "close"]); assert.equal(f.contents.get("original.txt").toString(), "pre-existing");
    assert([...f.contents.keys()].some(key => key.includes("Canción ñ"))); assert.equal(f.timers.size, 0);
    assert.equal(f.calls[0].options.credentials, "omit"); assert.equal(f.calls[0].options.redirect, "error"); assert(!f.calls[0].options.headers);
  });
  await test("Write/network length errors abort and remove only this operation's incomplete output", async () => {
    for (const options of [{ writeFails: true }, { truncated: true }]) {
      const f = fixture(options); await f.saver.choose(); await assert.rejects(f.save(), /pausada/);
      assert(f.events.includes("abort") && f.events.includes("remove")); assert(!f.events.includes("close"));
      assert.equal([...f.contents].filter(([, bytes]) => bytes !== null).length, 1); assert.equal(f.contents.get("original.txt").toString(), "pre-existing"); assert.equal(f.timers.size, 0);
    }
  });
  await test("Picker rejection, unsupported context and permission revocation create no files or requests", async () => {
    for (const options of [{ rejectPicker: true }, { secure: false }]) { const f = fixture(options); await assert.rejects(f.saver.choose()); assert.equal(f.calls.length, 0); assert.equal(f.contents.size, 1); }
    const f = fixture({ denied: true }); await f.saver.choose(); await assert.rejects(f.save()); assert.equal(f.calls.length, 0); assert.equal(f.contents.size, 1);
  });
  await test("Directory collision refuses overwrite; departure drops memory permission", async () => {
    const f = fixture(); await f.saver.choose(); f.contents.set("Lista-synthetic-batch-synthetic-2/", null);
    await assert.rejects(f.save()); assert.equal(f.calls.length, 0); assert.equal(f.contents.get("original.txt").toString(), "pre-existing");
    f.saver.leave(); assert.equal(f.saver.authorized, false); await assert.rejects(f.save());
  });
  await test("Save deadline or cancellation abort a stalled stream and clean only its partial output", async () => {
    for (const deadline of [true, false]) {
      const f = fixture({ stalled: true }); await f.saver.choose(); const pending = f.save(); pending.catch(() => {});
      for (let i = 0; i < 10 && !f.events.includes("write"); i++) await new Promise(setImmediate);
      assert(f.events.includes("write"));
      if (deadline) [...f.timers.values()][0](); else f.saver.abort();
      await assert.rejects(pending, /pausada/); assert(f.events.includes("abort") && f.events.includes("remove"));
      assert.equal(f.contents.get("original.txt").toString(), "pre-existing"); assert.equal(f.timers.size, 0);
    }
  });
  assert(!source.includes(".blob(") && !source.includes(".arrayBuffer(") && !source.includes("Storage") && !source.includes("console."));
  console.log(JSON.stringify({ summary: { passed: results.filter(r => r.status === "pass").length, failed: results.filter(r => r.status === "fail").length, scope: "simulated directory API; browser verification separate" }, results }, null, 2));
  process.exitCode = results.some(r => r.status === "fail") ? 1 : 0;
})();
