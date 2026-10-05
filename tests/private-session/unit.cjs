"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PrivateSession, normalizeCookies, usesYoutubeSession } = require("/app/private-session");
const { openMedia } = require("/app/media-output");
module.exports = async test => {
  const root = "/tmp/module-fixtures", source = `${root}/source.txt`, mediaRoot = `${root}/media`, privateRoot = `${root}/jars`, repositoryRoot = "/app";
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(mediaRoot, { recursive: true });
  const body = `# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tFALSE\t0\tSID\tfixture-${randomUUID()}\nwww.youtube.com\tFALSE\t/watch\tFALSE\t4000000000\tHOST\thost-only\n`;
  await fs.writeFile(source, body);
  const manager = new PrivateSession({ source, privateRoot, mediaRoot, repositoryRoot });
  await test("Netscape, HttpOnly, Secure, host-only/path/expiration normalization", async () => {
    const normalized = normalizeCookies(Buffer.from(body)).toString();
    assert(normalized.includes("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0"));
    assert(normalized.includes("www.youtube.com\tFALSE\t/watch\tTRUE\t4000000000"));
    for (const domain of ["youtube.com.evil.test", ".google.com", "youtu.be", "..youtube.com", "-x.youtube.com"]) assert.throws(() => normalizeCookies(Buffer.from(body.replace(".youtube.com", domain))), /E_COOKIE_FORMAT/);
    for (const text of ["", "{}", "# Netscape HTTP Cookie File\n", body.replace("\t0\tSID", "\t-1\tSID"), body.replace("\tSID\t", "\tBAD NAME\t"), body.replace("\t/watch\t", "\tinvalid\t"), body.replace(".youtube.com\tTRUE", ".youtube.com\tFALSE"), body + "x".repeat(65536)]) assert.throws(() => normalizeCookies(Buffer.from(text)), /E_COOKIE_FORMAT/);
  });
  await test("Initial session URL selection rejects HTTP, lookalikes and other sites", () => {
    for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]) assert.equal(usesYoutubeSession(`https://${host}/watch`), true);
    for (const url of ["http://youtube.com/watch", "https://youtube.com.evil.test/watch", "https://sub.youtube.com/watch", "https://example.com/watch", "https://youtube.com:8443/", "https://user@youtube.com/"]) assert.equal(usesYoutubeSession(url), false);
  });
  await test("Source location and regular-file/size/readability checks are fail closed", async () => {
    for (const unsafe of [`${mediaRoot}/source.txt`, `${privateRoot}/source.txt`, "/app/source.txt"]) {
      const bad = new PrivateSession({ source: unsafe, privateRoot, mediaRoot, repositoryRoot });
      await assert.rejects(bad.read(), /E_COOKIE_LOCATION/);
    }
    await fs.mkdir(`${root}/directory`);
    for (const candidate of [`${root}/missing`, `${root}/directory`]) await assert.rejects(new PrivateSession({ source: candidate, privateRoot, mediaRoot, repositoryRoot }).read(), /E_COOKIE_/);
    await fs.writeFile(`${root}/huge`, Buffer.alloc(65537));
    await assert.rejects(new PrivateSession({ source: `${root}/huge`, privateRoot, mediaRoot, repositoryRoot }).read(), /E_COOKIE_FORMAT/);
    await fs.writeFile(`${root}/unreadable`, body, { mode: 0o000 });
    await assert.rejects(new PrivateSession({ source: `${root}/unreadable`, privateRoot, mediaRoot, repositoryRoot }).read(), /E_COOKIE_UNAVAILABLE/);
    await fs.symlink(`${mediaRoot}/secret`, `${root}/link`); await fs.writeFile(`${mediaRoot}/secret`, body);
    await assert.rejects(new PrivateSession({ source: `${root}/link`, privateRoot, mediaRoot, repositoryRoot }).read(), /E_COOKIE_LOCATION/);
  });
  await test("An aliased media cleanup tree is rejected before touching the source", async () => {
    const alias = `${root}/media-alias`; await fs.symlink(root, alias);
    const unsafe = new PrivateSession({ source, privateRoot, mediaRoot: alias, repositoryRoot });
    await assert.rejects(unsafe.initialize(), /E_PRIVATE_DIRECTORY/);
    assert.equal(await fs.readFile(source, "utf8"), body);
  });
  await test("Private copies are distinct, exclusive, 0700/0600 and preserve source", async () => {
    await manager.initialize();
    const one = randomUUID(), two = randomUUID();
    const first = await manager.create(one, 65536), second = await manager.create(two, 65536);
    assert.notEqual(first, second);
    assert.equal((await fs.stat(path.dirname(first))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(first)).mode & 0o777, 0o600);
    await assert.rejects(manager.create(one, 65536), /E_COOKIE_COPY/);
    await fs.writeFile(first, "synthetic-updated-copy");
    assert.equal(await fs.readFile(source, "utf8"), body);
    await manager.release(one); await manager.release(one); await manager.release(two);
  });
  await test("Copy budget, invalid changed source and descriptor mutation fail safely", async () => {
    await assert.rejects(manager.create(randomUUID(), 1), /E_COOKIE_SPACE/);
    await fs.writeFile(source, "invalid-private-data");
    await assert.rejects(manager.create(randomUUID(), 65536), /E_COOKIE_FORMAT/);
    await fs.writeFile(source, body);
    const io = { ...fs, async open(...args) { const fd = await fs.open(...args); let stats = 0; const original = fd.stat.bind(fd); fd.stat = async () => { const value = await original(); if (++stats === 2) value.mtimeMs += 1; return value; }; return fd; } };
    await assert.rejects(new PrivateSession({ source, privateRoot, mediaRoot, repositoryRoot, io }).read(), /E_COOKIE_CHANGED/);
  });
  await test("Injected deletion failure blocks new cookie jobs and retries safely", async () => {
    let fail = false;
    const io = { ...fs, async rm(...args) { if (fail) throw new Error("synthetic-private-error"); return fs.rm(...args); } };
    const guarded = new PrivateSession({ source, privateRoot: `${root}/failure-jars`, mediaRoot, repositoryRoot, io });
    await guarded.initialize(); const id = randomUUID(); await guarded.create(id, 65536); fail = true;
    await assert.rejects(guarded.release(id), /E_COOKIE_CLEANUP/);
    await assert.rejects(guarded.create(randomUUID(), 65536), /E_COOKIE_CLEANUP/);
    fail = false; const retry = randomUUID(); await guarded.create(retry, 65536); await guarded.release(retry);
    assert.deepEqual(await fs.readdir(guarded.root), []);
  });
  await test("Startup sweeps orphan copies and preserves the provisioned source", async () => {
    const orphan = path.join(privateRoot, randomUUID()); await fs.mkdir(orphan); await fs.writeFile(path.join(orphan, "session.txt"), "synthetic-orphan");
    await manager.initialize(); assert.deepEqual(await fs.readdir(privateRoot), []); assert.equal(await fs.readFile(source, "utf8"), body);
  });
  const id = randomUUID(), directory = path.join(mediaRoot, id), target = path.join(directory, "media.mp4");
  await fs.mkdir(directory); const bytes = Buffer.from("0000ftypmp42synthetic-media"); await fs.writeFile(target, bytes);
  const job = { id, directory, outputPath: target, kind: "video" };
  await test("Media descriptor validates type, size and identity", async () => {
    const opened = await openMedia(job, mediaRoot, 1024); await opened.file.close();
    const original = { ...job, outputIdentity: opened.identity };
    await fs.rename(target, `${target}.old`); await fs.writeFile(target, bytes);
    await assert.rejects(openMedia(original, mediaRoot, 1024), /E_MEDIA_INVALID/);
  });
  await test("Media rejects traversal, private paths, wrong extension and invalid header", async () => {
    for (const outputPath of [source, `${directory}/../source.mp4`, `${directory}/session.txt`]) await assert.rejects(openMedia({ ...job, outputPath }, mediaRoot, 1024), /E_MEDIA_INVALID/);
    await fs.writeFile(target, body); await assert.rejects(openMedia(job, mediaRoot, 1024), /E_MEDIA_INVALID/); await fs.writeFile(target, bytes);
  });
  await test("Media rejects symbolic links, hard links and linked directory components", async () => {
    await fs.unlink(target); await fs.symlink(source, target); await assert.rejects(openMedia(job, mediaRoot, 1024), /E_MEDIA_INVALID/);
    await fs.unlink(target); await fs.link(source, target); await assert.rejects(openMedia(job, mediaRoot, 1024), /E_MEDIA_INVALID/);
    await fs.unlink(target); await fs.writeFile(target, bytes);
    const linkedId = randomUUID(); await fs.symlink(directory, path.join(mediaRoot, linkedId));
    await assert.rejects(openMedia({ ...job, id: linkedId, directory: path.join(mediaRoot, linkedId), outputPath: path.join(mediaRoot, linkedId, "media.mp4") }, mediaRoot, 1024), /E_MEDIA_INVALID/);
  });
  await test("Validated descriptor cannot be redirected to a source secret by path replacement", async () => {
    const opened = await openMedia(job, mediaRoot, 1024); await fs.unlink(target); await fs.symlink(source, target);
    const received = Buffer.alloc(bytes.length); await opened.file.read(received, 0, received.length, 0); await opened.file.close();
    assert.deepEqual(received, bytes); assert.equal(await fs.readFile(source, "utf8"), body);
  });
};
