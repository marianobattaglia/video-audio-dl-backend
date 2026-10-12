"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { fail, normalizeMetadata } = require("./playlist-store");
const MAX_BYTES = 256 * 1024;
async function extractPreview({ url, host, root, cookieSession, withCookies, availableBytes, proxy, sandbox, downloader,
  tmpdir, stopProcessGroup, signalDownload, signal, timeout = 45000, classifyFailure, operations, start = 1 }) {
  const id = randomUUID(), directory = path.join(root, id);
  let session, cookiePath, timer, reason, stdout = Buffer.alloc(0), stderr = "", abortListener;
  const operation = { id, child: null, stop() { reason ||= "cancelled"; session?.close(); if (this.child) signalDownload(this.child, "SIGKILL"); } }; operations.add(operation);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    if (withCookies) cookiePath = await cookieSession.create(id, availableBytes);
    if (signal.aborted || reason) throw fail("La consulta fue cancelada.", 499);
    session = proxy.createSession();
    const args = ["--flat-playlist", "--dump-single-json", "--skip-download", "--lazy-playlist", "--playlist-items", `${start}:${start + 50}`, "--no-cache-dir", "--no-color"];
    if (cookiePath) args.push("--cookies", cookiePath);
    args.push(url);
    const child = spawn(sandbox, [downloader, ...args], { cwd: directory, shell: false, windowsHide: true, detached: true,
      stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: directory, TMPDIR: tmpdir,
        LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", APP_MEDIA_MODE: "playlist_preview", ...session.env } });
    operation.child = child;
    const stop = value => { reason ||= value; session.close(); signalDownload(child, "SIGKILL"); };
    operation.stop = () => stop("cancelled"); abortListener = operation.stop;
    signal.addEventListener("abort", abortListener, { once: true });
    timer = setTimeout(() => stop("timeout"), timeout); timer.unref();
    child.stdout.on("data", chunk => {
      if (stdout.length + chunk.length > MAX_BYTES) stop("too_large");
      else if (!reason) stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-12000); });
    let launchFailed = false; child.on("error", () => { launchFailed = true; });
    const code = await new Promise(resolve => child.once("close", resolve));
    await stopProcessGroup(child); operation.child = null;
    if (reason) throw fail(reason === "too_large" ? "La vista previa supera el límite permitido." : reason === "timeout" ? "La lista tardó demasiado en responder. Intentá nuevamente." : "La consulta fue cancelada.", reason === "cancelled" ? 499 : 422);
    if (launchFailed) throw fail("No se pudo iniciar la consulta de la lista.", 503);
    if (code !== 0) { const failure = classifyFailure(stderr); throw Object.assign(fail(failure.message, 422), { reason: failure.reason }); }
    let raw;
    try { raw = JSON.parse(stdout.toString("utf8")); } catch { throw fail("El sitio no devolvió una lista válida.", 422); }
    return normalizeMetadata(raw, host, start);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    session?.close();
    try {
      if (operation.child) await stopProcessGroup(operation.child);
      await cookieSession.release(id);
      await fs.rm(directory, { recursive: true, force: true });
    } catch {
      if (operation.child) cookieSession.unsafeProcesses = true;
      throw fail("El servicio no pudo completar la limpieza de la lista. Intentá nuevamente más tarde.", 503);
    } finally { stdout.fill(0); stderr = ""; operations.delete(operation); }
  }
}
module.exports = { extractPreview, MAX_BYTES };
