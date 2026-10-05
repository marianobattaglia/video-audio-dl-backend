"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns/promises");
const events = require("node:events");
const fs = require("node:fs/promises");
const { isPublicIp, publicWebUrl, resolvePublicHost, sameAddress } = require("/app/network-policy");
const { createEgressProxy } = require("/app/egress-proxy");
const blocked = ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8", "2001:db8::1", "2002::1", "64:ff9b::1"];
function proxyRequest(socketPath, target, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: "GET", path: target, headers: authorization ? { "Proxy-Authorization": authorization } : {}, timeout: 6000 }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("proxy timeout"))); req.end();
  });
}
module.exports = async function network(test) {
  await test("IP and URL policy", async () => {
    for (const ip of blocked) assert.equal(isPublicIp(ip), false, ip);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicIp(ip), true, ip);
    for (const url of ["file:///etc/passwd", "ftp://fixture.test/a", "http://fixture.test:8080", "https://user:pass@fixture.test/"]) assert.throws(() => publicWebUrl(url));
    assert(sameAddress("8.8.8.8", "::ffff:8.8.8.8"));
  });
  await test("DNS rejects every nonpublic or mixed answer", async () => {
    const original = dns.lookup;
    try {
      for (const records of [[], [{ address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "192.168.1.1", family: 4 }], [{ address: "::ffff:8.8.8.8", family: 6 }]]) {
        dns.lookup = async () => records;
        await assert.rejects(resolvePublicHost("controlled.test"));
      }
    } finally { dns.lookup = original; }
  });
  const proxy = await createEgressProxy("/tmp/yt-dlp/qualification-proxy");
  const session = proxy.createSession();
  const socketPath = session.env.APP_EGRESS_SOCKET;
  const authorization = `Basic ${Buffer.from(`download:${session.env.APP_EGRESS_TOKEN}`).toString("base64")}`;
  try {
    await test("Unix proxy permissions and missing authorization", async () => {
      assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
      assert.equal((await fs.stat("/tmp/yt-dlp/qualification-proxy")).mode & 0o777, 0o700);
      assert.equal((await proxyRequest(socketPath, "http://fixture.test/health")).status, 403);
    });
    await test("Proxy blocks private literal and mixed DNS before connecting", async () => {
      for (const url of ["http://127.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://mixed.test/"]) assert.equal((await proxyRequest(socketPath, url, authorization)).status, 403, url);
    });
    await test("Proxy forwards a controlled public-classified HTTP destination", async () => {
      assert.equal((await proxyRequest(socketPath, "http://fixture.test/health", authorization)).status, 200);
    });
    await test("DNS pinning and mismatched effective peer (injected transport)", async () => {
      const originalLookup = dns.lookup, originalConnect = net.connect;
      let lookups = 0, selected;
      try {
        dns.lookup = async () => { lookups++; return [{ address: "8.8.8.8", family: 4 }]; };
        net.connect = options => {
          selected = options;
          const socket = new events.EventEmitter();
          socket.remoteAddress = "127.0.0.1";
          socket.setTimeout = () => socket;
          socket.destroy = error => { if (error) socket.emit("error", error); socket.emit("close"); };
          setImmediate(() => socket.emit("connect"));
          return socket;
        };
        assert.equal((await proxyRequest(socketPath, "http://rebind.test/", authorization)).status, 403);
        assert.equal(lookups, 1);
        assert.equal(selected.host, "8.8.8.8");
      } finally { dns.lookup = originalLookup; net.connect = originalConnect; }
    });
    await test("Revoking a proxy session closes its tunnel and prevents reuse", async () => {
      const socket = net.connect({ path: socketPath });
      await events.once(socket, "connect");
      socket.write(`CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test:443\r\nProxy-Authorization: ${authorization}\r\n\r\n`);
      const [chunk] = await events.once(socket, "data");
      assert.match(chunk.toString(), /200 Connection Established/);
      const closed = events.once(socket, "close");
      session.close();
      await closed;
      assert.equal((await proxyRequest(socketPath, "http://fixture.test/health", authorization)).status, 403);
    });
  } finally { session.close(); await proxy.close(); }
};
