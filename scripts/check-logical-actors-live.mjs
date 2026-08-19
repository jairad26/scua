#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

if (process.env.SCUA_LOGICAL_ACTORS_LIVE !== "1") {
	console.error("Set SCUA_LOGICAL_ACTORS_LIVE=1 to run the shared-coordinator live test.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = `<!doctype html><meta charset="utf-8"><title>SCUA logical actor fixture</title>
<button aria-label="Run actor task">Run actor task</button><p aria-live="polite">Status: idle</p>
<script>const marker=new URLSearchParams(location.search).get('marker')||'unknown';document.querySelector('button').onclick=()=>setTimeout(()=>document.querySelector('p').textContent='Status: '+marker,700)</script>`;

const server = http.createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); response.end(fixture); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

class Client {
	constructor() {
		this.nextId = 1; this.buffer = ""; this.responses = new Map(); this.waiters = new Map(); this.stderr = "";
		this.child = spawn(process.execPath, [path.join(root, "mcp/server.ts")], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_COMPUTER_USE_HEADLESS: "false", PI_COMPUTER_USE_CURSOR_OVERLAY: "true", PI_COMPUTER_USE_EXECUTION_MODE: "background" } });
		this.child.stdout.setEncoding("utf8"); this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
		this.child.stdout.on("data", (chunk) => this.onData(chunk));
	}
	onData(chunk) {
		this.buffer += chunk;
		for (;;) { const newline = this.buffer.indexOf("\n"); if (newline < 0) return; const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); if (!line) continue; const message = JSON.parse(line); this.responses.set(String(message.id), message); this.waiters.get(String(message.id))?.(); }
	}
	async request(method, params = {}, timeoutMs = 60_000) {
		const id = this.nextId++; this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		if (!this.responses.has(String(id))) await Promise.race([new Promise((resolve) => this.waiters.set(String(id), resolve)), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`MCP timeout: ${this.stderr}`)), timeoutMs); timer.unref(); })]);
		this.waiters.delete(String(id)); const result = this.responses.get(String(id)); this.responses.delete(String(id)); return result;
	}
	async call(name, args, token, allowError = false) {
		const startedAt = performance.now();
		const response = await this.request("tools/call", { name, arguments: args, ...(token ? { _meta: { scuaActorToken: token } } : {}) });
		const result = response.result;
		if (!allowError && result?.isError !== false) throw new Error(`${name} failed: ${result?.content?.[0]?.text ?? this.stderr}`);
		return { ...result, durationMs: performance.now() - startedAt };
	}
}

const client = new Client();
const report = { actorCount: 3, mcpProcessCount: 1, parallel: {}, handoff: {} };
try {
	await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "logical-live", version: "1" } });
	const actors = [];
	for (let index = 0; index < 3; index += 1) {
		const created = await client.call("actor_session", { action: "create", maxActions: 20 }, undefined);
		actors.push({ actorId: created.structuredContent.actorId, token: created.structuredContent.actorToken, marker: `actor-${index}` });
	}

	const prepared = await Promise.all(actors.map(async (actor) => {
		const opened = await client.call("open_root", { kind: "browser_page", url: `${baseUrl}/?marker=${actor.marker}` }, actor.token);
		const stateId = opened.structuredContent.stateId;
		const searched = await client.call("search_ui", { stateId, text: "Run actor task", role: "button" }, actor.token);
		return { actor, stateId, resource: opened.structuredContent.resource, ref: searched.structuredContent.matches[0].ref };
	}));

	const startedAt = performance.now();
	const actions = await Promise.all(prepared.map(async (task) => {
		const acted = await client.call("act_ui", { stateId: task.stateId, actions: [{ action: "press", ref: task.ref }], expect: { text: `Status: ${task.actor.marker}`, timeoutMs: 5_000 } }, task.actor.token);
		assert.equal(acted.structuredContent.execution.delivery, "cdp");
		assert.equal(acted.structuredContent.execution.verification.status, "verified");
		assert.equal(acted.structuredContent.execution.outcome, "worked");
		return { durationMs: acted.durationMs, stateId: acted.structuredContent.stateId };
	}));
	const wallMs = performance.now() - startedAt;
	const serialEstimateMs = actions.reduce((sum, action) => sum + action.durationMs, 0);
	report.parallel = { wallMs, serialEstimateMs, speedup: serialEstimateMs / wallMs };
	assert(report.parallel.speedup > 1.5, `logical actors did not overlap enough: ${report.parallel.speedup.toFixed(2)}x`);

	const source = prepared[0];
	const sourceCurrentSearch = await client.call("search_ui", { stateId: actions[0].stateId, text: "Run actor task", role: "button" }, source.actor.token);
	const sourceCurrentRef = sourceCurrentSearch.structuredContent.matches[0].ref;
	const acquired = await client.call("claim_resource", { action: "acquire", resourceKey: source.resource.key }, source.actor.token);
	const handoff = await client.call("claim_resource", { action: "handoff", resourceKey: source.resource.key, leaseId: acquired.structuredContent.leaseId, recipientActorId: actors[1].actorId }, source.actor.token);
	const oldOwnerAttempt = await client.call("act_ui", { stateId: actions[0].stateId, actions: [{ action: "press", ref: sourceCurrentRef }] }, source.actor.token, true);
	assert.equal(oldOwnerAttempt.structuredContent.error.code, "resource_owned", `old owner was not fenced after handoff: ${JSON.stringify(oldOwnerAttempt.structuredContent.error)}`);
	const recipientOldState = await client.call("search_ui", { stateId: actions[0].stateId, text: "Run actor task" }, actors[1].token, true);
	assert.equal(recipientOldState.structuredContent.error.code, "state_unavailable", "recipient reused pre-handoff state");
	const roots = await client.call("find_roots", { kind: "browser_page" }, actors[1].token);
	const handedRoot = roots.structuredContent.windows.find((rootEntry) => rootEntry.url?.includes("marker=actor-0"));
	assert(handedRoot?.windowRef, "recipient could not discover handed-off browser root");
	const fresh = await client.call("observe_ui", { root: handedRoot.windowRef, mode: "semantic" }, actors[1].token);
	assert.notEqual(fresh.structuredContent.stateId, actions[0].stateId, "handoff did not require a fresh observation");
	report.handoff = { generation: handoff.structuredContent.generation, oldOwnerFenced: true, oldStateRejected: true, freshStateId: fresh.structuredContent.stateId };

	for (const actor of actors) await client.call("actor_session", { action: "close" }, actor.token);
	report.pass = true;
} finally {
	client.child.stdin.end();
	await Promise.race([
		new Promise((resolve) => client.child.once("exit", resolve)),
		new Promise((resolve) => setTimeout(resolve, 2_000)),
	]);
	if (client.child.exitCode === null) {
		client.child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => client.child.once("exit", resolve)),
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		]);
	}
	if (client.child.exitCode === null) client.child.kill("SIGKILL");
	await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify(report, null, 2));
