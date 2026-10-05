"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { publicWebUrl, resolvePublicHost } = require("./network-policy");
const { createEgressProxy } = require("./egress-proxy");
const { PrivateSession, usesYoutubeSession, MAX_COOKIE_BYTES } = require("./private-session");
const { openMedia } = require("./media-output");

const PORT = integerEnv("PORT", 3000, 1, 65535);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_CONCURRENT = integerEnv("MAX_CONCURRENT_DOWNLOADS", 1, 1, 20);
const MAX_DURATION_MS = integerEnv("MAX_DOWNLOAD_SECONDS", 600, 30, 86400) * 1000;
const JOB_TTL_MS = integerEnv("JOB_TTL_SECONDS", 300, 60, 86400) * 1000;
const MAX_OUTPUT_BYTES = integerEnv("MAX_OUTPUT_MB", 64, 1, 200000) * 1024 * 1024;
const MAX_TEMP_BYTES = integerEnv("MAX_TEMP_MB", 192, 1, 200000) * 1024 * 1024;
const TICKET_TTL_MS = integerEnv("DOWNLOAD_TICKET_SECONDS", 60, 10, 300) * 1000;
const RATE_WINDOW_MS = integerEnv("RATE_WINDOW_SECONDS", 60, 10, 3600) * 1000;
const AUTH_FAILURE_LIMIT = integerEnv("AUTH_FAILURE_LIMIT", 10, 1, 1000);
const JOB_CREATE_LIMIT = integerEnv("JOB_CREATE_LIMIT", 5, 1, 1000);
const AUTH_REQUIRED = booleanEnv("AUTH_REQUIRED", false);
const ACCESS_CREDENTIAL = process.env.ACCESS_CREDENTIAL || "";
const SOURCE_SESSION = Boolean(process.env.YOUTUBE_COOKIES_FILE);
if (SOURCE_SESSION) {
  // Fatal configuration/runtime errors must not print exceptions carrying secrets.
  const fatal = () => { process.stderr.write('{"event":"fatal_failed","reason":"configuration_or_runtime_invalid"}\n'); process.exit(1); };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}
if (SOURCE_SESSION && !AUTH_REQUIRED) throw new Error("E_SESSION_REQUIRES_AUTH");
if (AUTH_REQUIRED && !ACCESS_CREDENTIAL) {
  throw new Error("Set a non-empty ACCESS_CREDENTIAL before starting the API.");
}
const credentialDigest = AUTH_REQUIRED ? createHash("sha256").update(ACCESS_CREDENTIAL).digest() : null;
const allowedOrigins = new Set((process.env.FRONTEND_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
for (const origin of allowedOrigins) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error("E_FRONTEND_ORIGIN"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error("FRONTEND_ORIGINS must contain exact HTTP/HTTPS origins without paths or wildcards.");
  }
}
const TEMP_ROOT = path.resolve(process.env.DOWNLOAD_TMP_DIR || path.join(os.tmpdir(), "video-audio-dl"));
const cookieSession = new PrivateSession({ source: process.env.YOUTUBE_COOKIES_FILE || "", privateRoot: path.join(process.env.TMPDIR || os.tmpdir(), "video-audio-dl-cookie-jars"), mediaRoot: TEMP_ROOT, repositoryRoot: __dirname });
const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const SANDBOX = process.env.DOWNLOAD_SANDBOX_PATH || "/usr/local/bin/download-sandbox";
const JS_RUNTIME = "/usr/local/bin/node";
const jobs = new Map();
const activeJobs = new Set();
const tickets = new Map();
const authFailures = new Map();
const jobAttempts = new Map();
let pendingJobs = 0;
let server;
let egressProxy;
let shuttingDown = false;

function booleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function integerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

async function validateUrl(value) {
  if (typeof value !== "string" || value.length > 4096) throw userError("Pega una URL válida de hasta 4096 caracteres.");
  let url;
  try { url = publicWebUrl(value); } catch { throw userError("Usa una URL pública HTTP o HTTPS en los puertos 80/443, sin credenciales embebidas."); }
  try { await resolvePublicHost(url.hostname); } catch { throw userError("Solo se permiten dominios resolubles y direcciones públicas de Internet."); }
  return url.href;
}

function userError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.userMessage = message;
  return error;
}

