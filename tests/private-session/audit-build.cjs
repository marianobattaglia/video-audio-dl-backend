"use strict";
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const backend = path.resolve(__dirname, '../..');
const frontend = path.resolve(backend, '../video-audio-dl-frontend');
const docker = process.argv[2] || 'docker';
const temporaryFiles = [];
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr?.slice(-1500));
  return result.stdout;
}
async function contents(directory) {
  let result = '';
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    result += entry.isDirectory() ? await contents(target) : await fs.readFile(target, 'utf8');
  }
  return result;
}
(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'video-audio-dl-build-audit-'));
  const sentinel = `synthetic-cookie-${randomUUID()}`, key = `synthetic-access-${randomUUID()}`;
  const saved = { API_BASE_URL: process.env.API_BASE_URL, ACCESS_CREDENTIAL: process.env.ACCESS_CREDENTIAL, YOUTUBE_COOKIES_FILE: process.env.YOUTUBE_COOKIES_FILE };
  try {
    const filename = `qualification-cookies-${randomUUID()}.txt`, envName = `.env.qualification-${randomUUID()}`;
    for (const repository of [backend, frontend]) {
      for (const name of [filename, envName]) {
        const target = path.join(repository, name);
        await fs.writeFile(target, sentinel, { flag: 'wx' }); temporaryFiles.push(target);
        run('git', ['-c', `safe.directory=${repository.replaceAll('\\', '/')}`, '-C', repository, 'check-ignore', '--', name]);
      }
      const tracked = run('git', ['-c', `safe.directory=${repository.replaceAll('\\', '/')}`, '-C', repository, 'ls-files']).trim().split(/\r?\n/);
      assert(!tracked.includes(filename) && !tracked.includes(envName));
      for (const name of tracked) {
        const file = await fs.readFile(path.join(repository, name)).catch(() => Buffer.alloc(0));
        assert(!file.includes(Buffer.from(sentinel)) && !file.includes(Buffer.from(key)));
      }
    }
    await fs.writeFile(path.join(temporary, 'markers.json'), JSON.stringify([sentinel, key]));
    await fs.writeFile(path.join(temporary, 'Dockerfile'), 'FROM scratch\nCOPY . /context/\n');
    run(docker, ['build', '-t', 'video-audio-dl-backend:private-session', '-t', 'video-audio-dl-backend:local-qualification', '.'], { cwd: backend });
    run(docker, ['build', '-f', path.join(temporary, 'Dockerfile'), '-t', 'video-audio-dl-backend:context-audit', '.'], { cwd: backend });
    run(docker, ['image', 'save', '-o', path.join(temporary, 'application.tar'), 'video-audio-dl-backend:private-session']);
    run(docker, ['image', 'save', '-o', path.join(temporary, 'context.tar'), 'video-audio-dl-backend:context-audit']);
    const layers = JSON.parse(run(docker, ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--entrypoint', 'python3', '-v', `${temporary}:/audit:ro`, '-v', `${__dirname}:/private-tests:ro`, 'video-audio-dl-backend:private-session', '/private-tests/audit-layers.py']));
    const { build } = await import(pathToFileURL(path.join(frontend, 'scripts/build.mjs')));
    process.env.ACCESS_CREDENTIAL = key; process.env.YOUTUBE_COOKIES_FILE = `/external/${filename}`;
    process.env.API_BASE_URL = 'https://api.ficticia.example'; await build();
    const output = await contents(path.join(frontend, 'dist'));
    for (const marker of [sentinel, key, process.env.YOUTUBE_COOKIES_FILE]) assert(!output.includes(marker));
    const config = await fs.readFile(path.join(frontend, 'dist/config.js'), 'utf8');
    assert.match(config, /apiBaseUrl/); assert(!config.includes('ACCESS_CREDENTIAL'));
    const html = await fs.readFile(path.join(frontend, 'dist/index.html'), 'utf8');
    assert(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
    assert(html.includes('https://api.ficticia.example')); assert(!/<script[^>]+src="https?:/.test(html));
    process.env.API_BASE_URL = 'http://localhost:3000'; await assert.rejects(build(), /HTTPS/); await build({ local: true });
    process.env.API_BASE_URL = 'http://example.com'; await assert.rejects(build({ local: true }), /loopback/);
    console.log(JSON.stringify({ status: 'pass', trackedAndIgnored: true, layers, frontendPublicOnly: true, cspBeforeScripts: true, productionHttpsRequired: true, localLoopbackRequired: true }));
  } finally {
    // Only exact files created with wx and our own mkdtemp directory are removed.
    for (const filename of temporaryFiles) await fs.unlink(filename);
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    const { build } = await import(pathToFileURL(path.join(frontend, 'scripts/build.mjs')));
    const api = process.env.API_BASE_URL; process.env.API_BASE_URL = 'http://localhost:3000'; await build({ local: true });
    if (api === undefined) delete process.env.API_BASE_URL; else process.env.API_BASE_URL = api;
    assert(path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('video-audio-dl-build-audit-'));
    await fs.rm(temporary, { recursive: true, force: true });
    run(docker, ['image', 'rm', 'video-audio-dl-backend:context-audit']);
  }
})().catch(() => { console.error('Synthetic build audit failed; inspect locally without publishing credentials.'); process.exitCode = 1; });
