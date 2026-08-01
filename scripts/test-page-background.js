#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "evals", "fixtures", "sample.Report");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pbir-background-"));
const fixture = path.join(tempRoot, "sample.Report");
fs.cpSync(SOURCE, fixture, { recursive: true });

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js"), fixture], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const requestId = id++;
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  return { child, call };
}

(async () => {
  const server = startServer();
  await server.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "background-test", version: "0" } });
  server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const pages = await server.call("tools/call", { name: "pbir_list_pages", arguments: {} });
  const pageId = pages.result.structuredContent.pages[0].id;
  const set = await server.call("tools/call", { name: "pbir_set_page_background", arguments: { pageId, color: "#F2EFE7", transparency: 0 } });
  const wallpaper = await server.call("tools/call", { name: "pbir_set_page_background", arguments: { pageId, wallpaperColor: "#000000" } });
  server.child.kill();

  const page = JSON.parse(fs.readFileSync(path.join(fixture, "definition", "pages", pageId, "page.json"), "utf8"));
  const properties = page.objects.background[0].properties;
  const failures = [];
  const assert = (condition, message) => condition ? console.log("  PASS:", message) : (console.error("  FAIL:", message), failures.push(message));
  assert(!set.error && set.result.isError !== true, "canvas background write succeeds");
  assert(properties.color && properties.transparency, "background includes Fabric-supported color and transparency");
  assert(!Object.prototype.hasOwnProperty.call(properties, "show"), "background omits schema-invalid show property");
  assert(!page.objects.wallpaper, "page omits schema-invalid wallpaper object");
  assert(wallpaper.result.isError === true, "unsupported wallpaper input fails clearly instead of writing invalid PBIR");
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (failures.length) process.exit(1);
  console.log("\nOK: page background PBIR schema regression passed.");
})().catch((error) => {
  console.error(error);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.exit(1);
});