async function readJson(req) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw userError("La solicitud debe usar formato JSON.", 415);
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) throw userError("La solicitud es demasiado grande.", 413);
  }
  try { return JSON.parse(body); } catch { throw userError("La solicitud no contiene JSON válido."); }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function applyCors(req, res) {
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) throw userError("Ese sitio no tiene permiso para usar el servicio.", 403);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Retry-After");
  }
  if (req.method !== "OPTIONS") return false;
  if (!origin) throw userError("Se requiere un origen permitido.", 403);
  const method = req.headers["access-control-request-method"];
  const headers = (req.headers["access-control-request-headers"] || "").split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
  if (!["GET", "POST", "DELETE"].includes(method) || headers.some((header) => !["authorization", "content-type"].includes(header))) {
    throw userError("La solicitud no está permitida.", 403);
  }
  res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, DELETE", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600" });
  res.end();
  return true;
}

function rateEntry(map, key) {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || now >= entry.expiresAt) {
    // Avoid retaining an unbounded list of remote addresses.
    for (const [address, value] of map) if (now >= value.expiresAt) map.delete(address);
    if (map.size >= 10000) throw userError("El servicio está ocupado. Intentá nuevamente en unos minutos.", 429);
    entry = { count: 0, expiresAt: now + RATE_WINDOW_MS };
    map.set(key, entry);
  }
  return entry;
}

function rateError(entry, res) {
  res.setHeader("Retry-After", Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)));
  throw userError("Demasiados intentos. Volvé a intentarlo en unos minutos.", 429);
}

function authorize(req, res) {
  if (!AUTH_REQUIRED) return;
  // Forwarded headers are untrusted; direct socket addresses may conservatively
  // share a rate bucket behind a managed proxy.
  const key = req.socket.remoteAddress || "unknown";
  const entry = rateEntry(authFailures, key);
  if (entry.count >= AUTH_FAILURE_LIMIT) rateError(entry, res);
  // Encode new clients' keys for HTTP transport; retain legacy Bearer clients.
  const match = (req.headers.authorization || "").match(/^(Bearer|BearerEncoded) (.+)$/);
  let supplied = match?.[2] || "";
  let validEncoding = true;
  if (match?.[1] === "BearerEncoded") {
    try { supplied = decodeURIComponent(supplied); } catch { validEncoding = false; }
  }
  const digest = createHash("sha256").update(supplied).digest();
  if (!match || !validEncoding || !timingSafeEqual(digest, credentialDigest)) {
    entry.count += 1;
    throw userError("Ingresá una clave de acceso válida.", 401);
  }
}

function limitJobCreation(req, res) {
  const entry = rateEntry(jobAttempts, req.socket.remoteAddress || "unknown");
  if (entry.count >= JOB_CREATE_LIMIT) rateError(entry, res);
  entry.count += 1;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    kind: job.kind,
    progress: job.progress,
    etaSeconds: job.etaSeconds,
    message: job.message,
    filename: job.filename,
    canDownload: job.status === "complete" && !job.delivered,
    createdAt: job.createdAt
  };
}

function addOutputLine(job, line) {
  const progress = line.match(/^DL_PROGRESS:([0-9]+(?:\.[0-9]+)?|NA):([0-9]+|NA)$/);
  if (progress) {
    job.progress = progress[1] === "NA" ? null : Math.min(100, Math.max(0, Number(progress[1])));
    job.etaSeconds = progress[2] === "NA" ? null : Number(progress[2]);
    job.message = job.progress === null ? "Descargando…" : `Descargando… ${Math.floor(job.progress)}%`;
  }
  const output = line.match(/^APP_OUTPUT:(.+)$/);
  if (output) job.outputPath = output[1];
  if (line) {
    job.diagnostics = (job.diagnostics + line.slice(0, 1000) + "\n").slice(-12000);
  }
}

