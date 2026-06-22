// HTTP response/request helpers — extracted from server.mjs (near-pure).
import { readFileSync } from "node:fs";

export function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

export function html(res, filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  } catch { res.writeHead(404); res.end("Not found"); }
}

export function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "", size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); return reject(new Error('Request body too large')); }
      body += c;
    });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}
