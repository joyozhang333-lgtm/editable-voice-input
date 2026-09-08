import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.EVI_STATIC_PORT ?? 5188);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = resolve(root, `.${path === "/" ? "/examples/vanilla/index.html" : path}`);
    const allowed = [resolve(root, "examples/vanilla") + sep, resolve(root, "dist/vendor") + sep];
    if (!allowed.some((prefix) => file.startsWith(prefix)) || !types[extname(file)]) {
      response.writeHead(404).end(); return;
    }
    const contents = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)], "cache-control": "no-store" });
    response.end(contents);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }
}).listen(port, "127.0.0.1", () => console.log(`Vanilla demo: http://127.0.0.1:${port}/examples/vanilla/index.html`));