function safeFilename(filename, kind) {
  const base = path.basename(filename || "descarga").replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "_").trim();
  const suffix = kind === "audio" ? ".mp3" : ".mp4";
  const withoutKnownExtension = base.replace(/\.(?:mp3|mp4|mkv|webm|m4a|opus)$/i, "");
  return `${(withoutKnownExtension || "descarga").slice(0, 180)}${suffix}`;
}

async function directoryBytes(directory) {
  let total = 0;
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await fsp.stat(target)).size;
  }
  return total;
}

async function removeJobFiles(job) {
  job.egressSession?.close();
  if (job.timer) clearTimeout(job.timer);
  if (job.sizeTimer) clearInterval(job.sizeTimer);
  for (const [token, ticket] of tickets) if (ticket.jobId === job.id) tickets.delete(token);
  try { await fsp.rm(job.directory, { recursive: true, force: true }); } catch { /* cleanup is retried on expiry/startup */ }
}

function signalDownload(child, signal) {
  if (!child?.pid || process.platform === "win32" && child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") process.stderr.write(SOURCE_SESSION ? '{"event":"process_stop_failed","reason":"termination_failed"}\n' : `Could not stop download process: ${error.code}\n`);
  }
}

function downloadFailure(diagnostics) {
  // Suggestions and warnings can mention cookies even when login is unrelated.
  const errors = diagnostics.split(/\r?\n/).filter((line) => /^\s*ERROR:/i.test(line)).join("\n");
  if (/confirm.*(?:not a bot|not.*robot)|automated (?:requests|traffic)/i.test(errors)) {
    return {
      reason: "source_bot_check",
      message: "El sitio bloqueó la descarga desde el servidor con una verificación antibot. El enlace puede funcionar en tu navegador y aun así fallar aquí."
    };
  }
  if (/login required|authentication required|sign[ -]?in (?:is )?required|sign in to confirm your age|only available (?:for|to) registered users|private video|members.only/i.test(errors)) {
    return {
      reason: "source_login_required",
      message: "Este contenido requiere iniciar sesión en el sitio de origen. Ese tipo de enlace no está disponible en esta app."
    };
  }
  return {
    reason: "download_failed",
    message: "No se pudo descargar esa URL. Comprueba el enlace o prueba con otro sitio compatible."
  };
}

