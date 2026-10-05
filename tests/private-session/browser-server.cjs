"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const frontend = path.resolve(__dirname, "../../../video-audio-dl-frontend");
const files = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/app.js", "app.js"], ["/styles.css", "styles.css"], ["/config.js", "config.js"]]);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
(async () => {
  const vercel = JSON.parse(await fs.readFile(path.join(frontend, "vercel.json"), "utf8"));
  const headers = Object.fromEntries(vercel.headers[0].headers.map(header => [header.key, header.value]));
  const html = await fs.readFile(path.join(frontend, "dist/index.html"), "utf8");
  const policy = html.match(/<meta http-equiv="Content-Security-Policy"[^>]+>/)[0];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/probe-allowed") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"status":"ok"}'); return; }
    if (pathname === "/probe-csp") { res.writeHead(200, { ...headers, "Content-Type": "text/html" }); res.end(`<!doctype html><html><head><meta charset="utf-8">${policy}<script src="/probe.js" defer></script></head><body><button id="probe">Probar conexiones CSP</button><p id="allowed">Pendiente</p><p id="denied">Pendiente</p><p id="violation">Pendiente</p></body></html>`); return; }
    if (pathname === "/probe.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(`document.addEventListener('securitypolicyviolation', e=>{if(e.effectiveDirective==='connect-src')document.querySelector('#violation').textContent='Violación connect-src comprobada';});document.querySelector('#probe').addEventListener('click', async()=>{const result=await fetch('/probe-allowed');document.querySelector('#allowed').textContent=result.ok?'Origen propio permitido':'Fallo';try{await fetch('https://csp-denied.invalid/never');document.querySelector('#denied').textContent='Fallo';}catch{document.querySelector('#denied').textContent='Otro HTTPS bloqueado';}});`); return; }
    const name = files.get(pathname);
    if (!name) { res.writeHead(404); res.end(); return; }
    const body = await fs.readFile(path.join(frontend, "dist", name));
    res.writeHead(200, { "Content-Type": types[path.extname(name)], "Cache-Control": "no-store" }); res.end(body);
  });
  server.listen(43000, "127.0.0.1", () => console.log("Synthetic frontend at http://localhost:43000"));
})().catch(() => { console.error("Synthetic frontend could not start"); process.exitCode = 1; });
