#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "mcp/server.ts")], {
	cwd: root,
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		PI_COMPUTER_USE_HEADLESS: "false",
		PI_COMPUTER_USE_CURSOR_OVERLAY: "true",
		PI_COMPUTER_USE_FOREGROUND_FALLBACK: "false",
	},
});

let stdout = "";
let stderr = "";
const responses = new Map();
const waiters = new Map();

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
	stdout += chunk;
	for (;;) {
		const newline = stdout.indexOf("\n");
		if (newline < 0) break;
		const line = stdout.slice(0, newline).trim();
		stdout = stdout.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		responses.set(String(message.id), message);
		waiters.get(String(message.id))?.();
	}
});

function send(id, method, params = {}) {
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function receive(id) {
	const key = String(id);
	if (!responses.has(key)) {
		await Promise.race([
			new Promise((resolve) => waiters.set(key, resolve)),
			new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${key}. ${stderr}`)), 5_000)),
		]);
	}
	waiters.delete(key);
	return responses.get(key);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

try {
	send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
	const initialized = await receive(1);
	assert(initialized.result?.serverInfo?.name === "scua", "initialize did not identify SCUA");
	assert(initialized.result?.instructions?.includes("never invent or request app-specific SCUA tools"), "generic contract instruction is missing");
	assert(initialized.result?.instructions?.includes("forbids foreground fallback"), "attention-safe policy instruction is missing");

	send(2, "tools/list");
	const listed = await receive(2);
	const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
	const expected = ["find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui", "act_ui", "read_text", "wait_for"];
	assert(JSON.stringify(names) === JSON.stringify(expected), `unexpected SCUA MCP tools: ${names.join(", ")}`);
	assert(!names.some((name) => /notes|spotify|chrome|browser/i.test(name)), "SCUA MCP surface contains an app-specific tool");

	const launcher = readFileSync(path.join(root, "scripts/run-mcp.sh"), "utf8");
	assert(launcher.includes('PI_COMPUTER_USE_FOREGROUND_FALLBACK="false"'), "SCUA launcher does not forbid foreground fallback");
	assert(launcher.includes('PI_COMPUTER_USE_CURSOR_OVERLAY="true"'), "SCUA launcher does not enable visual agent cursors");

	send(3, "ping");
	const ping = await receive(3);
	assert(ping.result && Object.keys(ping.result).length === 0, "ping response was invalid");

	if (process.env.SCUA_MCP_LIVE === "1") {
		send(4, "tools/call", { name: "find_roots", arguments: {} });
		const live = await receive(4);
		assert(live.result?.isError === false, `live find_roots failed: ${live.result?.content?.[0]?.text ?? stderr}`);
		assert(Array.isArray(live.result?.content), "live find_roots returned no MCP content");
	}

	console.log("SCUA MCP contract checks passed.");
} finally {
	child.stdin.end();
	setTimeout(() => child.kill("SIGTERM"), 1_000).unref();
}
