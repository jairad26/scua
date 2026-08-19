#!/usr/bin/env node
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { macosHelper } from "../src/platform/macos/helper.ts";

if (process.env.SCUA_MULTI_AGENT_LIVE !== "1") {
	console.error("Set SCUA_MULTI_AGENT_LIVE=1 to run the live multi-agent test.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${Date.now()}-${process.pid}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function contentText(result) {
	return (result?.content ?? []).map((item) => item?.text ?? "").filter(Boolean).join("\n");
}

class McpClient {
	constructor(agentId) {
		this.agentId = agentId;
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
				SCUA_AGENT_ID: agentId,
				PI_COMPUTER_USE_HEADLESS: "false",
				PI_COMPUTER_USE_CURSOR_OVERLAY: "true",
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
			const key = String(message.id);
			this.responses.set(key, message);
			this.waiters.get(key)?.();
		}
	}

	send(method, params = {}) {
		const id = this.nextId++;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return id;
	}

	async receive(id, timeoutMs = 60_000) {
		const key = String(id);
		if (!this.responses.has(key)) {
			await Promise.race([
				new Promise((resolve) => this.waiters.set(key, resolve)),
				new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`${this.agentId} timed out waiting for response ${key}. ${this.stderr}`)), timeoutMs); timer.unref(); }),
			]);
		}
		this.waiters.delete(key);
		const message = this.responses.get(key);
		this.responses.delete(key);
		return message;
	}

	async initialize() {
		const id = this.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scua-multi-agent-live", version: "1" } });
		const response = await this.receive(id);
		if (response?.result?.serverInfo?.name !== "scua") throw new Error(`${this.agentId} did not initialize SCUA.`);
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}

	async callRaw(name, args, timeoutMs = 60_000) {
		const startedAt = performance.now();
		const id = this.send("tools/call", { name, arguments: args });
		const response = await this.receive(id, timeoutMs);
		const result = response?.result;
		return {
			ok: result?.isError === false,
			name,
			durationMs: performance.now() - startedAt,
			result,
			text: contentText(result),
			details: result?.structuredContent,
		};
	}

	async call(name, args, timeoutMs = 60_000) {
		const call = await this.callRaw(name, args, timeoutMs);
		if (!call.ok) throw new Error(`${this.agentId} ${name} failed: ${call.text || this.stderr}`);
		return call;
	}

	async close() {
		if (this.child.exitCode !== null) return;
		this.child.stdin.end();
		await Promise.race([
			new Promise((resolve) => this.child.once("exit", resolve)),
			delay(4_000),
		]);
		if (this.child.exitCode === null) {
			this.child.kill("SIGTERM");
			await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(2_000)]);
		}
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
	}
}

