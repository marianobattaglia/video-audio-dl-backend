"use strict";
const { randomUUID } = require("node:crypto");
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DELIVERY_MODES = Object.freeze(["manual", "automatic", "zip"]);
const HELD = ["ready", "delivering", "transferring", "awaiting_save_confirmation", "archiving"];
const CONSUMED = ["saved", "archived", "delivered"];
const LIMITS = Object.freeze({ previewEntries: 50, batchItems: null, readyFiles: 2, deliveryModes: DELIVERY_MODES });
const METADATA_BYTES = 8 * 1024 * 1024;
const ISOLATED = new Set(["source_unavailable", "source_format_unavailable", "source_region_restricted", "download_size_limit", "download_timeout", "invalid_media_output"]);
function fail(message, status = 400) { return Object.assign(new Error(message), { status, userMessage: message }); }
function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw fail("La solicitud contiene campos no permitidos.");
}
function text(value, fallback) {
  if (typeof value !== "string") return fallback;
  return Array.from(value.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()).slice(0, 180).join("") || fallback;
}
function normalizeMetadata(raw, host, start = 1) {
  if (!raw || raw._type !== "playlist" || !Array.isArray(raw.entries)) throw fail("No se pudo leer esa lista. Probá con una playlist fija de YouTube.", 422);
  const total = Number.isSafeInteger(raw.playlist_count) && raw.playlist_count >= 0 && raw.playlist_count <= 10000000 ? raw.playlist_count : null;
  const entries = raw.entries.slice(0, LIMITS.previewEntries).map((entry, i) => {
    const videoId = typeof entry?.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(entry.id) ? entry.id : null;
    const knownUnavailable = ["private", "premium_only", "subscriber_only"].includes(entry?.availability)
      || /^\[(?:Private|Deleted|Unavailable) video\]$/i.test(entry?.title || "");
    return { id: randomUUID(), position: start + i, videoId, title: text(entry?.title, `Elemento ${start + i}`),
      duration: Number.isFinite(entry?.duration) && entry.duration >= 0 && entry.duration <= 10000000 ? entry.duration : null,
      available: Boolean(videoId && !knownUnavailable), url: videoId ? `https://${host}/watch?v=${videoId}` : null };
  });
  return { title: text(raw.title, "Lista de YouTube"), entries, totalKnown: total,
    truncated: raw.entries.length > LIMITS.previewEntries };
}
class PlaylistStore {
  constructor({ jobs, startJob, cancelJob, jobTtl, now = Date.now, maxMetadataBytes = METADATA_BYTES }) {
    Object.assign(this, { jobs, startJob, cancelJob, jobTtl, now });
    this.previews = new Map(); this.batches = new Map();
    this.maxMetadataBytes = maxMetadataBytes;
  }
  metadataBytes(extraPreview, extraBatch, extraBytes = 0) {
    const previewValues = [...this.previews.values()].filter(p => p.id !== extraPreview?.id);
    if (extraPreview) previewValues.push(extraPreview);
    const batchValues = [...this.batches.values()]; if (extraBatch) batchValues.push(extraBatch);
    const data = { previews: previewValues.map(p => ({ id: p.id, url: p.url, host: p.host, entries: p.entries,
      pages: [...p.pages], tokens: [...p.tokens] })), batches: batchValues.map(b => ({ id: b.id, archive: b.archive, rows: b.rows.map(({ attempts, ...row }) => ({ ...row, attempts: attempts.size })) })) };
    return Buffer.byteLength(JSON.stringify(data)) * 2 + batchValues.reduce((sum, b) => sum + b.rows.reduce((n, r) => n + r.attempts.size * 256, 0), 0) + extraBytes;
  }
  capacity(extraPreview, extraBatch, extraBytes = 0) {
    if (this.metadataBytes(extraPreview, extraBatch, extraBytes) > this.maxMetadataBytes) throw fail("No hay memoria disponible para conservar más canciones. Intentá nuevamente más tarde.", 429);
  }
  addPreview(metadata, { url = null, host = null } = {}) {
    this.sweep();
    if (this.previews.size >= 20) throw fail("Hay demasiadas listas abiertas. Volvé a intentar en unos minutos.", 429);
    const token = randomUUID();
    const preview = { id: randomUUID(), title: metadata.title, url, host, entries: [], pages: new Map(), tokens: new Map([[token, 1]]), expiresAt: this.now() + 600000 };
    this.savePage(preview, token, metadata);
    this.previews.set(preview.id, preview);
    return this.publicPage(preview, token);
  }
  preview(id) {
    const preview = this.previews.get(id);
    if (!preview || this.now() >= preview.expiresAt) throw fail("La vista previa venció. Cargá la lista nuevamente.", 410);
    return preview;
  }
  pageRequest(body) {
    fields(body, ["previewId", "pageToken"]);
    const preview = this.preview(body.previewId), start = preview.tokens.get(body.pageToken);
    if (!UUID.test(body.pageToken || "") || !start) throw fail("La página solicitada no pertenece a esa lista.");
    return { preview, token: body.pageToken, start, cached: preview.pages.has(body.pageToken) };
  }
  savePage(preview, token, metadata) {
    if (preview.pages.has(token)) return this.publicPage(preview, token);
    const start = preview.tokens.get(token);
    if (!start || metadata.entries.some((entry, i) => entry.position !== start + i)) throw fail("La página recibida no es válida.", 422);
    const pages = new Map(preview.pages), tokens = new Map(preview.tokens);
    let next = null;
    if (metadata.truncated) { next = randomUUID(); tokens.set(next, start + LIMITS.previewEntries); }
    pages.set(token, { ...metadata, next });
    const candidate = { ...preview, entries: [...preview.entries, ...metadata.entries].sort((a, b) => a.position - b.position), pages, tokens, expiresAt: this.now() + 600000 };
    this.capacity(candidate); Object.assign(preview, candidate);
    return this.publicPage(preview, token);
  }
  publicPage(preview, token) {
    const metadata = preview.pages.get(token), start = preview.tokens.get(token);
    preview.expiresAt = this.now() + 600000;
    const previous = [...preview.tokens].find(([, position]) => position === start - LIMITS.previewEntries)?.[0] || null;
    return { previewId: preview.id, title: preview.title, entries: metadata.entries.map(({ url, ...entry }) => entry),
      truncated: metadata.truncated, totalKnown: metadata.totalKnown, expiresAt: preview.expiresAt, limits: LIMITS,
      page: Math.floor((start - 1) / LIMITS.previewEntries) + 1, pageToken: token, previousPageToken: previous, nextPageToken: metadata.next };
  }
  create(body) {
    fields(body, ["previewId", "entryIds", "kind", "deliveryMode"]); this.sweep();
    const deliveryMode = body.deliveryMode === undefined ? "manual" : body.deliveryMode;
    if (!DELIVERY_MODES.includes(deliveryMode)) throw fail("Elegí un modo de entrega válido.");
    const preview = this.preview(body.previewId);
    if (!["audio", "video"].includes(body.kind) || !Array.isArray(body.entryIds) || !body.entryIds.length
      || new Set(body.entryIds).size !== body.entryIds.length) throw fail("Seleccioná canciones distintas y un formato válido.");
    const keys = new Set(body.entryIds);
    const selected = preview.entries.filter(entry => keys.has(entry.id));
    if (selected.length !== body.entryIds.length || selected.some(entry => !entry.available)) throw fail("La selección contiene elementos que no están disponibles en esa lista.");
    if (this.batches.size >= 20) throw fail("Hay demasiadas tandas abiertas. Volvé a intentar en unos minutos.", 429);
    const batch = { id: randomUUID(), title: preview.title, kind: body.kind, deliveryMode, touchedAt: this.now(), cancelled: false,
      rows: selected.map(entry => ({ ...entry, jobId: null, attemptId: null, starting: false, attempts: new Map() })) };
    this.capacity(null, batch); this.batches.set(batch.id, batch); return this.publicBatch(batch);
  }
  rowState(row, jobId = row.jobId) {
    if (jobId === row.jobId && row.receipt) return row.receipt.status;
    if (row.starting && jobId === row.jobId) return "starting";
    if (!jobId) return row.cancelled ? "cancelled" : "pending";
    const job = this.jobs.get(jobId);
    if (!job) return "expired";
    if (job.archiveInProgress) return "archiving";
    if (job.automaticTransfer) return "transferring";
    if (job.status === "complete" && this.now() < (job.completedAt || job.createdAt) + this.jobTtl && row.delivery?.transferred) return "awaiting_save_confirmation";
    if (job.deliveryInProgress || job.status === "complete" && job.delivered) return "delivering";
    if (job.status === "complete") return this.now() >= (job.completedAt || job.createdAt) + this.jobTtl ? "expired" : "ready";
    if (job.failureReason === "output_unavailable") return "expired";
    return job.status;
  }
  publicRow(row, jobId = row.jobId) {
    const job = this.jobs.get(jobId), status = this.rowState(row, jobId);
    return { id: row.id, position: row.position, title: row.title, duration: row.duration, videoId: row.videoId,
      jobId, attemptId: row.attemptId, status, progress: job?.progress ?? null,
      filename: row.receipt?.filename || job?.filename || null, message: status === "expired" ? "El archivo venció. Podés prepararlo otra vez." : row.receipt ? (status === "saved" ? "Guardado confirmado." : "Agregado al ZIP.") : job?.message || "Pendiente",
      canDownload: status === "ready", reason: job?.failureReason || null,
      pauseOnFailure: status === "failed" && !ISOLATED.has(job?.failureReason),
      expiresAt: job?.completedAt ? job.completedAt + this.jobTtl : null };
  }
  live(batch) { return Boolean(batch.archiveBusy || batch.archive?.delivering) || batch.rows.some(row => ["starting", "queued", "running", "delivering", "transferring", "archiving"].includes(this.rowState(row))); }
  readyCount(batch) { return batch.rows.filter(row => HELD.includes(this.rowState(row))).length; }
  publicBatch(batch) {
    const entries = batch.rows.map(row => this.publicRow(row));
    const active = entries.some(row => ["starting", "queued", "running"].includes(row.status));
    const pending = entries.some(row => row.status === "pending");
    const bufferFull = this.readyCount(batch) >= LIMITS.readyFiles && pending;
    return { id: batch.id, title: batch.title, kind: batch.kind, deliveryMode: batch.deliveryMode, entries, limits: LIMITS,
      archive: this.archiveState?.(batch) || null,
      cancelled: batch.cancelled, readyCount: this.readyCount(batch),
      state: batch.cancelled ? "cancelled" : active ? "running" : bufferFull ? "paused" : pending ? "pending" : "complete",
      pauseReason: bufferFull ? "ready_files" : null, expiresAt: batch.touchedAt + 900000 };
  }
  get(id) {
    const batch = this.batches.get(id);
    if (!batch || this.now() - batch.touchedAt >= 900000 && !this.live(batch)) {
      if (batch) this.batches.delete(id);
      throw fail("La tanda ya no está disponible. Cargá la lista nuevamente.", 404);
    }
    batch.touchedAt = this.now(); return batch;
  }
  async start(id, entryId, body, charge) {
    fields(body, ["attemptId"]);
    if (!UUID.test(body.attemptId || "")) throw fail("El intento no es válido.");
    const batch = this.get(id), row = batch.rows.find(item => item.id === entryId);
    if (!row) throw fail("El elemento no pertenece a esa tanda.", 404);
    const previous = row.attempts.get(body.attemptId);
    if (previous) {
      await previous.promise;
      if (row.receipt?.jobId === previous.jobId && row.receipt.attemptId === body.attemptId) return this.publicRow(row);
      if (!this.jobs.has(previous.jobId)) throw fail("Ese intento venció. Prepará el elemento otra vez.", 410);
      return this.publicRow(row, previous.jobId);
    }
    if (batch.cancelled) throw fail("La tanda fue cancelada.", 409);
    this.beforeStart?.(batch);
    if (this.live(batch)) throw fail("Hay un elemento activo. Esperá a que termine.", 429);
    if ([...HELD, ...CONSUMED].includes(this.rowState(row))) throw fail("Ese elemento ya está preparado o fue entregado.", 409);
    if (batch.deliveryMode !== "manual" && this.readyCount(batch)) throw fail("Confirmá el guardado o el ZIP antes de preparar el siguiente elemento.", 409);
    if (this.readyCount(batch) >= LIMITS.readyFiles) throw fail("Guardá un archivo listo antes de continuar.", 429);
    // Bound idempotency history as well as batches/snapshots, including in open mode.
    if (row.attempts.size >= 32) throw fail("La tanda alcanzó el límite de intentos. Cargá la lista nuevamente.", 429);
    this.capacity(null, null, 1024);
    row.starting = true; row.attemptId = body.attemptId;
    const attempt = { jobId: null }; row.attempts.set(body.attemptId, attempt);
    attempt.promise = (async () => {
      try {
        charge();
        const old = this.jobs.get(row.jobId);
        if (old) await this.cancelJob(old);
        const job = await this.startJob(batch.kind, row.url);
        job.playlistOwner = { batchId: batch.id, entryId: row.id, deliveryMode: batch.deliveryMode };
        row.delivery = null;
        row.jobId = job.id; attempt.jobId = job.id;
        this.afterStart?.(batch);
        if (batch.cancelled) await this.cancelJob(job);
      } catch (error) {
        // Only this literal rejection guarantees that startJob was never called.
        if (error.code === "E_MEDIA_ADMISSION_RATE" && !attempt.jobId) row.attempts.delete(body.attemptId);
        throw error;
      } finally { row.starting = false; }
    })();
    await attempt.promise; return this.publicRow(row);
  }
  async cancel(id, discard = false) {
    const batch = this.get(id); batch.cancelled = true;
    await this.cancelArchive?.(batch, discard);
    for (const row of batch.rows) if (!row.jobId) row.cancelled = true;
    await Promise.allSettled(batch.rows.filter(row => row.starting).map(row => row.attempts.get(row.attemptId)?.promise));
    for (const row of batch.rows) {
      const job = this.jobs.get(row.jobId), state = this.rowState(row);
      if (job?.automaticTransfer) { job.automaticTransfer.abort(); await job.automaticTransfer.done; }
      if (job && (["queued", "running"].includes(state) || discard && state !== "delivering" && !CONSUMED.includes(state))) await this.cancelJob(job);
    }
    const result = this.publicBatch(batch);
    if (discard) { batch.discarded = true; if (!this.live(batch)) this.batches.delete(id); }
    return result;
  }
  sweep() {
    const now = this.now();
    for (const [id, value] of this.previews) if (now >= value.expiresAt) this.previews.delete(id);
    for (const [id, batch] of this.batches) if (!this.live(batch) && (batch.discarded || now - batch.touchedAt >= 900000)) { this.expireArchive?.(batch); this.batches.delete(id); }
  }
  bound(id, entryId, jobId, mode) {
    const batch = this.get(id), row = batch.rows.find(item => item.id === entryId);
    if (batch.deliveryMode !== mode || !row || row.jobId !== jobId) throw fail("La operación no pertenece al resultado actual.", 409);
    return { batch, row, job: this.jobs.get(jobId) };
  }
  consume(row, receipt) {
    this.capacity(null, null, Buffer.byteLength(JSON.stringify(receipt)) * 2 + 256);
    row.receipt = receipt;
  }
}
module.exports = { PlaylistStore, normalizeMetadata, fields, fail, LIMITS, ISOLATED, text };
