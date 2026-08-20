#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

if (process.env.SCUA_SUBSCRIPTIONS_LIVE !== "1") {
	console.error("Set SCUA_SUBSCRIPTIONS_LIVE=1 to run durable UI subscription checks.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = `<!doctype html><meta charset="utf-8"><title>SCUA subscription fixture</title>
<p id="status" aria-live="polite">Ready: initial</p>
<script>setTimeout(()=>document.querySelector('#status').textContent='Ready: changed',750)</script>`;
const fixtureServer = http.createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
	response.end(fixture);
});
await new Promise((resolve, reject) => { fixtureServer.once("error", reject); fixtureServer.listen(0, "127.0.0.1", resolve); });
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}`;

class Client {
	constructor() {
		this.nextId = 1; this.buffer = ""; this.responses = new Map(); this.waiters = new Map(); this.stderr = "";
		this.child = spawn(process.execPath, [path.join(root, "mcp/server.ts")], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_COMPUTER_USE_EXECUTION_MODE: "background", PI_COMPUTER_USE_CURSOR_OVERLAY: "true" },
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
	tool(name, args, token) { return this.send("tools/call", { name, arguments: args, ...(token ? { _meta: { scuaActorToken: token } } : {}) }); }
	async call(name, args, token, allowError = false, timeoutMs = 60_000) {
		const startedAt = performance.now();
		const response = await this.tool(name, args, token).response(timeoutMs);
		if (!allowError) assert.equal(response?.result?.isError, false, `${name}: ${response?.result?.content?.[0]?.text ?? this.stderr}`);
		return { ...response.result, durationMs: performance.now() - startedAt };
	}
	async close() {
		this.child.stdin.end();
		await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(2_000)]);
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
	}
}

async function waitForCalculatorRoot(client, token) {
	spawn("open", ["-a", "Calculator"], { stdio: "ignore" }).unref();
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const roots = await client.call("find_roots", { app: "Calculator" }, token);
		const window = roots.structuredContent.windows?.find((entry) => entry.kind === "window");
		if (window?.windowRef) return window;
		await delay(100);
	}
	throw new Error("Calculator did not expose a root within 10 seconds.");
}

