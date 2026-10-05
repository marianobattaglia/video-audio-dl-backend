"use strict";
// Test-process DNS injection only; no changes to the production network policy.
const dns = require("node:dns/promises");
const original = dns.lookup;
const cp = require("node:child_process");
const fs = require("node:fs");
for (const method of ["spawn", "spawnSync"]) {
  const launch = cp[method];
  cp[method] = (binary, args, options) => {
    if (args?.[0] === "/private-tests/fake-downloader.py") {
      args = ["/usr/bin/python3", ...args];
      if (method === "spawn" && args.at(-1).includes("v=spawn-error")) binary = "/synthetic-missing-executable";
    }
    return launch(binary, args, options);
  };
}
const io = require("node:fs/promises");
const remove = io.rm;
io.rm = async (target, ...args) => {
  if (String(target).includes("video-audio-dl-cookie-jars/") && fs.existsSync("/tmp/qualification-fail-cleanup")) throw new Error("synthetic-cleanup-error");
  return remove(target, ...args);
};
dns.lookup = async (hostname, options) => {
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(hostname)) return [{ address: "11.250.238.2", family: 4 }];
  return original(hostname, options);
};