function testPage() {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SCUA multi-agent fixture</title>
<style>body{font-family:system-ui;padding:40px;display:grid;gap:24px;max-width:720px}section{padding:20px;border:1px solid #888;border-radius:12px}button,input{font:inherit;padding:10px 14px}</style></head>
<body>
<h1>SCUA multi-agent fixture</h1>
<section><button id="counter" aria-label="Increment counter">Increment counter</button><p id="count" aria-live="polite">Count: 0</p></section>
<section><label for="message">Agent message</label><input id="message" aria-label="Agent message"><p id="message-status" aria-live="polite">Message: empty</p></section>
<section><label><input id="feature" type="checkbox"> Enable feature</label><p id="feature-status" aria-live="polite">Feature: off</p></section>
<script>
let count=0;
document.querySelector('#counter').addEventListener('click',()=>setTimeout(()=>{count+=1;document.querySelector('#count').textContent='Count: '+count},700));
document.querySelector('#message').addEventListener('input',(event)=>{const value=event.target.value;setTimeout(()=>{document.querySelector('#message-status').textContent='Message: '+value},700)});
document.querySelector('#feature').addEventListener('change',(event)=>{const checked=event.target.checked;setTimeout(()=>{document.querySelector('#feature-status').textContent='Feature: '+(checked?'on':'off')},700)});
</script></body></html>`;
}

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return server.address().port;
}

async function closeServer(server) {
	await new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections?.();
	});
}

function firstMatch(search, label) {
	const match = search.details?.matches?.[0];
	if (!match?.ref) throw new Error(`${label} returned no actionable match: ${search.text}`);
	return match;
}

const taskSpecs = [
	{
		name: "counter",
		query: { text: "Increment counter", role: "button" },
		actions: (ref) => Array.from({ length: 3 }, () => ({ action: "press", ref })),
		expect: { text: "Count: 3", timeoutMs: 5_000 },
		verify: { text: "Count: 3" },
	},
	{
		name: "message",
		query: { text: "Agent message", role: "textbox" },
		actions: (ref, marker) => [{ action: "setText", ref, text: marker }],
		expect: (_ref, marker) => ({ text: `Message: ${marker}`, timeoutMs: 5_000 }),
		verify: (_ref, marker) => ({ text: `Message: ${marker}` }),
	},
	{
		name: "feature",
		query: { text: "Enable feature", role: "checkbox" },
		actions: (ref) => [{ action: "press", ref }],
		expect: { text: "Feature: on", timeoutMs: 5_000 },
		verify: { text: "Feature: on" },
	},
];

async function prepareBrowserTask(client, spec, baseUrl, round) {
	const marker = `SCUA-${spec.name}-${runId}-${round}`;
	const open = await client.call("open_root", { kind: "browser_page", url: `${baseUrl}/?agent=${encodeURIComponent(client.agentId)}&round=${round}` }, 45_000);
	const stateId = open.details?.stateId;
	if (!stateId) throw new Error(`${client.agentId} open_root returned no stateId.`);
	const search = await client.call("search_ui", { stateId, ...spec.query });
	const match = firstMatch(search, `${client.agentId} ${spec.name}`);
	return { client, spec, marker, stateId, ref: match.ref, prepareMs: open.durationMs + search.durationMs };
}

async function executeBrowserTask(task) {
	const startedAt = performance.now();
	const expected = typeof task.spec.expect === "function" ? task.spec.expect(task.ref, task.marker) : task.spec.expect;
	const actions = task.spec.actions(task.ref, task.marker);
	const act = await task.client.call("act_ui", { stateId: task.stateId, actions, expect: expected }, 30_000);
	const successorStateId = act.details?.stateId;
	if (!successorStateId) throw new Error(`${task.client.agentId} act_ui returned no successor state.`);
	return {
		agentId: task.client.agentId,
		task: task.spec.name,
		stateId: task.stateId,
		successorStateId,
		actionMs: act.durationMs,
		verifiedBy: "act_ui expect",
		durationMs: performance.now() - startedAt,
	};
}

async function runBrowserRound(clients, baseUrl, round, mode) {
	const prepared = await Promise.all(clients.map((client, index) => prepareBrowserTask(client, taskSpecs[index], baseUrl, `${mode}-${round}`)));
	const startedAt = performance.now();
	const results = [];
	if (mode === "parallel") {
		results.push(...await Promise.all(prepared.map(executeBrowserTask)));
	} else {
		for (const task of prepared) results.push(await executeBrowserTask(task));
	}
	const wallMs = performance.now() - startedAt;
	const serialEstimateMs = results.reduce((sum, result) => sum + result.durationMs, 0);
	return {
		mode,
		round,
		wallMs,
		serialEstimateMs,
		speedup: serialEstimateMs / wallMs,
		overlapRatio: Math.max(0, (serialEstimateMs - wallMs) / serialEstimateMs),
		results,
	};
}

async function desktopTargets() {
	const result = await macosHelper.command("listRoots", {}, { timeoutMs: 15_000 });
	const roots = result?.roots ?? result;
	const choose = (predicate, label) => {
		const root = roots.find(predicate);
		if (!root?.pid || !root?.windowId) throw new Error(`No safe desktop root found for ${label}.`);
		return root;
	};
	return [
		choose((item) => item.appName === "Calculator" && item.isOnscreen !== false, "Calculator"),
		choose((item) => item.appName === "Finder" && item.title === "Downloads" && item.isOnscreen !== false, "Finder Downloads"),
		choose((item) => item.appName === "Calendar" && item.title === "Calendar" && item.isOnscreen !== false, "Calendar"),
	];
}

async function prepareDesktopCursorTask(client, target) {
	const find = await client.call("find_roots", { pid: target.pid });
	const window = find.details?.windows?.find((candidate) => candidate.windowId === target.windowId);
	if (!window?.windowRef) throw new Error(`${client.agentId} could not resolve ${target.appName} — ${target.title}.`);
	const observe = await client.call("observe_ui", { root: window.windowRef, mode: "visual" }, 45_000);
	const stateId = observe.details?.capture?.stateId;
	const width = observe.details?.capture?.width;
	const height = observe.details?.capture?.height;
	if (!stateId || !width || !height) throw new Error(`${client.agentId} observe_ui returned no desktop capture: ${JSON.stringify(observe.details)}`);
	return { client, target, stateId, width, height, prepareMs: find.durationMs + observe.durationMs };
}

async function executeDesktopCursorTask(task, xRatio = 0.68, yRatio = 0.42) {
	const call = await task.client.call("act_ui", {
		stateId: task.stateId,
		actions: [{ action: "moveMouse", x: task.width * xRatio, y: task.height * yRatio }],
	}, 45_000);
	return { agentId: task.client.agentId, app: task.target.appName, title: task.target.title, durationMs: call.durationMs, successorStateId: call.details?.capture?.stateId, execution: call.details?.execution };
}

async function cursorWindows() {
	const source = `import CoreGraphics; import Foundation
let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for row in rows {
  let owner = row[kCGWindowOwnerName as String] as? String ?? ""
  guard owner.lowercased().contains("pi-computer-use") else { continue }
  let id = (row[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
  let bounds = row[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let x = (bounds["X"] as? NSNumber)?.intValue ?? 0
  let y = (bounds["Y"] as? NSNumber)?.intValue ?? 0
  let w = (bounds["Width"] as? NSNumber)?.intValue ?? 0
  let h = (bounds["Height"] as? NSNumber)?.intValue ?? 0
  print("\\(id),\\(x),\\(y),\\(w),\\(h)")
}`;
	const output = await new Promise((resolve, reject) => {
		execFile("swift", ["-e", source], { timeout: 15_000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
	});
	return String(output).trim().split("\n").filter(Boolean).map((line) => {
		const [id, x, y, width, height] = line.split(",").map(Number);
		return { id, x, y, width, height };
	});
}

function focusSummary(value) {
	return { pid: value?.pid, windowId: value?.windowId, appName: value?.appName, windowTitle: value?.windowTitle };
}

async function run() {
	const server = http.createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(testPage());
	});
	const port = await listen(server);
	const baseUrl = `http://127.0.0.1:${port}`;
	const clients = ["alpha", "beta", "gamma"].map((name) => new McpClient(`scua-live-${runId}-${name}`));
	const report = { runId, baseUrl, diagnostics: undefined, browser: {}, desktopCursors: {}, contention: {}, cleanup: {} };
	try {
		await Promise.all(clients.map((client) => client.initialize()));
		report.diagnostics = await macosHelper.ensureProtocol();

		// Warm each independent managed browser before measuring actions.
		await Promise.all(clients.map((client) => client.call("open_root", { kind: "browser_page", url: `${baseUrl}/?warmup=${encodeURIComponent(client.agentId)}` }, 45_000)));

		const parallelRounds = [];
		const sequentialRounds = [];
		for (let round = 1; round <= 3; round += 1) parallelRounds.push(await runBrowserRound(clients, baseUrl, round, "parallel"));
		for (let round = 1; round <= 3; round += 1) sequentialRounds.push(await runBrowserRound(clients, baseUrl, round, "sequential"));
		const sum = (values) => values.reduce((total, value) => total + value, 0);
		report.browser = {
			parallelRounds,
			sequentialRounds,
			parallelMeanWallMs: sum(parallelRounds.map((round) => round.wallMs)) / parallelRounds.length,
			sequentialMeanWallMs: sum(sequentialRounds.map((round) => round.wallMs)) / sequentialRounds.length,
		};
		report.browser.measuredSpeedup = report.browser.sequentialMeanWallMs / report.browser.parallelMeanWallMs;

		const targets = await desktopTargets();
		const cursorTasks = await Promise.all(clients.map((client, index) => prepareDesktopCursorTask(client, targets[index])));
		const beforeMouse = await macosHelper.command("getMousePosition");
		const beforeFocus = await macosHelper.command("getFrontmost");
		const cursorStartedAt = performance.now();
		const cursorResults = await Promise.all(cursorTasks.map((task) => executeDesktopCursorTask(task)));
		const cursorWallMs = performance.now() - cursorStartedAt;
		const afterMouse = await macosHelper.command("getMousePosition");
		const afterFocus = await macosHelper.command("getFrontmost");
		const overlays = await cursorWindows();
		report.desktopCursors = {
			wallMs: cursorWallMs,
			serialEstimateMs: sum(cursorResults.map((result) => result.durationMs)),
			speedup: sum(cursorResults.map((result) => result.durationMs)) / cursorWallMs,
			results: cursorResults,
			overlayCount: overlays.length,
			overlays,
			beforeMouse,
			afterMouse,
			mouseDistance: Math.hypot(afterMouse.x - beforeMouse.x, afterMouse.y - beforeMouse.y),
			beforeFocus: focusSummary(beforeFocus),
			afterFocus: focusSummary(afterFocus),
			focusUnchanged: beforeFocus.pid === afterFocus.pid && beforeFocus.windowId === afterFocus.windowId,
		};

		// Two processes observe the same physical Calculator window at one epoch,
		// then race writes. Exactly one should advance it; the other must fail stale.
		const calculator = targets[0];
		const competing = await Promise.all(clients.slice(0, 2).map((client) => prepareDesktopCursorTask(client, calculator)));
		const contentionStartedAt = performance.now();
		const contentionResults = await Promise.all(competing.map(async (task, index) => {
			const call = await task.client.callRaw("act_ui", {
				stateId: task.stateId,
				actions: [{ action: "moveMouse", x: task.width * (index === 0 ? 0.35 : 0.65), y: task.height * 0.5 }],
			}, 45_000);
			return { agentId: task.client.agentId, ok: call.ok, durationMs: call.durationMs, text: call.text };
		}));
		report.contention = {
			wallMs: performance.now() - contentionStartedAt,
			results: contentionResults,
			successCount: contentionResults.filter((result) => result.ok).length,
			staleRejectionCount: contentionResults.filter((result) => !result.ok && /stale/i.test(result.text)).length,
		};

		const browserPass = parallelRounds.every((round) => round.results.length === 3)
			&& sequentialRounds.every((round) => round.results.length === 3)
			&& report.browser.measuredSpeedup > 1.5;
		const deliverySafe = cursorResults.every((result) => result.execution?.delivery !== "hid" && result.execution?.performed?.activated !== true && result.execution?.performed?.raised !== true);
		const cursorPass = report.desktopCursors.overlayCount >= 3 && report.desktopCursors.focusUnchanged && report.desktopCursors.mouseDistance <= 0.5 && deliverySafe;
		report.desktopCursors.deliverySafe = deliverySafe;
		const contentionPass = report.contention.successCount === 1 && report.contention.staleRejectionCount === 1;
		report.pass = { browser: browserPass, desktopCursors: cursorPass, contention: contentionPass, overall: browserPass && cursorPass && contentionPass };
	} finally {
		await Promise.allSettled(clients.map((client) => client.close()));
		await closeServer(server);
		report.cleanup = { clientsClosed: true, fixtureServerClosed: true };
	}
	console.log(JSON.stringify(report, null, 2));
}

await run();
