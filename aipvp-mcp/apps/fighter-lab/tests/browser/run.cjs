#!/usr/bin/env node
/* Fighter Lab browser tests in one command.
 * Builds the test page (index.html wrapped with the fake claude.ai platform), serves it from a tiny static
 * server on a free port, runs scenarios.cjs against it and exits with its status.
 *
 *   node apps/fighter-lab/tests/browser/run.cjs
 *
 * Env: PLAYWRIGHT_MODULE (path to the playwright package, default "playwright"),
 *      PLAYWRIGHT_BROWSERS_PATH (where Chromium lives), FL_OUT (screenshot folder, default ./out). */
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const APP = path.resolve(__dirname, "..", "..");
const FILES = ["engine.js", "economy.js", "optimizer.js", "agent.js", "sprites.js", "app.js"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };

function build(dir) {
  for (const f of FILES) fs.copyFileSync(path.join(APP, f), path.join(dir, f));
  fs.copyFileSync(path.join(__dirname, "fake-claude.js"), path.join(dir, "fake-claude.js"));
  // the same skeleton claude.ai wraps a published page in, with the fake platform loaded first
  const page = fs.readFileSync(path.join(APP, "index.html"), "utf8");
  fs.writeFileSync(path.join(dir, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<style>body{margin:0}[hidden]{display:none!important}</style></head><body><script src="fake-claude.js"></script>' + page + "</body></html>");
}

function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const name = path.basename(decodeURIComponent(new URL(req.url, "http://local").pathname)) || "index.html";
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fighter-lab-"));
  build(dir);
  const srv = await serve(dir);
  const base = `http://127.0.0.1:${srv.address().port}/index.html`;
  const child = spawn(process.execPath, [path.join(__dirname, "scenarios.cjs")], {
    stdio: "inherit",
    env: { ...process.env, FL_BASE: base, FL_OUT: process.env.FL_OUT || path.join(__dirname, "out") },
  });
  child.on("exit", (code) => {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(code ?? 1);
  });
})();
