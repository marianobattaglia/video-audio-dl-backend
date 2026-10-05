"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const results = [];
let api, logs = "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function test(name, action) {
  const started = Date.now();
  try { await action(); results.push({ name, status: "pass", ms: Date.now() - started }); }
  catch (error) { results.push({ name, status: "fail", error: error.message, ms: Date.now() - started }); }
  console.log(JSON.stringify(results.at(-1)));
}
async function waitFor(action, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await action(); if (value) return value; await sleep(250); }
  throw new Error("Timed out waiting for condition");
}
async function request(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}
async function start(env = {}) {
  logs = "";
  api = spawn("node", ["/app/server.js"], { env: { ...process.env, AUTH_REQUIRED: "false", ACCESS_CREDENTIAL: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  api.stdout.on("data", chunk => { logs = (logs + chunk).slice(-30000); });
  api.stderr.on("data", chunk => { logs = (logs + chunk).slice(-30000); });
  await waitFor(async () => {
    if (api.exitCode !== null) throw new Error(`API exited: ${logs}`);
    try { return (await request("/healthz")).status === 200; } catch { return false; }
  });
}
async function stop() {
  if (!api || api.exitCode !== null) return;
  const closed = once(api, "close"); api.kill("SIGTERM"); await closed;
}
async function create(kind, source = "http://fixture.test/media.mp4") {
  const response = await request("/api/jobs", { method: "POST", body: { kind, url: source } });
  assert.equal(response.status, 202, JSON.stringify(response.data));
  return response.data.id;
}
async function terminal(id) {
  return waitFor(async () => {
    const response = await request(`/api/jobs/${id}`);
    assert.equal(response.status, 200);
    return ["complete", "failed", "cancelled"].includes(response.data.status) && response.data;
  });
}
async function cleaned(id) { await waitFor(async () => !(await fs.stat(`/tmp/downloads/${id}`).catch(() => null)), 10000); }
function tool(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
(async () => {
  await test("Sandbox install, socket families and inherited Python", () => {
    assert.equal(process.getuid(), 1000);
    assert.equal(tool("/usr/local/bin/download-sandbox", ["--check"]).status, 0);
    const baseline = tool("python3", ["-c", "import socket; socket.socket(socket.AF_INET,socket.SOCK_STREAM).close()"]);
    assert.equal(baseline.status, 0);
    const result = tool("/usr/local/bin/download-sandbox", ["/usr/bin/python3", "/qualification/sandbox.py"]);
    assert.equal(result.status, 0, result.stderr);
  });
  await test("Inherited descriptors are closed before execution", () => {
    const code = "import socket,subprocess\ns=socket.socket()\nr=subprocess.run(['/usr/local/bin/download-sandbox','/usr/bin/python3','-c','import os,sys; fd=int(sys.argv[1]); assert not os.path.exists(\"/proc/self/fd/\"+str(fd))',str(s.fileno())],pass_fds=(s.fileno(),))\nassert r.returncode==0";
    const result = tool("python3", ["-c", code]); assert.equal(result.status, 0, result.stderr);
  });
  await test("Node cannot create a direct Internet connection", () => {
    const result = tool("/usr/local/bin/download-sandbox", ["/usr/local/bin/node", "-e", "require('node:net').connect(80,'11.250.237.2').on('connect',()=>process.exit(1)).on('error',e=>process.exit(e.code==='EPERM'?0:2))"]);
    assert.equal(result.status, 0, result.stderr);
  });
  await test("FFmpeg and FFprobe direct HTTP transfers fail", () => {
    for (const binary of ["/usr/bin/ffmpeg", "/usr/bin/ffprobe"]) {
      const args = binary.endsWith("ffmpeg") ? ["-v", "error", "-i", "http://11.250.237.2/media.mp4", "-f", "null", "-"] : ["-v", "error", "http://11.250.237.2/media.mp4"];
      const result = tool("/usr/local/bin/download-sandbox", [binary, ...args]);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /Operation not permitted/);
    }
  });
  await require("./network.cjs")(test);
  await test("Bundled EJS assets parse in Node under inherited seccomp and permissions", async () => {
    const exported = tool("python3", ["-c", "import sys;sys.path.insert(0,'/opt/yt-dlp');from yt_dlp_ejs.yt import solver;open('/tmp/yt-dlp/ejs-core.js','w').write(solver.core());open('/tmp/yt-dlp/ejs-lib.js','w').write(solver.lib())"]);
    assert.equal(exported.status, 0, exported.stderr);
    const result = tool("/usr/local/bin/download-sandbox", ["/usr/local/bin/node", "--experimental-permission", "--allow-fs-read=/tmp/yt-dlp/", "-e", "const fs=require('node:fs'),vm=require('node:vm');for(const n of ['core','lib'])new vm.Script(fs.readFileSync('/tmp/yt-dlp/ejs-'+n+'.js','utf8'));console.log('EJS syntax verified')"]);
    assert.equal(result.status, 0, result.stderr);
    await fs.unlink("/tmp/yt-dlp/ejs-core.js"); await fs.unlink("/tmp/yt-dlp/ejs-lib.js");
  });
  await require("./frontend.cjs")(test);
  try {
    await start();
    await test("API starts as node with protections and expected health", async () => {
      assert.match(logs, /checked internal proxy ready/);
      assert.match(logs, /local EJS, protected Node runtime/);
      assert.equal((await request("/healthz")).data.authRequired, false);
      const status = await fs.readFile(`/proc/${api.pid}/status`, "utf8");
      assert.match(status, /CapEff:\s+0000000000000000/);
      assert.match(status, /NoNewPrivs:\s+1/);
      assert.equal((await fs.readFile("/sys/fs/cgroup/memory.max", "utf8")).trim(), "536870912");
      assert.equal((await fs.readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim(), "10000 100000");
    });
    await test("API rejects private URLs, IPv6, mapped addresses and ports", async () => {
      for (const url of ["http://127.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://mixed.test/", "http://fixture.test:8080/", "ftp://fixture.test/"]) {
        const response = await request("/api/jobs", { method: "POST", body: { kind: "audio", url } });
        assert.equal(response.status, 400, url);
      }
      assert.equal((await request("/healthz")).data.activeDownloads, 0);
    });
    await test("CORS preflight and unknown origin rejection", async () => {
      assert.equal((await request("/healthz", { headers: { Origin: "https://unrelated.test" } })).status, 403);
      const allowed = await fetch("http://127.0.0.1:3000/healthz", { method: "OPTIONS", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "GET" } });
      assert.equal(allowed.status, 204);
      assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    });
    for (const [kind, source] of [["video", "http://fixture.test/media.mp4"], ["audio", "https://fixture.test/media.mp4"], ["video", "http://fixture.test/redirect.mp4"]]) {
      await test(`${kind} transfer, local postprocessing, ticket and cleanup: ${source}`, async () => {
        const id = await create(kind, source);
        const job = await terminal(id);
        assert.equal(job.status, "complete", JSON.stringify(job) + " " + logs);
        const ticket = await request(`/api/jobs/${id}/ticket`, { method: "POST" });
        assert.equal(ticket.status, 200);
        const file = await request(ticket.data.downloadUrl);
        assert.equal(file.status, 200); assert(file.data.length > 1000);
        const target = `/tmp/yt-dlp/${kind}-delivered.${kind === "audio" ? "mp3" : "mp4"}`;
        await fs.writeFile(target, file.data);
        const probe = tool("/usr/local/bin/download-sandbox", ["/usr/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
        assert.equal(probe.status, 0, probe.stderr); assert(Number(probe.stdout) >= 2.9);
        await fs.unlink(target);
        assert.equal((await request(ticket.data.downloadUrl)).status, 401);
        await cleaned(id);
      });
    }
    await test("Private redirect is denied and cleaned", async () => {
      const id = await create("video", "http://fixture.test/redirect-private.mp4");
      assert.equal((await terminal(id)).status, "failed"); await cleaned(id);
    });
    await test("HTTPS rejects a certificate for the wrong hostname", async () => {
      const id = await create("video", "https://badcert.test/media.mp4");
      assert.equal((await terminal(id)).status, "failed");
      assert.match(logs, /CERTIFICATE_VERIFY_FAILED|certificate verify failed|Hostname mismatch/i);
      await cleaned(id);
    });
    await test("Concurrency, cancellation and retry", async () => {
      const id = await create("video", "http://fixture.test/slow.mp4");
      assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "audio", url: "http://fixture.test/media.mp4" } })).status, 429);
      await sleep(3000);
      assert.equal((await request(`/api/jobs/${id}`, { method: "DELETE" })).status, 200);
      await cleaned(id);
      assert.equal((await request(`/api/jobs/${id}`)).data.status, "cancelled");
      const retry = await create("video"); assert.equal((await terminal(retry)).status, "complete");
      await request(`/api/jobs/${retry}`, { method: "DELETE" }); await cleaned(retry);
    });
    await test("Known oversized source fails and cleans", async () => {
      const id = await create("video", "http://fixture.test/large.mp4");
      assert.equal((await terminal(id)).status, "failed"); await cleaned(id);
    });
    await test("Growing temporary output is stopped and cleaned", async () => {
      const id = await create("video", "http://fixture.test/grow.mp4");
      const job = await terminal(id); assert.equal(job.status, "failed");
      assert.match(job.message, /límite de tamaño/);
      await cleaned(id);
    });
    await test("Temporary-space admission rejects before creating a job", async () => {
      const filler = "/tmp/downloads/qualification-filler";
      try {
        await fs.writeFile(filler, Buffer.alloc(2560 * 1024));
        assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "http://fixture.test/media.mp4" } })).status, 429);
      } finally { await fs.unlink(filler); }
    });
    await test("30-second processing timeout stops and cleans", async () => {
      const started = Date.now(), id = await create("video", "http://fixture.test/slow.mp4");
      const job = await terminal(id);
      assert.equal(job.status, "failed"); assert.match(job.message, /tiempo máximo/);
      assert(Date.now() - started >= 29000 && Date.now() - started < 45000);
      await cleaned(id);
    });
    await test("Completed file expires without delivery", async () => {
      const id = await create("video"); assert.equal((await terminal(id)).status, "complete");
      await waitFor(async () => (await request(`/api/jobs/${id}`)).status === 404, 100000);
      await cleaned(id);
    });
    await test("Graceful API restart loses old jobs, cleans and allows retry", async () => {
      const complete = await create("video"); assert.equal((await terminal(complete)).status, "complete");
      const running = await create("audio", "http://fixture.test/slow.mp4");
      await stop(); await start();
      for (const id of [complete, running]) { assert.equal((await request(`/api/jobs/${id}`)).status, 404); await cleaned(id); }
      const retry = await create("audio"); assert.equal((await terminal(retry)).status, "complete");
      await request(`/api/jobs/${retry}`, { method: "DELETE" }); await cleaned(retry);
    });
    await stop();
    await test("Authentication validates direct clients independently of CORS", async () => {
      const credential = "qualification-fictitious-key-123456789";
      await start({ AUTH_REQUIRED: "true", ACCESS_CREDENTIAL: credential });
      assert.equal((await request("/healthz")).data.authRequired, true);
      for (const headers of [{}, { Origin: "http://localhost:5173" }, { Authorization: "Bearer wrong" }]) assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "http://fixture.test/media.mp4" }, headers })).status, 401);
      assert.equal((await request("/api/jobs", { method: "POST", body: { kind: "video", url: "http://127.0.0.1/" }, headers: { Authorization: `Bearer ${credential}` } })).status, 400);
    });
  } finally { await stop(); }
  const metrics = {};
  for (const [name, file] of [["memoryPeakBytes", "memory.peak"], ["memoryEvents", "memory.events"], ["cpuUsage", "cpu.stat"]]) metrics[name] = (await fs.readFile(`/sys/fs/cgroup/${file}`, "utf8").catch(() => "unavailable")).trim();
  console.log(JSON.stringify({ summary: { passed: results.filter(r => r.status === "pass").length, failed: results.filter(r => r.status === "fail").length, environment: "Docker internal controlled network; no cookies", metrics }, results }));
  process.exitCode = results.some(r => r.status === "fail") ? 1 : 0;
})().catch(async error => { console.error(JSON.stringify({ fatal: error.message, results })); await stop(); process.exitCode = 1; });
