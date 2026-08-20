#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "chrome-extension");
const serviceWorkerPath = path.join(extensionDir, "service-worker.js");
const bridgePath = path.join(root, "src", "chrome-extension-bridge.ts");
const hostPath = path.join(root, "scripts", "chrome-native-host.mjs");
const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, "manifest.json"), "utf8"));
const worker = await fs.readFile(serviceWorkerPath, "utf8");
const bridge = await fs.readFile(bridgePath, "utf8");
const cdp = await fs.readFile(path.join(root, "src", "cdp.ts"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.deepEqual(new Set(manifest.permissions), new Set(["debugger", "nativeMessaging", "storage", "tabGroups", "tabs"]));
assert.match(worker, /getLastFocused\(\{ windowTypes: \["normal"\] \}\)/, "workspace does not prefer the existing focused Chrome window");
assert.match(worker, /chrome\.tabs\.create\(\{ windowId: group\.windowId, url, active: false \}\)/, "subsequent workspace tabs can steal foreground focus");
assert.match(worker, /chrome\.tabs\.create\(\{ windowId: selected\.windowId, url, active: false \}\)/, "first workspace tab can steal foreground focus");
assert.match(worker, /Tab \$\{tabId\} is not owned by SCUA workspace/, "CDP commands are not fenced by workspace ownership");
assert.match(worker, /case "workspace\.close"/, "session cleanup cannot close its owned Chrome workspace");
assert.match(worker, /workspaceMutations/, "concurrent first-tab creation is not serialized per workspace");
assert.match(worker, /tabs\.onRemoved[\s\S]*mutateWorkspace/, "tab-removal cleanup bypasses the workspace mutation lane");
assert.match(worker, /finishWorkspaceTab\(tab\)/, "tab readiness is finalized outside workspace allocation");
assert.match(worker, /waitForTabReady\(tab\.tabId\)/, "new Chrome tabs can be observed before their requested document is ready");
assert.match(bridge, /retryablePreconnectError/, "Chrome relay retries only pre-connect transport failures");
assert.match(bridge, /requestSent !== true/, "Chrome relay does not replay requests that may have been delivered");
assert.match(cdp, /requestSent === true\) throw error/, "Chrome tab creation can replay a request with uncertain delivery through managed CDP");
assert.match(worker, /chrome\.tabs\.group/, "agent-created tabs are not grouped");
assert.match(worker, /scua-extension-tab:/, "extension targets do not use a reserved SCUA namespace");
assert.doesNotMatch(worker, /chrome\.tabs\.query\(\{\}\)/, "extension enumerates unrelated user tabs");
execFileSync(process.execPath, ["--check", serviceWorkerPath]);
execFileSync(process.execPath, ["--check", hostPath]);
assert.match(await fs.readFile(hostPath, "utf8"), /chrome-bridge\.lock/, "native relay startup can orphan an existing host socket");

const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), "scua-chrome-host-"));
const fixtureRuntime = path.join(fixtureHome, "runtime");
const child = spawn(process.execPath, [hostPath], { env: { ...process.env, SCUA_CHROME_RUNTIME_DIR: fixtureRuntime }, stdio: ["pipe", "pipe", "pipe"] });
const socketPath = path.join(fixtureRuntime, "chrome-bridge.sock");

async function waitForSocket() {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try { await fs.access(socketPath); return; } catch {}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("native host did not create its private Unix socket");
}

try {
	await waitForSocket();
	const competingHost = spawn(process.execPath, [hostPath], { env: { ...process.env, SCUA_CHROME_RUNTIME_DIR: fixtureRuntime }, stdio: ["ignore", "ignore", "pipe"] });
	const competingExit = await new Promise((resolve) => competingHost.once("exit", resolve));
	assert.equal(competingExit, 3, "a competing native host replaced the live relay instead of yielding");
	await fs.access(socketPath);
	const socket = net.createConnection(socketPath);
	await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
	socket.write(`${JSON.stringify({ type: "request", id: "proof", method: "bridge.ping", params: {} })}\n`);

	const nativeMessage = await new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => reject(new Error("native relay emitted no Chrome frame")), 2_000);
		child.stdout.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length < 4) return;
			const length = buffer.readUInt32LE(0);
			if (buffer.length < 4 + length) return;
			clearTimeout(timer);
			resolve(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
		});
	});
	assert.equal(nativeMessage.id, "proof");
	assert.equal(nativeMessage.method, "bridge.ping");
	assert.equal(typeof nativeMessage.clientId, "string");

	const response = Buffer.from(JSON.stringify({ type: "response", clientId: nativeMessage.clientId, id: "proof", result: { ready: true } }), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(response.length, 0);
	child.stdin.write(Buffer.concat([header, response]));
	const line = await new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error("native relay returned no SCUA response")), 2_000);
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			clearTimeout(timer);
			resolve(buffer.slice(0, buffer.indexOf("\n")));
		});
	});
	assert.deepEqual(JSON.parse(line).result, { ready: true });
	socket.destroy();
} finally {
	if (child.exitCode === null) {
		const closed = new Promise((resolve) => child.once("close", resolve));
		child.kill("SIGTERM");
		await closed;
	}
	await fs.rm(fixtureHome, { recursive: true, force: true });
}

console.log("Chrome extension isolation and native relay checks passed.");
