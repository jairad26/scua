#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

if (process.env.SCUA_CANCELLATION_LIVE !== "1") {
	console.error("Set SCUA_CANCELLATION_LIVE=1 to run cancellation checks.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = http.createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
	response.end("<!doctype html><title>SCUA cancellation</title><p>Cancellation fixture ready</p>");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const url = `http://127.0.0.1:${server.address().port}`;

class Client {
	constructor() {
		this.nextId = 1; this.buffer = ""; this.responses = new Map(); this.waiters = new Map(); this.stderr = "";
		this.child = spawn(process.execPath, [path.join(root, "mcp/server.ts")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdout.setEncoding("utf8"); this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.onData(chunk)); this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
	}
	onData(chunk) {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n"); if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); if (!line) continue;
			const message = JSON.parse(line); const key = String(message.id); this.responses.set(key, message); this.waiters.get(key)?.();
		}
	}
	send(method, params = {}) {
		const id = this.nextId++; const key = String(id);
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return { id, response: async (timeoutMs = 60_000) => {
			if (!this.responses.has(key)) await Promise.race([
				new Promise((resolve) => this.waiters.set(key, resolve)),
				new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`MCP timeout ${key}: ${this.stderr}`)), timeoutMs); timer.unref(); }),
			]);
			this.waiters.delete(key); const response = this.responses.get(key); this.responses.delete(key); return response;
		} };
	}
	notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
	tool(name, arguments_, token) { return this.send("tools/call", { name, arguments: arguments_, ...(token ? { _meta: { scuaActorToken: token } } : {}) }); }
	async call(name, arguments_, token) {
		const response = await this.tool(name, arguments_, token).response();
		assert.equal(response?.result?.isError, false, response?.result?.content?.[0]?.text ?? this.stderr);
		return response.result.structuredContent;
	}
	async close() { this.child.stdin.end(); await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(2_000)]); if (this.child.exitCode === null) this.child.kill("SIGTERM"); }
}

const client = new Client();
const report = {};
try {
	const initialized = await client.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scua-cancellation-live", version: "1" } }).response();
	assert.equal(initialized?.result?.serverInfo?.name, "scua"); client.notify("notifications/initialized");

	const actor = await client.call("actor_session", { action: "create", maxActions: 20 }, undefined);
	const opened = await client.call("open_root", { kind: "browser_page", url }, actor.actorToken);
	const stateId = opened.stateId ?? opened.capture?.stateId;
	const pending = client.tool("act_ui", { stateId, actions: [{ action: "wait", ms: 30_000 }] }, actor.actorToken);
	await delay(100);
	client.notify("notifications/cancelled", { requestId: pending.id, reason: "black-box test" });
	const cancelled = await pending.response(5_000);
	assert.equal(cancelled.result.isError, true);
	assert.equal(cancelled.result.structuredContent.error.code, "cancelled");
	assert.equal(cancelled.result.structuredContent.error.delivery, "definitely_not_delivered");
	const status = await client.call("actor_session", { action: "status" }, actor.actorToken);
	assert(status.recentEvents.some((event) => event.type === "operation_cancelled"), "cancelled request was missing from the actor trace");
	await client.call("actor_session", { action: "close" }, actor.actorToken);
	report.requestCancellation = { code: "cancelled", delivery: "definitely_not_delivered", traceRecorded: true };

	const closingActor = await client.call("actor_session", { action: "create", maxActions: 20 }, undefined);
	const closingRoot = await client.call("open_root", { kind: "browser_page", url: `${url}/?close=1` }, closingActor.actorToken);
	const closingStateId = closingRoot.stateId ?? closingRoot.capture?.stateId;
	const closingPending = client.tool("act_ui", { stateId: closingStateId, actions: [{ action: "wait", ms: 30_000 }] }, closingActor.actorToken);
	await delay(100);
	await client.call("actor_session", { action: "close" }, closingActor.actorToken);
	const closedResponse = await closingPending.response(5_000);
	assert.equal(closedResponse.result.isError, true);
	assert.equal(closedResponse.result.structuredContent.error.code, "cancelled");
	const coordinator = await client.call("actor_session", { action: "status" }, undefined);
	assert.equal(coordinator.coordinator.claims, 0, "actor close leaked a resource claim");
	report.actorCloseCancellation = { code: "cancelled", claimsAfterClose: 0 };
	report.pass = true;
} finally {
	await client.close();
	await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify(report, null, 2));