const client = new Client();
const report = { browser: {}, native: {}, cancellation: {}, handoff: {}, diagnostics: {} };
function assertEventIdentity(event, subscription, actorId) {
	assert.equal(event.subscriptionId, subscription.subscriptionId, "event omitted stable subscription identity");
	assert.equal(event.actorId, actorId, "event omitted actor identity");
	assert.equal(event.resourceKey, subscription.resource.key, "event omitted resource identity");
	assert(Number.isSafeInteger(event.resourceEpoch), "event omitted resource epoch");
	assert.equal(typeof event.traceId, "string", "event omitted delivery-safe trace linkage");
}
try {
	const initialized = await client.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scua-subscriptions-live", version: "1" } }).response();
	assert.equal(initialized?.result?.serverInfo?.name, "scua"); client.notify("notifications/initialized");

	const browserOwner = await client.call("actor_session", { action: "create", maxActions: 30, ttlMs: 300_000 });
	const recipient = await client.call("actor_session", { action: "create", maxActions: 30, ttlMs: 300_000 });
	const browser = await client.call("open_root", { kind: "browser_page", url: fixtureUrl }, browserOwner.structuredContent.actorToken);
	const browserStateId = browser.structuredContent.stateId;
	const browserSubscription = await client.call("subscribe_ui", {
		stateId: browserStateId,
		text: "Ready: changed",
		label: "browser-auto-change",
	}, browserOwner.structuredContent.actorToken);
	const browserEvents = await client.call("read_ui_events", {
		subscriptionId: browserSubscription.structuredContent.subscriptionId,
		cursor: browserSubscription.structuredContent.cursor,
		timeoutMs: 5_000,
	}, browserOwner.structuredContent.actorToken, false, 10_000);
	assert(browserEvents.structuredContent.events.some((event) => event.type === "ui_changed"), "browser subscription received no DOM change event");
	const browserDebugSearch = browserEvents.structuredContent.conditionSatisfied ? undefined : await client.call("search_ui", { stateId: browserEvents.structuredContent.stateId, text: "Ready" }, browserOwner.structuredContent.actorToken);
	assert(browserEvents.structuredContent.events.some((event) => event.type === "condition_met"), `browser subscription did not evaluate its condition after refresh: ${JSON.stringify({ events: browserEvents.structuredContent, matches: browserDebugSearch?.structuredContent?.matches })}`);
	assert.equal(browserEvents.structuredContent.conditionSatisfied, true);
	assert.notEqual(browserEvents.structuredContent.stateId, browserStateId, "browser subscription did not return a successor state");
	for (const event of browserEvents.structuredContent.events) assertEventIdentity(event, browserSubscription.structuredContent, browserOwner.structuredContent.actorId);
	const resumed = await client.call("read_ui_events", {
		subscriptionId: browserSubscription.structuredContent.subscriptionId,
		cursor: browserEvents.structuredContent.nextCursor,
		timeoutMs: 0,
	}, browserOwner.structuredContent.actorToken);
	assert.equal(resumed.structuredContent.events.length, 0, "cursor resume duplicated committed UI events");
	report.browser = { durationMs: browserEvents.durationMs, events: browserEvents.structuredContent.events.map((event) => event.type), successorState: true };

	const cancellationSubscription = await client.call("subscribe_ui", {
		stateId: browserEvents.structuredContent.stateId,
		label: "cancellation-proof",
	}, browserOwner.structuredContent.actorToken);
	const pending = client.tool("read_ui_events", {
		subscriptionId: cancellationSubscription.structuredContent.subscriptionId,
		cursor: cancellationSubscription.structuredContent.cursor,
		timeoutMs: 30_000,
	}, browserOwner.structuredContent.actorToken);
	await delay(100);
	client.notify("notifications/cancelled", { requestId: pending.id, reason: "subscription cancellation proof" });
	const cancelled = await pending.response(5_000);
	assert.equal(cancelled.result.isError, true);
	assert.equal(cancelled.result.structuredContent.error.code, "cancelled");
	assert.equal(cancelled.result.structuredContent.error.delivery, "definitely_not_delivered");
	const afterCancellation = await client.call("actor_session", { action: "status" }, browserOwner.structuredContent.actorToken);
	assert.equal(afterCancellation.structuredContent.coordinator.activeSubscriptions, 1, "cancelled read did not release its subscriber");
	report.cancellation = { code: "cancelled", delivery: cancelled.result.structuredContent.error.delivery, subscriberReleased: true };

	const handoff = await client.call("claim_resource", {
		action: "handoff",
		resourceKey: browserSubscription.structuredContent.resource.key,
		leaseId: browserSubscription.structuredContent.lease.leaseId,
		recipientActorId: recipient.structuredContent.actorId,
	}, browserOwner.structuredContent.actorToken);
	assert(handoff.structuredContent.invalidatedSubscriptionIds.includes(browserSubscription.structuredContent.subscriptionId), "handoff did not invalidate the old subscription");
	const terminal = await client.call("read_ui_events", {
		subscriptionId: browserSubscription.structuredContent.subscriptionId,
		cursor: browserEvents.structuredContent.nextCursor,
		timeoutMs: 0,
	}, browserOwner.structuredContent.actorToken);
	assert.equal(terminal.structuredContent.active, false);
	assert(terminal.structuredContent.events.some((event) => event.type === "ownership_lost"), "old owner did not receive a terminal ownership event");
	for (const event of terminal.structuredContent.events) assertEventIdentity(event, browserSubscription.structuredContent, browserOwner.structuredContent.actorId);
	report.handoff = { oldOwnerFenced: true, terminalReason: terminal.structuredContent.terminalReason };

	const nativeOwner = await client.call("actor_session", { action: "create", maxActions: 30, ttlMs: 300_000 });
	const calculator = await waitForCalculatorRoot(client, nativeOwner.structuredContent.actorToken);
	const observed = await client.call("observe_ui", { root: calculator.windowRef, mode: "semantic" }, nativeOwner.structuredContent.actorToken);
	const nativeStateId = observed.structuredContent.capture.stateId;
	const one = await client.call("search_ui", { stateId: nativeStateId, text: "1", role: "button" }, nativeOwner.structuredContent.actorToken);
	assert(one.structuredContent.matches?.[0]?.ref, "Calculator button 1 was not found semantically");
	const nativeSubscription = await client.call("subscribe_ui", { stateId: nativeStateId, label: "calculator-change" }, nativeOwner.structuredContent.actorToken);
	await client.call("act_ui", { stateId: nativeStateId, actions: [{ action: "press", ref: one.structuredContent.matches[0].ref }] }, nativeOwner.structuredContent.actorToken);
	const nativeEvents = await client.call("read_ui_events", {
		subscriptionId: nativeSubscription.structuredContent.subscriptionId,
		cursor: nativeSubscription.structuredContent.cursor,
		timeoutMs: 5_000,
	}, nativeOwner.structuredContent.actorToken, false, 10_000);
	assert(nativeEvents.structuredContent.events.some((event) => event.type === "ui_changed"), "native subscription received no Accessibility event");
	assert.notEqual(nativeEvents.structuredContent.stateId, nativeStateId, "native subscription did not return a successor state");
	for (const event of nativeEvents.structuredContent.events) assertEventIdentity(event, nativeSubscription.structuredContent, nativeOwner.structuredContent.actorId);
	report.native = { durationMs: nativeEvents.durationMs, events: nativeEvents.structuredContent.events.map((event) => event.type), successorState: true };
	await client.call("unsubscribe_ui", { subscriptionId: nativeSubscription.structuredContent.subscriptionId }, nativeOwner.structuredContent.actorToken);
	const actorCloseSubscription = await client.call("subscribe_ui", {
		stateId: nativeEvents.structuredContent.stateId,
		label: "actor-close-proof",
	}, nativeOwner.structuredContent.actorToken);
	const nativeOwnerClosed = await client.call("actor_session", { action: "close" }, nativeOwner.structuredContent.actorToken);
	assert(nativeOwnerClosed.structuredContent.closedSubscriptionIds.includes(actorCloseSubscription.structuredContent.subscriptionId), "actor close did not release its subscriber");

	const status = await client.call("actor_session", { action: "status" }, undefined);
	report.diagnostics = status.structuredContent.coordinator;
	assert.equal(report.diagnostics.activeSubscriptions, 0, "live test leaked a UI subscription");

	await client.call("actor_session", { action: "close" }, browserOwner.structuredContent.actorToken);
	await client.call("actor_session", { action: "close" }, recipient.structuredContent.actorToken);
	report.pass = true;
} finally {
	await client.close();
	await new Promise((resolve) => fixtureServer.close(resolve));
}

console.log(JSON.stringify(report, null, 2));
