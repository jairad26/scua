#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { macosHelper } from "../src/platform/macos/helper.ts";

if (process.env.SCUA_ORCHESTRATOR_SOAK_LIVE !== "1") {
	console.error("Set SCUA_ORCHESTRATOR_SOAK_LIVE=1 to run the live orchestrator soak.");
	process.exit(2);
}

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => {
	const index = process.argv.indexOf(name);
	if (index < 0) return fallback;
	const value = Number(process.argv[index + 1]);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number.`);
	return value;
};
const actorCount = Math.max(1, Math.min(100, Math.trunc(option("--actors", 50))));
const durationMs = Math.trunc(option("--duration-ms", option("--duration-minutes", 60) * 60_000));
const sampleMs = Math.max(1_000, Math.trunc(option("--sample-ms", 60_000)));
const mutationMs = Math.max(500, Math.trunc(option("--mutation-ms", 5_000)));
const nativeLooksPerSample = Math.max(1, Math.min(32, Math.trunc(option("--native-looks-per-sample", 10))));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = `<!doctype html><meta charset="utf-8"><title>SCUA soak</title>
<button aria-label="Advance actor">Advance actor</button><p aria-live="polite">Status: 0</p>
<script>let n=0;document.querySelector('button').onclick=()=>document.querySelector('p').textContent='Status: '+(++n)</script>`;

class Client {
	constructor() {
		this.nextId = 1; this.buffer = ""; this.responses = new Map(); this.waiters = new Map(); this.stderr = "";
		this.child = spawn(process.execPath, [path.join(root, "mcp/server.ts")], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_COMPUTER_USE_HEADLESS: "false", PI_COMPUTER_USE_CURSOR_OVERLAY: "false", PI_COMPUTER_USE_EXECUTION_MODE: "background" },
		});
		this.child.stdout.setEncoding("utf8"); this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.onData(chunk));
		this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
	}
	onData(chunk) {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n"); if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); if (!line) continue;
			const message = JSON.parse(line); const key = String(message.id);
			this.responses.set(key, message); this.waiters.get(key)?.();
		}
	}
	send(method, params = {}) {
		const id = this.nextId++; const key = String(id);
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		const response = async (timeoutMs = 60_000) => {
			if (!this.responses.has(key)) await Promise.race([
				new Promise((resolve) => this.waiters.set(key, resolve)),
				new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`MCP timeout ${key}: ${this.stderr}`)), timeoutMs); timer.unref(); }),
			]);
			this.waiters.delete(key); const result = this.responses.get(key); this.responses.delete(key); return result;
		};
		return { id, response };
	}
	async request(method, params = {}, timeoutMs = 60_000) { return await this.send(method, params).response(timeoutMs); }
	async call(name, args, token, timeoutMs = 60_000) {
		const response = await this.request("tools/call", { name, arguments: args, ...(token ? { _meta: { scuaActorToken: token } } : {}) }, timeoutMs);
		const result = response?.result;
		if (result?.isError !== false) throw new Error(`${name} failed: ${result?.content?.[0]?.text ?? this.stderr}`);
		return result.structuredContent;
	}
	async initialize() {
		const response = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scua-orchestrator-soak", version: "1" } });
		assert.equal(response?.result?.serverInfo?.name, "scua");
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}
	async close() {
		this.child.stdin.end();
		await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(3_000)]);
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
	}
}

async function processMetrics(pid) {
	const [{ stdout: rss }, { stdout: files }] = await Promise.all([
		execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]),
		execFileAsync("lsof", ["-p", String(pid), "-Fn"]),
	]);
	return { rssBytes: Number(rss.trim()) * 1024, fileDescriptors: files.split("\n").filter((line) => line.startsWith("n")).length };
}

const server = http.createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); response.end(fixture);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
const client = new Client();
const actors = [];
const samples = [];
let mutations = 0;
let rounds = 0;
let peakConcurrency = 0;

try {
	await client.initialize();
	await macosHelper.ensureProtocol();
	const nativeApps = await macosHelper.command("listApps");
	const finder = (nativeApps.apps ?? nativeApps).find((app) => app.appName === "Finder");
	assert(finder?.pid, "Finder is required for native helper-retention sampling.");
	const resolveNativeRoot = async () => {
		const nativeRoots = await macosHelper.command("listRoots", { pid: finder.pid });
		return (nativeRoots.roots ?? nativeRoots).find((candidate) => candidate.windowRef ?? candidate.rootRef);
	};
	let nativeRoot = await resolveNativeRoot();
	assert(nativeRoot, "Finder exposed no root for native helper-retention sampling.");
	for (let index = 0; index < actorCount; index += 1) {
		const created = await client.call("actor_session", { action: "create", maxActions: 100_000, ttlMs: durationMs + 300_000 });
		actors.push({ token: created.actorToken, actorId: created.actorId, index, count: 0 });
	}
	for (let offset = 0; offset < actors.length; offset += 10) {
		await Promise.all(actors.slice(offset, offset + 10).map(async (actor) => {
			const opened = await client.call("open_root", { kind: "browser_page", url: `${fixtureUrl}/?actor=${actor.index}` }, actor.token, 60_000);
			actor.stateId = opened.stateId ?? opened.capture?.stateId;
			actor.resourceKey = opened.resource?.key;
			const claimed = await client.call("claim_resource", { action: "acquire", resourceKey: actor.resourceKey, ttlMs: 300_000 }, actor.token);
			actor.leaseId = claimed.leaseId;
			const searched = await client.call("search_ui", { stateId: actor.stateId, text: "Advance actor", role: "button" }, actor.token);
			actor.ref = searched.matches?.[0]?.ref;
			assert(actor.stateId && actor.resourceKey && actor.leaseId && actor.ref, `actor ${actor.index} did not receive a complete browser root`);
		}));
	}

	const startedAt = Date.now();
	let nextSampleAt = startedAt;
	let nextMutationAt = startedAt;
	while (Date.now() - startedAt < durationMs) {
		const now = Date.now();
		if (now >= nextMutationAt) {
			let active = 0;
			await Promise.all(actors.map(async (actor) => {
				active += 1; peakConcurrency = Math.max(peakConcurrency, active);
				actor.count += 1;
				const acted = await client.call("act_ui", {
					stateId: actor.stateId,
					actions: [{ action: "press", ref: actor.ref }],
					expect: { text: `Status: ${actor.count}`, timeoutMs: 2_000 },
				}, actor.token, 30_000);
				actor.stateId = acted.stateId ?? acted.capture?.stateId;
				const searched = await client.call("search_ui", { stateId: actor.stateId, text: "Advance actor", role: "button" }, actor.token);
				actor.ref = searched.matches?.[0]?.ref;
				assert.equal(acted.execution?.verification?.status, "verified");
				active -= 1; mutations += 1;
			}));
			rounds += 1; nextMutationAt = Date.now() + mutationMs;
		}
		if (now >= nextSampleAt) {
			await Promise.all(actors.map(async (actor) => {
				const renewed = await client.call("claim_resource", { action: "renew", resourceKey: actor.resourceKey, leaseId: actor.leaseId, ttlMs: 300_000 }, actor.token);
				actor.leaseId = renewed.leaseId;
			}));
			const sampleNativeRetention = async () => await Promise.all(Array.from({ length: nativeLooksPerSample }, () => macosHelper.command("look", {
				windowId: nativeRoot.windowId,
				windowRef: nativeRoot.windowRef ?? nativeRoot.rootRef,
				readText: "never",
				includeImage: false,
			}, { timeoutMs: 33_000 })));
			try {
				await sampleNativeRetention();
			} catch (error) {
				// A user may close or replace the sampled Finder window during the
				// hour. Rebind once so the endurance gate measures retention rather
				// than requiring the desktop to remain frozen for the test.
				nativeRoot = await resolveNativeRoot();
				if (!nativeRoot) throw error;
				await sampleNativeRetention();
			}
			const [status, processSample, helper, actorRoots] = await Promise.all([
				client.call("actor_session", { action: "status" }, actors[0].token),
				processMetrics(client.child.pid),
				macosHelper.diagnosticsCommand(),
				Promise.all(actors.map((actor) => client.call("find_roots", { kind: "browser_page" }, actor.token))),
			]);
			const browserTargets = new Set(actorRoots.flatMap((result) => (result.windows ?? []).map((rootEntry) => rootEntry.windowRef ?? rootEntry.url))).size;
			const sample = { elapsedMs: Date.now() - startedAt, ...processSample, browserTargets, coordinator: status.coordinator, helperRetention: helper.retention };
			samples.push(sample); process.stderr.write(`[scua-soak] ${JSON.stringify(sample)}\n`); nextSampleAt = Date.now() + sampleMs;
		}
		await delay(25);
	}

	const last = samples.at(-1);
	assert(peakConcurrency >= Math.min(25, actorCount), `peak concurrency was ${peakConcurrency}`);
	assert(last?.browserTargets === actorCount, `retained ${last?.browserTargets} browser targets, expected ${actorCount}`);
	assert(last?.coordinator?.claims === actorCount, `retained ${last?.coordinator?.claims} claims, expected ${actorCount}`);
	assert(last?.coordinator?.activeMutations === 0, "mutations leaked past a completed round");
	assert((last?.helperRetention?.looks?.records ?? 0) <= (last?.helperRetention?.looks?.limit ?? 0), "helper look retention exceeded its bound");
	const rssGrowthBytes = Math.max(...samples.map((sample) => sample.rssBytes)) - samples[0].rssBytes;
	const fdGrowth = Math.max(...samples.map((sample) => sample.fileDescriptors)) - samples[0].fileDescriptors;
	assert(rssGrowthBytes < 512 * 1024 * 1024, `MCP RSS grew by ${rssGrowthBytes} bytes`);
	assert(fdGrowth < 128, `MCP file descriptors grew by ${fdGrowth}`);
	console.log(JSON.stringify({ pass: true, actorCount, durationMs: Date.now() - startedAt, rounds, mutations, peakConcurrency, rssGrowthBytes, fdGrowth, samples }, null, 2));
} finally {
	for (const actor of actors) await client.call("actor_session", { action: "close" }, actor.token).catch(() => undefined);
	await client.close();
	await new Promise((resolve) => server.close(resolve));
}
