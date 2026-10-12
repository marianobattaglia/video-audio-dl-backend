"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { randomUUID, randomBytes } = require("node:crypto");
const { fields, fail, text, ISOLATED } = require("./playlist-store");
const { openArchive } = require("./archive-output");

function archiveFilename(title, partial) {
  let base = text(title, "Lista").replace(/[\\/:*?<>|".]/g, "_").slice(0, 100);
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(base)) base = `Lista - ${base}`;
  return `${base}${partial ? " - parcial" : ""}.zip`;
}

function playlistArchive({ store, root, maxBytes, jobTtl, ticketTtl, totalMs, operationMs, sandbox,
  openMedia, removeMedia, reserve, stopProcessGroup, signalDownload, tickets, filenameHeader, now = Date.now }) {
  const operations = new Map();
  const target = batch => path.join(root, batch.id);
  function state(batch) {
    const record = batch.archive;
    if (record?.expiresAt && now() >= record.expiresAt && !batch.archiveBusy && !record.delivering) record.state = "expired";
    if (record && !["ready", "partial_ready", "expired"].includes(record.state) && now() >= record.deadline) { record.state = "paused"; record.expiresAt ||= now() + jobTtl; batch.cancelled = true; }
    return record ? { state: record.state, included: record.members.filter(member => member.name !== "resultado.txt").length, expiresAt: record.expiresAt || null,
      deadline: record.deadline, filename: record.filename || null, delivering: Boolean(record.delivering), delivered: Boolean(record.delivered), canDownload: ["ready", "partial_ready"].includes(record.state) && now() < record.expiresAt && !record.delivering } : { state: "building", included: 0, canDownload: false };
  }
  function check(batch) {
    if (batch.deliveryMode !== "zip") throw fail("Esta tanda no usa ZIP.", 409);
    const record = batch.archive;
    if (record?.expiresAt && now() >= record.expiresAt || record?.state === "expired") throw fail("El ZIP venció.", 410);
    if (record?.deadline && now() >= record.deadline && !["ready", "partial_ready", "expired"].includes(record.state)) {
      record.state = "paused"; record.expiresAt ||= now() + jobTtl; batch.cancelled = true;
    }
    return record;
  }
  function ensure(batch) {
    return batch.archive ||= { id: batch.id, state: "building", members: [], deadline: now() + totalMs, expiresAt: null };
  }
  function beforeStart(batch) {
    if (batch.deliveryMode !== "zip") return;
    const record = check(batch);
    if (batch.cancelled || record && !["building", "paused"].includes(record.state)) throw fail("El paquete está detenido o ya finalizó.", 409);
  }
  function afterStart(batch) {
    if (batch.deliveryMode !== "zip") return;
    const record = ensure(batch);
    if (now() >= record.deadline || record.expiresAt && now() >= record.expiresAt) {
      batch.cancelled = true; record.state = "expired"; return;
    }
    // Only a successfully created, explicitly requested preparation reactivates
    // a recoverable partial. Status, rejected starts and quota waits never do.
    record.state = "building"; record.expiresAt = null;
  }
  function memberName(row, job) {
    const base = text(job.filename || row.title, "descarga").replace(/[\\/:*?<>|"\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/g, "");
    const ext = job.kind === "audio" ? ".mp3" : ".mp4";
    return `${String(row.position).padStart(4, "0")} - ${Array.from(base.replace(/\.(mp3|mp4)$/i, "")).slice(0, 100).join("")}${ext}`;
  }
  async function worker(batch, header, media, previous, maxSize, controller) {
    const directory = target(batch), staging = path.join(directory, `staging-${randomUUID()}.zip`);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) throw fail("No se pudo preparar el paquete de forma segura.", 503);
    const child = spawn(sandbox, ["/usr/bin/python3", "-I", "-B", "/app/archive-worker.py", staging], {
      cwd: directory, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" } });
    let stdout = "", failed = false;
    const abort = () => { failed = true; signalDownload(child, "SIGKILL"); };
    controller.signal.addEventListener("abort", abort, { once: true });
    const remaining = batch.archive.expiresAt ? operationMs : Math.max(1, batch.archive.deadline - now());
    const timer = setTimeout(abort, Math.min(operationMs, remaining)); timer.unref?.();
    child.stdout.on("data", chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 2048) abort(); });
    child.stderr.resume(); // Never return or log private runtime output.
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 && !failed ? resolve() : reject(fail("No se pudo completar el paquete. Comprobá el estado.", 422))); });
    closed.catch(() => {});
    try {
      const json = Buffer.from(JSON.stringify({ ...header, maxSize }));
      if (json.length > 1024 * 1024) throw fail("El manifiesto del ZIP excede la capacidad.", 429);
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(json.length);
      child.stdin.write(prefix); child.stdin.write(json);
      for (const source of [previous, media].filter(Boolean)) {
        await pipeline(source.file.createReadStream({ start: 0, end: source.stat.size - 1, autoClose: false }), child.stdin, { end: false });
      }
      child.stdin.end(); await closed;
      const result = JSON.parse(stdout);
      if (!Number.isSafeInteger(result.size) || result.size < 22 || result.size > maxSize || !/^[a-f0-9]{64}$/.test(result.sha256)) throw new Error();
      const stat = await fs.lstat(staging);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== result.size) throw new Error();
      return { staging, size: stat.size, sha256: result.sha256, identity: { size: stat.size, dev: stat.dev, ino: stat.ino } };
    } catch (error) {
      abort(); await closed.catch(() => {}); await fs.rm(staging, { force: true });
      // A killed worker may reject the feeding pipeline with EPIPE instead of
      // its exit result. Both are the same safe, recoverable archive failure.
      throw error.status ? error : fail("No se pudo completar el paquete. Comprobá el estado.", 422);
    }
    finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); await stopProcessGroup(child); }
  }
  async function change(batch, row, job, summary, beforeCopy) {
    if (batch.archiveBusy) throw fail("El paquete tiene una operación activa. Comprobá el estado.", 409);
    batch.archiveBusy = true;
    const controller = new AbortController(), record = ensure(batch);
    const deadlineTimer = setTimeout(() => controller.abort(), Math.min(operationMs, record.expiresAt ? operationMs : Math.max(1, record.deadline - now())));
    deadlineTimer.unref?.();
    const oldState = record.state;
    let media, previous, release, result;
    let complete;
    const done = new Promise(resolve => { complete = resolve; });
    operations.set(batch.id, { controller, done });
    if (job) job.archiveInProgress = true;
    record.state = row ? "adding" : "finalizing";
    try {
      if (job) media = await openMedia(job);
      if (record.members.length) previous = await openArchive(record, root, maxBytes, { signal: controller.signal });
      // Partial finalization explicitly stops/discards unincorporated results.
      // Validate and hold the committed package before freeing those bytes.
      if (beforeCopy) await beforeCopy(controller.signal);
      const add = row ? { name: memberName(row, job), size: media.stat.size } : null;
      const members = [...record.members, ...(add ? [add] : []), ...(summary !== undefined ? [{ name: "resultado.txt", size: Buffer.byteLength(summary) }] : [])];
      store.capacity(null, null, Buffer.byteLength(JSON.stringify(members)) * 2 + 2048);
      // Current archive + source are already counted. Reserve all new staging bytes,
      // including central-directory growth and the final summary margin.
      const peak = (previous?.stat.size || 0) + (media?.stat.size || 0) + (summary ? Buffer.byteLength(summary) : 0) + 8192 + members.length * 1024;
      release = await reserve(peak + (summary === undefined ? 65536 : 0));
      if (controller.signal.aborted) throw fail("Paquete cancelado.", 409);
      result = await worker(batch, { oldSize: previous?.stat.size || 0, previous: record.members, members, add, summary }, media, previous, peak, controller);
      if (controller.signal.aborted) throw fail("Paquete cancelado.", 409);
      const receipt = row ? { status: "archived", jobId: job.id, attemptId: row.attemptId, filename: add.name } : null;
      // No fallible metadata work after replace. The in-memory manifest and receipt
      // are published together before a lost HTTP response can cause another append.
      await fs.rename(result.staging, path.join(target(batch), "archive.zip"));
      Object.assign(record, { members, identity: result.identity, sha256: result.sha256, state: summary === undefined ? "building" : oldState });
      if (row) record.expiresAt = null;
      if (row) { row.receipt = receipt; job.status = "archived"; await removeMedia(job); job.outputPath = null; }
    } catch (error) {
      if (result?.staging) await fs.rm(result.staging, { force: true });
      if (["adding", "finalizing"].includes(record.state)) {
        record.state = oldState === "cancelled" ? "cancelled" : "paused";
        if (record.members.length) record.expiresAt ||= now() + jobTtl;
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      await media?.file.close(); await previous?.file.close();
      if (job) job.archiveInProgress = false;
      release?.(); batch.archiveBusy = false; operations.delete(batch.id); complete();
    }
  }
  async function append(id, body) {
    fields(body, ["entryId", "jobId", "attemptId"]);
    const { batch, row, job } = store.bound(id, body.entryId, body.jobId, "zip");
    check(batch);
    if (body.attemptId !== row.attemptId) throw fail("El intento no pertenece al resultado actual.", 409);
    if (row.receipt?.status === "archived") return store.publicBatch(batch);
    if (batch.cancelled || batch.archive?.expiresAt && batch.archive.state !== "paused") throw fail("El paquete está detenido.", 409);
    if (store.rowState(row) !== "ready" || !job?.outputPath) throw fail("El medio no está listo para el paquete.", 409);
    await change(batch, row, job);
    return store.publicBatch(batch);
  }
  function summary(batch) {
    return batch.rows.map(row => {
      const status = store.rowState(row), job = store.jobs.get(row.jobId);
      const reason = status === "failed" && ISOLATED.has(job?.failureReason) ? job.failureReason : "";
      return `${row.position}. ${text(row.title, "Elemento")} — ${row.receipt?.status === "archived" ? "incluido" : status === "failed" ? "no disponible" : "no incluido"}${reason ? ` (${reason})` : ""}`;
    }).join("\n") + "\n";
  }
  async function finalize(id, body) {
    fields(body, ["allowPartial"]);
    if (typeof body.allowPartial !== "boolean") throw fail("Confirmá si aceptás un paquete parcial.");
    const batch = store.get(id), record = check(batch);
    if (!record?.members.length) throw fail("No hay archivos incluidos para descargar.", 409);
    if (["ready", "partial_ready"].includes(record.state)) return store.publicBatch(batch);
    if (record.delivering) throw fail("El paquete se está entregando.", 409);
    if (store.live(batch)) throw fail("Esperá a que termine la operación activa.", 409);
    const all = batch.rows.every(row => row.receipt?.status === "archived");
    const settled = batch.rows.every(row => row.receipt?.status === "archived" || store.rowState(row) === "failed" && ISOLATED.has(store.jobs.get(row.jobId)?.failureReason));
    if (!all && !body.allowPartial) throw fail("El paquete será parcial. Confirmalo para finalizar.", 409);
    if (!all && !settled) { batch.cancelled = true; for (const row of batch.rows) if (!row.jobId) row.cancelled = true; }
    await change(batch, null, null, summary(batch), async signal => {
      if (all) return;
      for (const row of batch.rows) {
        if (signal.aborted) throw fail("Paquete cancelado.", 409);
        const job = store.jobs.get(row.jobId);
        if (!row.receipt && job?.outputPath && ["ready", "expired"].includes(store.rowState(row))) {
          await removeMedia(job); job.outputPath = null; job.status = "cancelled"; row.cancelled = true;
        }
      }
    });
    record.state = all ? "ready" : "partial_ready";
    record.expiresAt = now() + jobTtl;
    record.filename = archiveFilename(batch.title, !all);
    return store.publicBatch(batch);
  }
  async function ticket(id, body) {
    fields(body, []);
    const batch = store.get(id), record = check(batch);
    if (!record || !state(batch).canDownload || batch.archiveBusy) throw fail("El ZIP no está listo.", 409);
    batch.archiveBusy = true;
    try {
      const opened = await openArchive(record, root, maxBytes); await opened.file.close();
      if (record.delivering || now() >= record.expiresAt) throw fail("El paquete ya no está disponible.", 410);
      for (const [token, value] of tickets) if (value.type === "archive" && value.batchId === id) tickets.delete(token);
      const token = randomBytes(32).toString("base64url"), expiresAt = Math.min(now() + ticketTtl, record.expiresAt);
      tickets.set(token, { type: "archive", batchId: id, expiresAt });
      return { downloadUrl: `/api/playlist-batches/${id}/archive/file?ticket=${token}`, expiresAt, filename: record.filename };
    } finally { batch.archiveBusy = false; }
  }
  async function file(id, token, res) {
    const value = tickets.get(token);
    if (!value || value.type !== "archive" || value.batchId !== id || now() >= value.expiresAt) throw fail("El permiso venció o ya fue usado.", 401);
    tickets.delete(token);
    const batch = store.get(id), record = check(batch);
    if (!state(batch).canDownload || batch.archiveBusy) throw fail("El paquete ya no está disponible.", 409);
    record.delivering = true;
    let opened;
    try { opened = await openArchive(record, root, maxBytes); }
    catch (error) { record.delivering = false; throw error; }
    const stream = opened.file.createReadStream({ start: 0, autoClose: true });
    const timer = setTimeout(() => res.destroy(), operationMs); timer.unref?.();
    stream.on("error", () => res.destroy());
    res.once("close", async () => {
      clearTimeout(timer); stream.destroy();
      try { await opened.file.close(); } catch { /* automatic close */ }
      record.delivering = false; record.delivered = res.writableFinished; record.state = "expired";
      await fs.rm(target(batch), { recursive: true, force: true });
    });
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": opened.stat.size, "Content-Disposition": filenameHeader(record.filename), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    stream.pipe(res);
  }
  async function cancel(batch, discard) {
    const operation = operations.get(batch.id); operation?.controller.abort(); await operation?.done;
    if (!batch.archive) return;
    if (discard) { if (!batch.archive.delivering) await expire(batch); }
    else if (!["ready", "partial_ready", "expired"].includes(batch.archive.state)) {
      batch.archive.state = "cancelled"; batch.archive.expiresAt ||= now() + jobTtl;
    }
  }
  async function expire(batch) {
    if (batch.archiveBusy || batch.archive?.delivering) return;
    if (batch.archive) batch.archive.state = "expired";
    await fs.rm(target(batch), { recursive: true, force: true });
  }
  async function sweep() {
    for (const batch of store.batches.values()) {
      if (batch.deliveryMode !== "zip") continue;
      const record = batch.archive;
      if (record && !record.expiresAt && now() >= record.deadline) {
        await cancel(batch, false); batch.cancelled = true;
      }
      if (record?.expiresAt && now() >= record.expiresAt) await expire(batch);
    }
  }
  function shutdown() { for (const operation of operations.values()) operation.controller.abort(); }
  Object.assign(store, { archiveState: state, beforeStart, afterStart, cancelArchive: cancel, expireArchive: batch => { void expire(batch); } });
  return { append, finalize, ticket, file, sweep, shutdown };
}
module.exports = { playlistArchive, archiveFilename };