function logDownloadFailure(job, code, reason) {
  if (SOURCE_SESSION) {
    process.stderr.write(`${JSON.stringify({ event: "download_failed", jobId: job.id, kind: job.kind, exitCode: Number.isInteger(code) ? code : null, reason })}\n`);
    return;
  }
  let diagnostics = job.diagnostics;
  if (ACCESS_CREDENTIAL) diagnostics = diagnostics.split(ACCESS_CREDENTIAL).join("[redacted]");
  // Keep signed source URLs and internal proxy credentials out of host logs.
  diagnostics = diagnostics.replace(/https?:\/\/[^\s<>"']+/gi, "[url]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(-6000);
  process.stderr.write(`${JSON.stringify({ event: "download_failed", jobId: job.id, kind: job.kind, exitCode: code, reason, diagnostics })}\n`);
}

function runDownload(job, url) {
  job.completion = executeDownload(job, url).catch(async () => {
    try { await stopProcessGroup(job.child); job.child = null; await cookieSession.release(job.id); await removeJobFiles(job); }
    catch { if (job.child) cookieSession.unsafeProcesses = true; }
    job.status = "failed";
    job.message = "No se pudo completar la descarga de forma segura.";
    job.diagnostics = "";
    process.stderr.write(`${JSON.stringify({ event: "download_failed", jobId: job.id, kind: job.kind, exitCode: null, reason: "cleanup_failed" })}\n`);
    activeJobs.delete(job.id);
  });
}

async function totalTemporaryBytes() { return await directoryBytes(TEMP_ROOT) + await directoryBytes(cookieSession.root); }

async function stopProcessGroup(child) {
  if (!child?.pid) return;
  signalDownload(child, "SIGKILL");
  const deadline = Date.now() + 2500;
  do {
    let live = false;
    for (const entry of await fsp.readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = await fsp.readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === child.pid && !["Z", "X", ""].includes(fields[0])) { live = true; break; }
    }
    if (!live) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("E_DOWNLOAD_PROCESS");
}

async function executeDownload(job, url) {
  const outputTemplate = path.join(job.directory, SOURCE_SESSION ? `${job.kind}-${job.id}.%(ext)s` : "%(title).120B [%(id)s].%(ext)s");
  const args = [
    "--ignore-config", "--no-color", "--newline", "--no-playlist",
    "--max-filesize", String(MAX_OUTPUT_BYTES),
    "--progress-template", "download:DL_PROGRESS:%(progress.percent)s:%(progress.eta)s",
    "--print", "after_move:APP_OUTPUT:%(filepath)s",
    "--restrict-filenames", "--ffmpeg-location", FFMPEG,
    "--postprocessor-args", "ffmpeg_i:-protocol_whitelist file,pipe,crypto,data,concat", "-o", outputTemplate
  ];
  if (job.kind === "video") {
    args.push("-f", "bv*+ba/b", "--merge-output-format", "mp4", "--remux-video", "mp4");
  } else {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  }
  if (job.cookiePath) args.push("--cookies", job.cookiePath);
  args.push(url);

  const session = egressProxy.createSession();
  job.egressSession = session;
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin", HOME: job.directory,
    TMPDIR: process.env.TMPDIR || os.tmpdir(), LANG: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1", ...session.env
  };
  let child;
  try { child = spawn(SANDBOX, [YTDLP, ...args], { cwd: job.directory, env, shell: false, windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { await cookieSession.release(job.id); await removeJobFiles(job); job.status = "failed"; job.message = "No se pudo iniciar el servicio de descarga."; return; }
  job.child = child;
  job.status = "running";
  job.message = "Conectando con el sitio…";
  activeJobs.add(job.id);
  job.timer = setTimeout(() => {
    job.timedOut = true;
    session.close();
    signalDownload(child, "SIGTERM");
    job.killTimer = setTimeout(() => signalDownload(child, "SIGKILL"), 2000); job.killTimer.unref();
  }, MAX_DURATION_MS);
  job.sizeTimer = setInterval(async () => {
    try {
      if (await directoryBytes(job.directory) > MAX_OUTPUT_BYTES || await totalTemporaryBytes() > MAX_TEMP_BYTES) {
        job.tooLarge = true;
        session.close();
        signalDownload(child, "SIGTERM");
        if (!job.killTimer) { job.killTimer = setTimeout(() => signalDownload(child, "SIGKILL"), 2000); job.killTimer.unref(); }
      }
    } catch { /* the job may have been removed during cancellation */ }
  }, 2000);
  job.sizeTimer.unref();
  job.timer.unref();

  let stdoutCarry = "";
  let droppingLine = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) || []) {
      const ends = part.endsWith("\n");
      if (!droppingLine) {
        if (stdoutCarry.length + part.length > 8192) { stdoutCarry = ""; droppingLine = true; }
        else stdoutCarry += part;
      }
      if (ends) { if (!droppingLine) addOutputLine(job, stdoutCarry.replace(/\r?\n$/, "")); stdoutCarry = ""; droppingLine = false; }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    job.diagnostics = (job.diagnostics + chunk).slice(-12000);
  });

  let launchFailed = false;
  child.on("error", () => { launchFailed = true; });
  const code = await new Promise(resolve => child.once("close", resolve));
    session.close();
    if (job.timer) clearTimeout(job.timer);
    if (job.sizeTimer) clearInterval(job.sizeTimer);
    if (job.killTimer) clearTimeout(job.killTimer);
    if (stdoutCarry && !droppingLine) addOutputLine(job, stdoutCarry);
    await stopProcessGroup(child);
    job.child = null;
    try { await cookieSession.release(job.id); }
    catch {
      job.status = "failed"; job.message = "El servicio no pudo completar la limpieza. Intentá nuevamente más tarde.";
      job.diagnostics = ""; await removeJobFiles(job); activeJobs.delete(job.id);
      logDownloadFailure(job, code, "cleanup_failed"); return;
    }
    if (job.status === "cancelled") {
      await removeJobFiles(job);
    } else if (launchFailed) {
      job.status = "failed"; job.message = "No se pudo iniciar el servicio de descarga.";
    } else if (job.timedOut) {
      job.status = "failed";
      job.message = "La descarga superó el tiempo máximo permitido.";
    } else if (job.tooLarge) {
      job.status = "failed";
      job.message = "El archivo supera el límite de tamaño configurado.";
    } else if (code === 0 && job.outputPath) {
        try {
          const media = await openMedia(job, TEMP_ROOT, MAX_OUTPUT_BYTES);
          await media.file.close();
          job.outputIdentity = media.identity;
          job.outputPath = media.target;
          job.filename = SOURCE_SESSION ? `${job.kind}-${job.id}.${job.kind === "audio" ? "mp3" : "mp4"}` : safeFilename(path.basename(media.target), job.kind);
          job.status = "complete";
          job.progress = 100;
          job.message = "Tu archivo está listo.";
          job.completedAt = Date.now();
        } catch {
          job.status = "failed";
          job.message = "La descarga terminó sin generar un archivo válido.";
        }
    } else {
      job.status = "failed";
      const failure = downloadFailure(job.diagnostics);
      job.message = failure.message;
      logDownloadFailure(job, code, failure.reason);
    }
    if (job.status === "failed") await removeJobFiles(job);
    job.diagnostics = "";
    job.cookiePath = null;
    activeJobs.delete(job.id);
}

async function startJob(kind, url) {
  if (shuttingDown) throw userError("El servicio se está reiniciando. Intentá nuevamente en unos minutos.", 503);
  if (kind !== "video" && kind !== "audio") throw userError("Elige video o audio.");
  if (activeJobs.size + pendingJobs >= MAX_CONCURRENT) throw userError("La app está ocupada. Espera a que termine una descarga y vuelve a intentar.", 429);
  pendingJobs += 1;
  try {
    const safeUrl = await validateUrl(url);
    const withCookies = cookieSession.enabled && usesYoutubeSession(safeUrl);
    if (cookieSession.enabled && new URL(safeUrl).protocol === "http:" && usesYoutubeSession(safeUrl.replace(/^http:/, "https:"))) throw userError("Usá un enlace HTTPS de YouTube.");
    const usedBytes = await totalTemporaryBytes();
    const reserve = MAX_OUTPUT_BYTES * pendingJobs + (withCookies ? MAX_COOKIE_BYTES : 0);
    if (usedBytes + reserve > MAX_TEMP_BYTES) throw userError("No hay espacio temporal disponible. Volvé a intentarlo en unos minutos.", 429);
    const id = randomUUID();
    const directory = path.join(TEMP_ROOT, id);
    await fsp.mkdir(directory, { recursive: false, mode: 0o700 });
    const job = {
      id, kind, directory, status: "queued", progress: null, etaSeconds: null,
      message: "Preparando la descarga…", diagnostics: "", createdAt: Date.now(), delivered: false
    };
    try {
      if (withCookies) job.cookiePath = await cookieSession.create(id, MAX_TEMP_BYTES - usedBytes - MAX_OUTPUT_BYTES * pendingJobs);
    } catch {
      await removeJobFiles(job);
      throw userError("La sesión del servidor no está disponible de forma segura. Intentá nuevamente más tarde.", 503);
    }
    if (shuttingDown) {
      await cookieSession.release(id); await removeJobFiles(job);
      throw userError("El servicio se está reiniciando. Intentá nuevamente en unos minutos.", 503);
    }
    jobs.set(id, job);
    runDownload(job, safeUrl);
    return job;
  } finally {
    pendingJobs -= 1;
  }
}

function filenameHeader(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function route(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname;
  if (applyCors(req, res)) return;

  if (req.method === "GET" && pathname === "/healthz") {
    return sendJson(res, 200, { status: "ok", activeDownloads: activeJobs.size, authRequired: AUTH_REQUIRED });
  }
  if (req.method === "POST" && pathname === "/api/jobs") {
    authorize(req, res);
    limitJobCreation(req, res);
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["kind", "url"].includes(key))) throw userError("La solicitud contiene campos no permitidos.");
    const job = await startJob(body.kind, body.url);
    return sendJson(res, 202, publicJob(job));
  }
  const match = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(file|ticket))?$/i);
  if (match) {
    const [, id, filePart] = match;
    const token = requestUrl.searchParams.get("ticket");
    if (req.method === "GET" && filePart === "file") {
      const ticket = tickets.get(token);
      if (!ticket || ticket.jobId !== id || Date.now() >= ticket.expiresAt) {
        if (ticket && Date.now() >= ticket.expiresAt) tickets.delete(token);
        throw userError("El permiso de descarga venció o ya fue usado. Solicitá otro desde la app.", 401);
      }
      tickets.delete(token);
    } else {
      authorize(req, res);
    }
    const job = jobs.get(id);
    if (!job) throw userError("Esa descarga ya no está disponible. Envía el enlace otra vez.", 404);
    if (req.method === "POST" && filePart === "ticket") {
      if (job.status !== "complete" || job.delivered || !job.outputPath) throw userError("El archivo todavía no está listo o ya fue descargado.", 409);
      let media;
      try { media = await openMedia(job, TEMP_ROOT, MAX_OUTPUT_BYTES); await media.file.close(); } catch {
        job.status = "failed";
        job.message = "El archivo temporal ya no está disponible. Prepará la descarga nuevamente.";
        await removeJobFiles(job);
        throw userError(job.message, 410);
      }
      if (job.delivered || job.status !== "complete") throw userError("El archivo ya no está disponible.", 410);
      for (const [existing, ticket] of tickets) if (ticket.jobId === id) tickets.delete(existing);
      const value = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + TICKET_TTL_MS;
      tickets.set(value, { jobId: id, expiresAt });
      return sendJson(res, 200, { downloadUrl: `/api/jobs/${id}/file?ticket=${value}`, expiresAt, filename: job.filename });
    }
    if (req.method === "GET" && !filePart) return sendJson(res, 200, publicJob(job));
    if (req.method === "DELETE" && !filePart) {
      if (job.child && job.status === "running") {
        job.status = "cancelled";
        job.message = "Descarga cancelada.";
        const child = job.child;
        signalDownload(child, "SIGTERM");
        job.egressSession?.close();
        job.killTimer = setTimeout(() => signalDownload(child, "SIGKILL"), 1500); job.killTimer.unref();
        await job.completion;
      } else {
        job.status = "cancelled";
        job.message = "Descarga cancelada.";
        await removeJobFiles(job);
      }
      return sendJson(res, 200, publicJob(job));
    }
    if (req.method === "GET" && filePart === "file") {
      if (job.status !== "complete" || job.delivered || !job.outputPath) throw userError("El archivo todavía no está listo o ya fue descargado.", 409);
      let media;
      try { media = await openMedia(job, TEMP_ROOT, MAX_OUTPUT_BYTES); } catch {
        await removeJobFiles(job);
        job.status = "failed";
        job.message = "El archivo temporal ya no está disponible.";
        throw userError(job.message, 410);
      }
      if (job.delivered || job.status !== "complete") { await media.file.close(); throw userError("El archivo ya no está disponible.", 410); }
      job.delivered = true;
      res.writeHead(200, {
        "Content-Type": job.kind === "audio" ? "audio/mpeg" : "video/mp4",
        "Content-Length": media.stat.size,
        "Content-Disposition": filenameHeader(job.filename),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      const stream = media.file.createReadStream({ start: 0, autoClose: true });
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      res.on("close", async () => {
        stream.destroy();
        await removeJobFiles(job);
        job.outputPath = null;
        job.status = res.writableFinished ? "delivered" : "failed";
        job.message = res.writableFinished ? "Archivo descargado." : "La entrega se interrumpió. Prepará la descarga nuevamente.";
      });
      return;
    }
  }
  throw userError("No se encontró esa página.", 404);
}

async function cleanStaleFiles() {
  await fsp.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(TEMP_ROOT, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(TEMP_ROOT, entry.name);
    if (entry.isDirectory()) await fsp.rm(target, { recursive: true, force: true });
    else await fsp.rm(target, { force: true });
  }));
}

