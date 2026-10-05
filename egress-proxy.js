"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { publicWebUrl, resolvePublicHost, sameAddress, isPublicIp } = require("./network-policy");

const HOP_HEADERS = new Set(["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

function cleanHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of (headers.connection || "").split(",")) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

async function createEgressProxy(directory, onError) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const socketPath = path.join(directory, `egress-${process.pid}-${randomBytes(6).toString("hex")}.sock`);
  if (Buffer.byteLength(socketPath) > 100) throw new Error("Internal proxy socket path is too long");
  const sessions = new Map();
  const sockets = new Set();
  let closing = false;

  function authenticate(req) {
    const session = sessions.get(req.headers["proxy-authorization"]);
    if (!session?.active) throw new Error("Internal proxy access denied");
    return session;
  }

  function track(session, socket) {
    session.sockets.add(socket);
    socket.once("close", () => session.sockets.delete(socket));
  }

  async function connect(session, url) {
    const selected = await resolvePublicHost(url.hostname);
    if (!session.active || closing) throw new Error("Download session ended");
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: selected.address, family: selected.family, port: url.protocol === "https:" ? 443 : 80 });
      track(session, socket);
      socket.setTimeout(30000, () => socket.destroy(new Error("Upstream timeout")));
      const failed = (error) => reject(error);
      socket.once("error", failed);
      socket.once("close", () => reject(new Error("Upstream closed before connecting")));
      socket.once("connect", () => {
        if (!session.active || !sameAddress(selected.address, socket.remoteAddress) || !isPublicIp(socket.remoteAddress)) {
          socket.destroy(new Error("Unexpected destination"));
          return;
        }
        socket.removeListener("error", failed);
        socket.on("error", () => {});
        resolve(socket);
      });
    });
  }

  const proxy = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    let upstream;
    let agent;
    const stop = () => { upstream?.destroy(); agent?.destroy(); };
    req.on("aborted", stop);
    req.on("error", stop);
    res.on("close", stop);
    (async () => {
      const session = authenticate(req);
      track(session, req.socket);
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method) || req.headers.upgrade || req.headers.expect) {
        throw new Error("Unsupported proxy request");
      }
      const url = publicWebUrl(req.url);
      if (url.protocol !== "http:") throw new Error("HTTPS requires CONNECT");
      const socket = await connect(session, url);
      if (req.aborted || res.destroyed) { socket.destroy(); return; }
      const headers = cleanHeaders(req.headers);
      if (req.headers["transfer-encoding"]) delete headers["content-length"];
      headers.host = url.host;
      headers.connection = "close";
      agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      upstream = http.request({ hostname: url.hostname, port: 80, method: req.method, path: url.pathname + url.search, headers, agent }, (response) => {
        res.writeHead(response.statusCode, { ...cleanHeaders(response.headers), connection: "close" });
        response.on("error", () => res.destroy());
        response.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent && !res.destroyed) res.writeHead(502).end("Download connection failed");
        else res.destroy();
      });
      let bodyBytes = 0;
      req.on("data", (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > 1024 * 1024) { stop(); req.destroy(); }
      });
      req.pipe(upstream);
    })().catch(() => {
      stop();
      if (!res.headersSent && !res.destroyed) res.writeHead(403, { connection: "close" }).end("Download destination rejected");
      else res.destroy();
    });
  });

  proxy.on("connect", (req, client, head) => {
    let upstream;
    const stop = () => upstream?.destroy();
    client.on("error", stop);
    client.on("close", stop);
    (async () => {
      const session = authenticate(req);
      track(session, client);
      const url = publicWebUrl(`https://${req.url}`);
      if (url.pathname !== "/" || url.search || url.hash || req.url !== `${url.hostname}:443`) {
        throw new Error("Invalid CONNECT authority");
      }
      upstream = await connect(session, url);
      if (client.destroyed) { upstream.destroy(); return; }
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => { if (!upstream.readableEnded) client.destroy(); });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    })().catch(() => {
      stop();
      if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.setTimeout(30000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("clientError", (_, socket) => socket.destroy());
  proxy.on("upgrade", (_, socket) => socket.destroy());
  proxy.headersTimeout = 15000;
  proxy.requestTimeout = 30000;
  proxy.maxConnections = 32;
  try {
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(socketPath, () => { proxy.removeListener("error", reject); resolve(); });
    });
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
    await fs.unlink(socketPath).catch(() => {});
    throw error;
  }
  proxy.on("error", (error) => { if (onError) onError(); else process.stderr.write(`Internal proxy error: ${error.code || "unknown"}\n`); });

  return {
    createSession() {
      if (closing) throw new Error("Internal proxy is closing");
      const token = randomBytes(32).toString("hex");
      const authorization = `Basic ${Buffer.from(`download:${token}`).toString("base64")}`;
      const session = { active: true, sockets: new Set() };
      sessions.set(authorization, session);
      return {
        env: { APP_EGRESS_SOCKET: socketPath, APP_EGRESS_TOKEN: token },
        close() {
          session.active = false;
          sessions.delete(authorization);
          for (const socket of session.sockets) socket.destroy();
          session.sockets.clear();
        }
      };
    },
    close() {
      closing = true;
      for (const session of sessions.values()) {
        session.active = false;
        for (const socket of session.sockets) socket.destroy();
      }
      sessions.clear();
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => proxy.close(async () => { await fs.unlink(socketPath).catch(() => {}); resolve(); }));
    }
  };
}

module.exports = { createEgressProxy };
