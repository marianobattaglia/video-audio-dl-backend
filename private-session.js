"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const MAX_COOKIE_BYTES = 64 * 1024;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
function safeError(code) { const error = new Error(code); error.code = code; return error; }
function within(parent, target) { const relative = path.relative(parent, target); return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }
function youtubeDomain(value) { const host = value.replace(/^\./, "").toLowerCase(); return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*youtube\.com$/.test(host); }
function usesYoutubeSession(value) { const url = new URL(value); return url.protocol === "https:" && YOUTUBE_HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === "443"); }
function normalizeCookies(buffer) {
  if (!buffer.length || buffer.length > MAX_COOKIE_BYTES) throw safeError("E_COOKIE_FORMAT");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { throw safeError("E_COOKIE_FORMAT"); }
  if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)(?:\r?\n|$)/.test(text)) throw safeError("E_COOKIE_FORMAT");
  const rows = [];
  for (let line of text.split(/\r?\n/)) {
    const httpOnly = line.startsWith("#HttpOnly_");
    if (httpOnly) line = line.slice(10);
    else if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length !== 7) throw safeError("E_COOKIE_FORMAT");
    const [domain, scope, cookiePath, secure, expires, name, value] = fields;
    if (!youtubeDomain(domain) || !["TRUE", "FALSE"].includes(scope) || (domain.startsWith(".") !== (scope === "TRUE")) || !["TRUE", "FALSE"].includes(secure)
      || !cookiePath.startsWith("/") || /[\u0000-\u0020\u007f]/.test(cookiePath)
      || !/^(?:0|[1-9][0-9]*)$/.test(expires) || !Number.isSafeInteger(Number(expires))
      || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/.test(value)) throw safeError("E_COOKIE_FORMAT");
    rows.push(`${httpOnly ? "#HttpOnly_" : ""}${domain.toLowerCase()}\t${scope}\t${cookiePath}\tTRUE\t${expires}\t${name}\t${value}`);
  }
  if (!rows.length) throw safeError("E_COOKIE_FORMAT");
  const normalized = Buffer.from(`# Netscape HTTP Cookie File\n${rows.join("\n")}\n`);
  if (normalized.length > MAX_COOKIE_BYTES) throw safeError("E_COOKIE_FORMAT");
  return normalized;
}
async function privateDirectory(directory, io = fs) {
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await io.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await io.realpath(directory) !== directory) throw safeError("E_PRIVATE_DIRECTORY");
  await io.chmod(directory, 0o700);
}
class PrivateSession {
  constructor({ source = "", privateRoot, mediaRoot, repositoryRoot, io = fs }) {
    this.source = source ? path.resolve(source) : "";
    this.root = path.resolve(privateRoot);
    this.mediaRoot = path.resolve(mediaRoot);
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.io = io;
    this.copies = new Map();
    this.failedCleanup = new Set();
    this.unsafeProcesses = false;
    if (within(this.mediaRoot, this.root) || within(this.root, this.mediaRoot) || within(this.mediaRoot, this.repositoryRoot)) throw safeError("E_PRIVATE_DIRECTORY");
  }
  get enabled() { return Boolean(this.source); }
  checkSourceLocation(location) {
    if ([this.repositoryRoot, this.mediaRoot, this.root].some(parent => within(parent, location))) throw safeError("E_COOKIE_LOCATION");
  }
  async read() {
    let handle;
    try {
      this.checkSourceLocation(this.source);
      const resolved = await this.io.realpath(this.source);
      this.checkSourceLocation(resolved);
      handle = await this.io.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!before.isFile() || before.size <= 0 || before.size > MAX_COOKIE_BYTES) throw safeError("E_COOKIE_FORMAT");
      const buffer = Buffer.alloc(MAX_COOKIE_BYTES + 1);
      try {
        let length = 0;
        while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
        const after = await handle.stat();
        if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw safeError("E_COOKIE_CHANGED");
        return normalizeCookies(buffer.subarray(0, length));
      } finally { buffer.fill(0); }
    } catch (error) {
      const failure = safeError(["E_COOKIE_LOCATION", "E_COOKIE_FORMAT", "E_COOKIE_CHANGED"].includes(error.code) ? error.code : "E_COOKIE_UNAVAILABLE");
      // Preserve only a known filesystem code, never its path-bearing message.
      if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) failure.ioCode = error.code;
      throw failure;
    }
    finally { await handle?.close(); }
  }
  async initialize() {
    // A cleanup tree must have an unambiguous canonical location before source validation.
    await privateDirectory(this.mediaRoot, this.io);
    // Validate the source before any cleanup, even if its location is unsafe.
    if (this.enabled) { const contents = await this.read(); contents.fill(0); }
    await privateDirectory(this.root, this.io);
    for (const entry of await this.io.readdir(this.root)) await this.io.rm(path.join(this.root, entry), { recursive: true, force: true });
  }
  async retryCleanup() {
    if (this.unsafeProcesses) throw safeError("E_COOKIE_CLEANUP");
    for (const directory of this.failedCleanup) {
      try { await this.io.rm(directory, { recursive: true, force: true }); this.failedCleanup.delete(directory); }
      catch { throw safeError("E_COOKIE_CLEANUP"); }
    }
  }
  async create(id, availableBytes) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw safeError("E_COOKIE_COPY");
    if (this.copies.has(id)) throw safeError("E_COOKIE_COPY");
    await this.retryCleanup();
    const contents = await this.read();
    const directory = path.join(this.root, id);
    try {
      if (contents.length > availableBytes) throw safeError("E_COOKIE_SPACE");
      await this.io.mkdir(directory, { mode: 0o700 });
      this.copies.set(id, directory);
      const filename = path.join(directory, "session.txt");
      await this.io.writeFile(filename, contents, { flag: "wx", mode: 0o600 });
      return filename;
    } catch (error) {
      if (this.copies.has(id)) await this.release(id);
      throw safeError(error.code === "E_COOKIE_SPACE" ? error.code : "E_COOKIE_COPY");
    } finally { contents.fill(0); }
  }
  async release(id) {
    const directory = this.copies.get(id);
    if (!directory) return;
    try { await this.io.rm(directory, { recursive: true, force: true }); this.copies.delete(id); }
    catch { this.failedCleanup.add(directory); this.copies.delete(id); throw safeError("E_COOKIE_CLEANUP"); }
  }
}
module.exports = { PrivateSession, MAX_COOKIE_BYTES, normalizeCookies, usesYoutubeSession, within };
