import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8765);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".json": "application/json"
};

http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (relative === "server-url.txt") {
    response.writeHead(200, {"Content-Type": types[".txt"]}).end(process.env.BRAGI_TEST_SERVER_URL || "http://bragi.test");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, {"Content-Type": "text/plain"}).end("Not found");
      return;
    }
    response.writeHead(200, {"Content-Type": types[path.extname(filePath)] || "application/octet-stream"}).end(data);
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`BragiBrowser test server at http://127.0.0.1:${port}`);
});
