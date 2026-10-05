"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(path, body) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) });
  return { status: response.status, data: await response.json() };
}
async function until(action) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { try { const value = await action(); if (value) return value; } catch {} await pause(250); }
  throw new Error("Restart verification timed out");
}
(async () => {
  await until(async () => (await call("/healthz")).status === 200);
  if (process.argv[2] === "prepare") {
    const complete = (await call("/api/jobs", { kind: "video", url: "http://fixture.test/media.mp4" })).data.id;
    assert(complete);
    await until(async () => (await call(`/api/jobs/${complete}`)).data.status === "complete");
    const running = (await call("/api/jobs", { kind: "audio", url: "http://fixture.test/slow.mp4" })).data.id;
    assert(running);
    assert.equal((await call(`/api/jobs/${running}`)).data.status, "running");
    console.log(JSON.stringify({ complete, running }));
  } else {
    for (const id of process.argv.slice(3)) assert.equal((await call(`/api/jobs/${id}`)).status, 404);
    assert.deepEqual(await fs.readdir("/tmp/downloads"), []);
    const retry = (await call("/api/jobs", { kind: "audio", url: "http://fixture.test/media.mp4" })).data.id;
    assert(retry);
    await until(async () => (await call(`/api/jobs/${retry}`)).data.status === "complete");
    const ticket = await call(`/api/jobs/${retry}/ticket`, {});
    assert.equal(ticket.status, 200);
    await pause(11000);
    assert.equal((await fetch(`http://127.0.0.1:3000${ticket.data.downloadUrl}`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:3000/api/jobs/${retry}`, { method: "DELETE" })).status, 200);
    await until(async () => !(await fs.stat(`/tmp/downloads/${retry}`).catch(() => null)));
    for (const source of ["large", "grow"]) {
      const id = (await call("/api/jobs", { kind: "video", url: `http://fixture.test/${source}.mp4` })).data.id;
      assert(id);
      const job = await until(async () => { const job = (await call(`/api/jobs/${id}`)).data; return ["failed", "complete"].includes(job.status) && job; });
      assert.equal(job.status, "failed");
      if (source === "grow") assert.match(job.message, /límite de tamaño/);
      await until(async () => !(await fs.stat(`/tmp/downloads/${id}`).catch(() => null)));
    }
    console.log(JSON.stringify({ name: "Actual Docker container restart loses running/completed jobs, clears tmpfs and permits retry", status: "pass", supplementalChecks: ["Expired ticket rejected", "Oversized valid MP4 rejected and cleaned", "Growing output reports size-quota failure and cleans"] }));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
