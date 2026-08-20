#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

if (process.env.SCUA_CHROME_WORKSPACE_LIVE !== "1") {
	console.error("Set SCUA_CHROME_WORKSPACE_LIVE=1 to run the existing-window Chrome workspace test.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = `<!doctype html><meta charset="utf-8"><title>SCUA Chrome workspace fixture</title>
<button aria-label="Complete task">Complete task</button><p aria-live="polite">Status: idle</p>
<script>const marker=new URLSearchParams(location.search).get('marker')||'unknown';document.querySelector('button').onclick=()=>setTimeout(()=>document.querySelector('p').textContent='Status: '+marker,500)</script>`;
const fixtureServer = http.createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
	response.end(fixture);
});
await new Promise((resolve, reject) => { fixtureServer.once("error", reject); fixtureServer.listen(0, "127.0.0.1", resolve); });
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}`;

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
			env: {
				...process.env,
				SCUA_CHROME_WORKSPACE_NAME: "SCUA live proof",
				PI_COMPUTER_USE_EXECUTION_MODE: "background",
			},
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
			this.responses.set(String(message.id), message);
			this.waiters.get(String(message.id))?.();
		}
	}

	async request(method, params = {}, timeoutMs = 60_000) {
		const id = this.nextId++;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		if (!this.responses.has(String(id))) {
			await Promise.race([
				new Promise((resolve) => this.waiters.set(String(id), resolve)),
				new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`MCP timeout: ${this.stderr}`)), timeoutMs); timer.unref(); }),
			]);
		}
		this.waiters.delete(String(id));
		const response = this.responses.get(String(id));
		this.responses.delete(String(id));
		return response;
	}

	async call(name, args, token, allowError = false) {
		const startedAt = performance.now();
		const response = await this.request("tools/call", { name, arguments: args, ...(token ? { _meta: { scuaActorToken: token } } : {}) });
		const result = response.result;
		if (!allowError && result?.isError !== false) throw new Error(`${name} failed: ${result?.content?.[0]?.text ?? this.stderr}`);
		return { ...result, durationMs: performance.now() - startedAt };
	}

	async close() {
		this.child.stdin.end();
		await Promise.race([
			new Promise((resolve) => this.child.once("exit", resolve)),
			new Promise((resolve) => setTimeout(resolve, 5_000)),
		]);
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
	}
}

