"use strict";
// The apparently public IP is confined to Docker's internal test network.
// These generated media and certificates never contain personal data.
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
fs.mkdirSync("/tmp/media", { recursive: true });
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", "-y", "/tmp/media/media.mp4"]);
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/media/key.pem", "-out", "/fixtures/ca-certificates.crt", "-days", "1", "-subj", "/CN=fixture.test", "-addext", "subjectAltName=DNS:fixture.test"], { stdio: "ignore" });
const media = fs.readFileSync("/tmp/media/media.mp4");
const largeMedia = Buffer.concat([media, Buffer.alloc(4 * 1024 * 1024 - media.length)]);
let requests = 0;
function handle(req, res) {
  requests++;
  if (req.url === "/health") return res.end("ready");
  if (req.url === "/metrics") return res.end(JSON.stringify({ requests, bytes: media.length }));
  if (req.url === "/redirect-private.mp4") { res.writeHead(302, { Location: "http://127.0.0.1/private-sentinel" }); return res.end(); }
  if (req.url === "/redirect.mp4") { res.writeHead(302, { Location: "http://fixture.test/media.mp4" }); return res.end(); }
  if (req.url === "/large.mp4") { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": largeMedia.length }); return res.end(req.method === "HEAD" ? undefined : largeMedia); }
  if (req.url === "/grow.mp4") {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    if (req.method === "HEAD") return res.end();
    res.write(media);
    const interval = setInterval(() => res.write(Buffer.alloc(128 * 1024)), 200);
    res.on("close", () => clearInterval(interval));
    return;
  }
  const slow = req.url === "/slow.mp4";
  if (req.url !== "/media.mp4" && !slow) { res.writeHead(404); return res.end(); }
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
  const body = media.subarray(start, end + 1);
  res.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Content-Length": body.length, "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}) });
  if (req.method === "HEAD") return res.end();
  if (!slow) return res.end(body);
  res.write(body.subarray(0, 2048));
  const timer = setTimeout(() => res.end(body.subarray(2048)), 45000);
  res.on("close", () => clearTimeout(timer));
}
http.createServer(handle).listen(80, "0.0.0.0");
https.createServer({ key: fs.readFileSync("/tmp/media/key.pem"), cert: fs.readFileSync("/fixtures/ca-certificates.crt") }, handle).listen(443, "0.0.0.0");
console.log(JSON.stringify({ fixture: "ready", mediaBytes: media.length, network: "Docker internal only" }));
