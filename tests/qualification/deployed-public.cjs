"use strict";
// Safe public deployment probes: no real credentials/cookies and no media jobs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const frontend = "https://video-audio-dl.vercel.app";
const backend = "https://video-audio-dl-backend.onrender.com";
const results = [];
const evidence = { recordedAt: new Date().toISOString(), frontend, backend,
  scope: "Public deployment probes without credentials, cookie reads, downloads or provider changes", results };
async function probe(name, action) {
  const started = Date.now();
  try { const detail = await action(); results.push({ name, status: "pass", ms: Date.now() - started, ...detail }); }
  catch (error) { results.push({ name, status: "fail", ms: Date.now() - started,
    error: error instanceof assert.AssertionError ? "Unexpected status, header or public asset content" : (error.name || "ProbeError") }); }
  console.log(JSON.stringify(results.at(-1)));
}
async function call(origin, route, options = {}) {
  const reply = await fetch(origin + route, { ...options, redirect: "error", signal: AbortSignal.timeout(120000) });
  const text = await reply.text();
  return { reply, text, data: reply.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
}
(async () => {
  let html;
  await probe("Vercel HTTPS and response security headers", async () => {
    const { reply, text } = await call(frontend, "/"); html = text;
    assert.equal(reply.status, 200);
    for (const [header, value] of [["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["referrer-policy", "no-referrer"]]) assert.equal(reply.headers.get(header), value);
    assert.match(reply.headers.get("content-security-policy") || "", /script-src 'self'/);
    return { statusCode: reply.status, tlsCertificateVerified: true };
  });
  await probe("Generated CSP restricts connections to the configured API before scripts", async () => {
    assert(html);
    const meta = html.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i)?.[0];
    assert(meta); assert(html.indexOf(meta) < html.indexOf("<script"));
    const policy = meta.match(/content="([^"]+)"/i)?.[1]?.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    assert(policy); assert(policy.includes(`connect-src 'self' ${backend}`));
    assert(!policy.includes("https:;")); assert(!/<script\b[^>]*src="https?:/i.test(html));
    assert.match(html, /target="_blank"/); assert.match(html, /referrerpolicy="no-referrer"/);
  });
  await probe("Deployed public configuration contains only the intended API origin", async () => {
    const { reply, text } = await call(frontend, "/config.js"); assert.equal(reply.status, 200);
    const config = JSON.parse(text.match(/Object\.freeze\((\{.*\})\)/)?.[1] || text.match(/=\s*(\{.*\});?/)?.[1] || "null");
    assert.deepEqual(config, { apiBaseUrl: backend });
  });
  await probe("Deployed client matches local source and has no credential persistence", async () => {
    const { reply, text } = await call(frontend, "/app.js"); assert.equal(reply.status, 200);
    const local = await fs.readFile(path.resolve(__dirname, "../../../video-audio-dl-frontend/public/app.js"), "utf8");
    const normalized = value => value.replaceAll("\r\n", "\n");
    assert.equal(normalized(text), normalized(local));
    assert(!/sessionStorage\.(?:setItem|getItem)/.test(text)); assert(!/localStorage\./.test(text));
    assert(text.includes("BearerEncoded"));
    return { sourceSha256: createHash("sha256").update(normalized(text)).digest("hex") };
  });
  await probe("Render HTTPS health exposes only readiness and authentication mode", async () => {
    const { reply, data } = await call(backend, "/healthz"); assert.equal(reply.status, 200);
    assert.deepEqual(Object.keys(data).sort(), ["activeDownloads", "authRequired", "status"]);
    assert.equal(data.status, "ok"); assert.equal(data.authRequired, true);
    return { tlsCertificateVerified: true, authRequired: data.authRequired, activeDownloads: data.activeDownloads };
  });
  await probe("Exact Vercel origin can read health", async () => {
    const { reply } = await call(backend, "/healthz", { headers: { Origin: frontend } });
    assert.equal(reply.status, 200); assert.equal(reply.headers.get("access-control-allow-origin"), frontend);
  });
  await probe("Unconfigured browser origin is denied", async () => {
    const { reply } = await call(backend, "/healthz", { headers: { Origin: "https://unrelated.example" } });
    assert.equal(reply.status, 403); assert.equal(reply.headers.get("access-control-allow-origin"), null);
  });
  await probe("Allowed browser preflight permits protected operations", async () => {
    const { reply } = await call(backend, "/api/jobs", { method: "OPTIONS", headers: { Origin: frontend,
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
    assert.equal(reply.status, 204); assert.equal(reply.headers.get("access-control-allow-origin"), frontend);
  });
  const id = randomUUID();
  for (const [label, method, route, headers] of [
    ["creation without Origin", "POST", "/api/jobs", {}],
    ["creation with allowed Origin", "POST", "/api/jobs", { Origin: frontend }],
    ["status", "GET", `/api/jobs/${id}`, {}],
    ["cancellation", "DELETE", `/api/jobs/${id}`, {}],
    ["ticket issuance", "POST", `/api/jobs/${id}/ticket`, {}]
  ]) await probe(`Authentication rejects anonymous ${label}`, async () => {
    const { reply, data } = await call(backend, route, { method, headers: { ...headers, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, body: method === "POST" ? "{}" : undefined });
    assert.equal(reply.status, 401); assert.deepEqual(Object.keys(data), ["error"]);
    assert(!JSON.stringify(data).includes("/etc/"));
  });
  await probe("File delivery without a capability ticket is denied", async () => {
    const { reply } = await call(backend, `/api/jobs/${id}/file`); assert.equal(reply.status, 401);
  });
  for (const route of ["/.env", "/youtube-cookies.txt", "/server.js"]) await probe(`Backend does not serve ${route}`, async () => {
    const { reply, data } = await call(backend, route); assert.equal(reply.status, 404); assert.deepEqual(Object.keys(data), ["error"]);
  });
  evidence.summary = { passed: results.filter(x => x.status === "pass").length, failed: results.filter(x => x.status === "fail").length };
  await fs.writeFile(path.join(__dirname, "results-deployed-public-latest.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ summary: evidence.summary }));
  process.exitCode = evidence.summary.failed ? 1 : 0;
})().catch(() => { console.error("Public deployment probes did not complete"); process.exitCode = 1; });