function cleanExpiredJobs() {
  const now = Date.now();
  for (const [token, ticket] of tickets) if (now >= ticket.expiresAt) tickets.delete(token);
  for (const map of [authFailures, jobAttempts]) for (const [key, value] of map) if (now >= value.expiresAt) map.delete(key);
  for (const [id, job] of jobs) {
    if (!["running", "queued"].includes(job.status) && now - (job.completedAt || job.createdAt) > JOB_TTL_MS) {
      void removeJobFiles(job);
      jobs.delete(id);
    }
  }
}

function assertToolsAvailable() {
  if (process.platform !== "linux") throw new Error("The API download sandbox requires Linux. Run the backend with Docker.");
  const check = spawnSync(SANDBOX, ["--check"], { encoding: "utf8", timeout: 10000 });
  if (check.error || check.status !== 0) throw new Error(`Cannot install downloader network sandbox: ${check.stderr || check.error?.message || "unsupported host"}`);
  for (const [binary, args] of [[YTDLP, ["--version"]], [FFMPEG, ["-version"]], [JS_RUNTIME, ["--version"]]]) {
    const result = spawnSync(SANDBOX, [binary, ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Required server tool unavailable: ${path.basename(binary)}`);
  }
}

async function main() {
  await cookieSession.initialize();
  assertToolsAvailable();
  await cleanStaleFiles();
  egressProxy = await createEgressProxy(path.join(process.env.TMPDIR || os.tmpdir(), "video-audio-dl-proxy"), SOURCE_SESSION ? () => process.stderr.write('{"event":"proxy_failed","reason":"internal_proxy_error"}\n') : undefined);
  process.stdout.write("Downloader network sandbox and checked internal proxy ready\n");
  process.stdout.write("YouTube compatibility ready: local EJS, protected Node runtime, default clients\n");
  server = http.createServer((req, res) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    route(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      const status = Number.isInteger(error.status) ? error.status : 500;
      sendJson(res, status, { error: error.userMessage || "Ocurrió un error interno. Inténtalo nuevamente." });
      if (status >= 500) process.stderr.write(SOURCE_SESSION ? '{"event":"request_failed","reason":"internal_error"}\n' : `${error.stack || error}\n`);
    });
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.listen(PORT, HOST, () => process.stdout.write(`Download API listening on http://${HOST}:${PORT}\n`));
  const expiryTimer = setInterval(cleanExpiredJobs, 30000);
  expiryTimer.unref();
}

main().catch((error) => {
  process.stderr.write(SOURCE_SESSION ? '{"event":"startup_failed","reason":"configuration_or_runtime_invalid"}\n' : `${error.message}\n`);
  egressProxy?.close();
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server?.close();
    for (const job of jobs.values()) if (job.child) {
      const child = job.child;
      signalDownload(child, "SIGTERM");
      job.status = "cancelled"; job.egressSession?.close();
      job.killTimer = setTimeout(() => signalDownload(child, "SIGKILL"), 1500); job.killTimer.unref();
    }
    const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
    while (pendingJobs) await new Promise(resolve => setTimeout(resolve, 50));
    await Promise.allSettled([...jobs.values()].map(job => job.completion));
    await egressProxy?.close();
    try { await cookieSession.retryCleanup(); } catch { process.stderr.write('{"event":"shutdown_failed","reason":"cleanup_failed"}\n'); process.exitCode = 1; }
    clearTimeout(deadline);
    server?.closeAllConnections();
    if (!process.exitCode) process.exitCode = 0;
  });
}
