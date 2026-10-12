"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { within } = require("./private-session");

// Independent validator: only an immutable, previously worker-validated ZIP.
async function openArchive(record, root, maxBytes, { signal } = {}) {
  let file;
  try {
    const target = path.join(root, record.id, "archive.zip");
    if (signal?.aborted) throw new Error();
    if (!/^[0-9a-f-]{36}$/i.test(record.id) || !within(root, target)) throw new Error();
    for (const value of [root, path.dirname(target), target]) {
      const stat = await fs.lstat(value);
      if (stat.isSymbolicLink() || await fs.realpath(value) !== value || (value === target ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error();
    }
    file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat(), identity = record.identity;
    if (!identity || !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || stat.size !== identity.size || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error();
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < stat.size;) {
      if (signal?.aborted) throw new Error();
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytesRead) throw new Error();
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (hash.digest("hex") !== record.sha256) throw new Error();
    const after = await file.stat();
    if (signal?.aborted || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw new Error();
    return { file, stat, target };
  } catch { await file?.close(); throw new Error("E_ARCHIVE_INVALID"); }
}
module.exports = { openArchive };
