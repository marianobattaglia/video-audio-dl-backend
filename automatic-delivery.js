"use strict";
const { randomUUID, randomBytes } = require("node:crypto");
const { fields, fail } = require("./playlist-store");

// Separate transport: an HTTP success is not a receipt for a local disk write.
function automaticDelivery({ store, tickets, open, remove, ticketTtl, jobTtl, filenameHeader, now = Date.now, transferMs = 120000 }) {
  function valid(job) {
    if (!job || job.status !== "complete" || !job.outputPath || job.delivered || now() >= job.completedAt + jobTtl) throw fail("El archivo ya no está disponible.", 410);
    if (job.automaticTransfer || job.deliveryInProgress || job.archiveInProgress) throw fail("Hay una transferencia activa.", 409);
  }
  function revoke(jobId) { for (const [token, value] of tickets) if (value.type === "automatic" && value.jobId === jobId) tickets.delete(token); }
  async function ticket(batchId, entryId, body) {
    fields(body, ["jobId"]);
    const { row, job } = store.bound(batchId, entryId, body.jobId, "automatic");
    if (row.deliveryBusy || row.receipt) throw fail("El guardado ya fue confirmado o está en curso.", 409);
    valid(job); row.deliveryBusy = true;
    try {
      const media = await open(job); await media.file.close(); valid(job);
      store.capacity(null, null, 1024);
      const deliveryId = randomUUID(), token = randomBytes(32).toString("base64url");
      revoke(job.id);
      row.delivery = { id: deliveryId, jobId: job.id, attemptId: row.attemptId, transferred: false };
      const expiresAt = Math.min(now() + ticketTtl, job.completedAt + jobTtl);
      tickets.set(token, { type: "automatic", batchId, entryId, jobId: job.id, deliveryId, expiresAt });
      return { deliveryId, expiresAt, filename: job.filename, downloadUrl: `/api/playlist-batches/${batchId}/items/${entryId}/file?ticket=${token}` };
    } finally { row.deliveryBusy = false; }
  }
  async function confirm(batchId, entryId, body) {
    fields(body, ["jobId", "deliveryId"]);
    const { row, job } = store.bound(batchId, entryId, body.jobId, "automatic");
    if (row.receipt?.status === "saved" && row.receipt.deliveryId === body.deliveryId) return store.publicRow(row);
    if (!row.delivery || row.delivery.id !== body.deliveryId || row.delivery.jobId !== body.jobId || row.delivery.attemptId !== row.attemptId || !row.delivery.transferred) throw fail("La confirmación no pertenece a una transferencia terminada.", 409);
    if (row.deliveryBusy) throw fail("La confirmación está en curso. Comprobá el estado.", 409);
    valid(job); row.deliveryBusy = true;
    try {
      const receipt = { status: "saved", jobId: job.id, attemptId: row.attemptId, deliveryId: body.deliveryId, filename: job.filename };
      // Reserve before removing bytes; receipt survives a swept job and lost ACK.
      store.capacity(null, null, Buffer.byteLength(JSON.stringify(receipt)) * 2 + 256);
      await remove(job);
      row.receipt = receipt; job.outputPath = null; job.status = "saved"; revoke(job.id);
      return store.publicRow(row);
    } finally { row.deliveryBusy = false; }
  }
  async function file(batchId, entryId, token, res) {
    const value = tickets.get(token);
    if (!value || value.type !== "automatic" || value.batchId !== batchId || value.entryId !== entryId || now() >= value.expiresAt) throw fail("El permiso venció o ya fue usado.", 401);
    const { row, job } = store.bound(batchId, entryId, value.jobId, "automatic");
    if (row.delivery?.id !== value.deliveryId || row.deliveryBusy || row.receipt) throw fail("La transferencia ya no está disponible.", 409);
    valid(job); tickets.delete(token); row.deliveryBusy = true;
    let media;
    try { media = await open(job); valid(job); }
    catch (error) { await media?.file.close(); row.deliveryBusy = false; throw error; }
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const stream = media.file.createReadStream({ start: 0, autoClose: true });
    const abort = () => { stream.destroy(); res.destroy(); };
    job.automaticTransfer = { abort, done }; job.deliveryInProgress = true;
    const timer = setTimeout(abort, transferMs); timer.unref?.();
    res.once("close", async () => {
      clearTimeout(timer); stream.destroy();
      try { await media.file.close(); } catch { /* stream may already have closed */ }
      if (res.writableFinished && row.delivery?.id === value.deliveryId) row.delivery.transferred = true;
      job.automaticTransfer = null; job.deliveryInProgress = false; row.deliveryBusy = false; finish();
    });
    stream.on("error", abort);
    res.writeHead(200, { "Content-Type": job.kind === "audio" ? "audio/mpeg" : "video/mp4", "Content-Length": media.stat.size,
      "Content-Disposition": filenameHeader(job.filename), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    stream.pipe(res);
  }
  return { ticket, confirm, file };
}
module.exports = { automaticDelivery };