const client = new McpClient();
const overallStartedAt = performance.now();
const report = { actors: 4, workspace: {}, parallel: {}, isolation: {}, handoff: {}, stages: {}, cleanupRequested: false };
try {
	let stageStartedAt = performance.now();
	await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chrome-workspace-live", version: "1" } });
	const actors = [];
	for (let index = 0; index < report.actors; index += 1) {
		const created = await client.call("actor_session", { action: "create", maxActions: 20 });
		actors.push({ actorId: created.structuredContent.actorId, token: created.structuredContent.actorToken, marker: `chrome-actor-${index}` });
	}
	report.stages.initializeAndActorsMs = performance.now() - stageStartedAt;

	const openStartedAt = performance.now();
	const opened = await Promise.all(actors.map(async (actor) => {
		const result = await client.call("open_root", { kind: "browser_page", url: `${fixtureUrl}/?marker=${actor.marker}` }, actor.token);
		return { actor, result };
	}));
	report.parallel.openWallMs = performance.now() - openStartedAt;
	const workspaces = opened.map(({ result }) => result.structuredContent.root.workspace);
	assert(workspaces.every((workspace) => workspace?.transport === "chrome_extension"), "SCUA fell back to a separate CDP browser instead of the Chrome companion");
	assert.equal(new Set(workspaces.map((workspace) => workspace.workspaceId)).size, 1, "actors did not share one process workspace");
	assert.equal(new Set(workspaces.map((workspace) => workspace.groupId)).size, 1, "concurrent first tabs split across Chrome groups");
	assert.equal(new Set(workspaces.map((workspace) => workspace.windowId)).size, 1, "workspace tabs split across Chrome windows");
	assert(workspaces.every((workspace) => workspace.active === false), "an agent-created tab stole Chrome's selected tab");
	report.workspace = {
		workspaceId: workspaces[0].workspaceId,
		workspaceName: workspaces[0].workspaceName,
		groupId: workspaces[0].groupId,
		windowId: workspaces[0].windowId,
		reusedExistingWindow: workspaces.every((workspace) => workspace.reusedWindow !== false),
		allTabsInactive: true,
		distinctResources: new Set(opened.map(({ result }) => result.structuredContent.resource.key)).size,
	};
	assert.equal(report.workspace.distinctResources, report.actors, "actors did not receive independent browser resources");

	stageStartedAt = performance.now();
	const prepared = await Promise.all(opened.map(async ({ actor, result }) => {
		const searched = await client.call("search_ui", { stateId: result.structuredContent.stateId, text: "Complete task", role: "button" }, actor.token);
		return { actor, opened: result, ref: searched.structuredContent.matches[0].ref };
	}));
	report.stages.prepareSearchMs = performance.now() - stageStartedAt;
	const actionStartedAt = performance.now();
	const actions = await Promise.all(prepared.map(async (task) => await client.call("act_ui", {
		stateId: task.opened.structuredContent.stateId,
		actions: [{ action: "press", ref: task.ref }],
		expect: { text: `Status: ${task.actor.marker}`, timeoutMs: 5_000 },
	}, task.actor.token)));
	report.parallel.actionWallMs = performance.now() - actionStartedAt;
	report.parallel.actionSerialEstimateMs = actions.reduce((sum, action) => sum + action.durationMs, 0);
	report.parallel.actionSpeedup = report.parallel.actionSerialEstimateMs / report.parallel.actionWallMs;
	assert(report.parallel.actionSpeedup > 1.8, `browser actions did not overlap enough: ${report.parallel.actionSpeedup.toFixed(2)}x`);
	assert(actions.every((action) => action.structuredContent.execution.verification.status === "verified"), "not every parallel tab action was verified");

	stageStartedAt = performance.now();
	const crossActor = await client.call("search_ui", { stateId: opened[0].result.structuredContent.stateId, text: "Complete task" }, actors[1].token, true);
	assert.equal(crossActor.structuredContent.error.code, "state_unavailable", "one actor could read another actor's unhanded state");
	report.isolation = { crossActorStateRejected: true };
	report.stages.isolationMs = performance.now() - stageStartedAt;

	stageStartedAt = performance.now();
	const source = opened[0].result;
	const acquired = await client.call("claim_resource", { action: "acquire", resourceKey: source.structuredContent.resource.key }, actors[0].token);
	await client.call("claim_resource", {
		action: "handoff",
		resourceKey: source.structuredContent.resource.key,
		leaseId: acquired.structuredContent.leaseId,
		recipientActorId: actors[1].actorId,
	}, actors[0].token);
	const oldOwner = await client.call("observe_ui", { root: source.structuredContent.root.ref, mode: "semantic" }, actors[0].token, true);
	assert.equal(oldOwner.structuredContent.error.code, "resource_owned", "the old actor retained its tab after handoff");
	const recipientRoots = await client.call("find_roots", { kind: "browser_page" }, actors[1].token);
	const handedRoot = recipientRoots.structuredContent.windows.find((entry) => entry.url?.includes("marker=chrome-actor-0"));
	assert(handedRoot?.windowRef, "the recipient could not discover the handed-off Chrome tab");
	await client.call("observe_ui", { root: handedRoot.windowRef, mode: "semantic" }, actors[1].token);
	report.handoff = { oldOwnerFenced: true, recipientObservedFreshState: true };
	report.stages.handoffMs = performance.now() - stageStartedAt;

	stageStartedAt = performance.now();
	for (const actor of actors) await client.call("actor_session", { action: "close" }, actor.token);
	report.stages.actorCloseMs = performance.now() - stageStartedAt;
	report.cleanupRequested = true;
	report.pass = true;
} finally {
	await client.close();
	fixtureServer.closeAllConnections?.();
	await new Promise((resolve) => fixtureServer.close(resolve));
}

report.totalMs = performance.now() - overallStartedAt;
console.log(JSON.stringify(report, null, 2));
