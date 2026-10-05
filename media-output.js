"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { within } = require("./private-session");
async function openMedia(job, mediaRoot, maxBytes, { io = fs } = {}) {
  let file;
  try {
    const expected = path.join(mediaRoot, job.id);
    const target = path.resolve(job.outputPath || "");
    if (job.directory !== expected || !within(expected, target) || target === expected || path.extname(target).toLowerCase() !== (job.kind === "audio" ? ".mp3" : ".mp4")) throw new Error();
    for (let current = target; ; current = path.dirname(current)) {
      const entry = await io.lstat(current);
      if (entry.isSymbolicLink() || await io.realpath(current) !== current) throw new Error();
      if (current === target ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory()) throw new Error();
      if (current === mediaRoot) break;
      if (!within(mediaRoot, current)) throw new Error();
    }
    const before = await io.lstat(target);
    file = await io.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 8 || stat.size > maxBytes || before.ino !== stat.ino || before.dev !== stat.dev) throw new Error();
    if (job.outputIdentity && (job.outputIdentity.ino !== stat.ino || job.outputIdentity.dev !== stat.dev || job.outputIdentity.size !== stat.size)) throw new Error();
    if (await io.realpath(target) !== target) throw new Error();
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const valid = job.kind === "video" ? bytesRead >= 12 && header.toString("ascii", 4, 8) === "ftyp" : header.toString("ascii", 0, 3) === "ID3" || header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
    if (!valid) throw new Error();
    return { file, stat, target, identity: { ino: stat.ino, dev: stat.dev, size: stat.size } };
  } catch { await file?.close(); throw new Error("E_MEDIA_INVALID"); }
}
module.exports = { openMedia };
