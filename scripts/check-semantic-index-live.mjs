#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { macosHelper } from "../src/platform/macos/helper.ts";

if (process.env.SCUA_SEMANTIC_INDEX_LIVE !== "1") {
	console.error("Set SCUA_SEMANTIC_INDEX_LIVE=1 to run the resumable semantic-index test.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class McpClient {
	constructor() {
		this.nextId = 1;
		this.buffer = "";
		this.responses = new Map();
		this.waiters = new Map();
		this.stderr = "";
		this.child = spawn(process.execPath, [path.join(root, "mcp/server.ts")], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, SCUA_AGENT_ID: `semantic-index-live-${process.pid}` },
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
		this.child.stdout.on("data", (chunk) => this.onData(chunk));
	}

	onData(chunk) {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const key = String(message.id);
			this.responses.set(key, message);
			this.waiters.get(key)?.();
		}
	}

	async request(method, params = {}, timeoutMs = 60_000) {
		const id = this.nextId++;
		const key = String(id);
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		if (!this.responses.has(key)) {
			let timer;
			try {
				await Promise.race([
					new Promise((resolve) => this.waiters.set(key, resolve)),
					new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP timeout ${key}: ${this.stderr}`)), timeoutMs); timer.unref(); }),
				]);
			} finally {
				clearTimeout(timer);
			}
		}
		this.waiters.delete(key);
		const response = this.responses.get(key);
		this.responses.delete(key);
		return response;
	}

	async initialize() {
		const response = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "semantic-index-live", version: "1" } });
		assert.equal(response?.result?.serverInfo?.name, "scua");
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}

	async call(name, args, timeoutMs = 60_000) {
		const response = await this.request("tools/call", { name, arguments: args }, timeoutMs);
		const result = response?.result;
		const text = (result?.content ?? []).map((item) => item?.text ?? "").join("\n");
		if (result?.isError !== false) throw new Error(`${name} failed: ${text || this.stderr}`);
		return { text, details: result.structuredContent };
	}

	async close() {
		this.child.stdin.end();
		await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(2_000)]);
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
	}
}

function countNodes(node) {
	return 1 + (node?.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

function containsLabel(node, query) {
	const label = [node?.title, node?.description, node?.value].filter(Boolean).join(" ");
	return label.includes(query) || (node?.children ?? []).some((child) => containsLabel(child, query));
}

await macosHelper.restart();
const diagnostics = await macosHelper.diagnosticsCommand();
assert.equal(diagnostics.protocolVersion, 14);

const client = new McpClient();
try {
	await client.initialize();
	const roots = await client.call("find_roots", { app: "Spotify" });
	const spotify = roots.details?.windows?.find((root) => root.app === "Spotify" && root.windowRef);
	assert(spotify?.windowRef, "Spotify must be open for the live semantic-index test.");
	const observed = await client.call("observe_ui", { root: spotify.windowRef, mode: "semantic" }, 45_000);
	const initialStateId = observed.details?.capture?.stateId;
	assert(initialStateId, `Spotify observation returned no state: ${JSON.stringify(observed.details)}`);
	const initialOutline = observed.details?.outline?.root;
	const initialNodes = initialOutline ? countNodes(initialOutline) : observed.details?.capabilities?.nodeCount;
	assert(Number.isFinite(initialNodes), "Spotify observation returned no node count.");
	assert(initialNodes <= 100, `initial observation ignored SCUA_AX_NODE_LIMIT=100 (${initialNodes} nodes)`);
	assert.equal(initialOutline ? containsLabel(initialOutline, "Search in Playlists") : observed.text.includes("Search in Playlists"), false, "fixture target unexpectedly appeared in the initial slice");

	const startedAt = performance.now();
	const searched = await client.call("search_ui", { stateId: initialStateId, text: "Search in Playlists", role: "button" }, 45_000);
	const durationMs = performance.now() - startedAt;
	assert(searched.details?.matches?.some((match) => match.label.includes("Search in Playlists")), `continued index did not find the starved target: ${searched.text}`);
	assert(searched.details?.semanticIndex?.indexedNodes > initialNodes, "semantic index did not grow beyond the initial slice");
	assert.notEqual(searched.details?.stateId, initialStateId, "continued semantic results did not mint a fresh immutable state");
	let completionStateId = searched.details.stateId;
	let completionStatus = searched.details.semanticIndex;
	const completionDeadline = Date.now() + 45_000;
	while (!completionStatus?.complete && !completionStatus?.error && Date.now() < completionDeadline) {
		const probe = await client.call("search_ui", { stateId: completionStateId, text: "__scua_semantic_index_completion_sentinel__" }, 45_000);
		completionStateId = probe.details?.stateId ?? completionStateId;
		completionStatus = probe.details?.semanticIndex;
	}
	assert.equal(completionStatus?.error, undefined, `semantic index failed before completion: ${completionStatus?.error}`);
	assert.equal(completionStatus?.complete, true, `semantic index did not exhaust all frontiers: ${JSON.stringify(completionStatus)}`);
	console.log(JSON.stringify({
		pass: true,
		initialNodes,
		searchMs: Math.round(durationMs),
		firstMatchIndex: searched.details.semanticIndex,
		completedIndex: completionStatus,
		match: searched.details.matches[0],
	}, null, 2));
} finally {
	await client.close();
}
