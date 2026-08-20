import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const files = new Set(manifest.files ?? []);
for (const required of [".codex-plugin", ".mcp.json", "mcp", "scripts/run-mcp.sh", "scripts/chrome-native-host.mjs", "scripts/install-chrome-extension.mjs", "chrome-extension"]) {
	assert(files.has(required), `npm package omits Codex plugin file: ${required}`);
}
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
const packedPaths = new Set(packed[0]?.files?.map((entry) => entry.path) ?? []);
for (const required of [".codex-plugin/plugin.json", ".mcp.json", "mcp/server.ts", "mcp/tool-catalog.ts", "mcp/compact.ts", "scripts/run-mcp.sh", "scripts/chrome-native-host.mjs", "scripts/install-chrome-extension.mjs", "chrome-extension/manifest.json", "chrome-extension/service-worker.js"]) {
	assert(packedPaths.has(required), `actual npm tarball omits Codex plugin file: ${required}`);
}
console.log("Package file checks passed.");
