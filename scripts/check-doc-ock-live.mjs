#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { macosHelper } from "../src/platform/macos/helper.ts";

if (process.env.SCUA_DOC_OCK_LIVE !== "1") {
	console.error("Set SCUA_DOC_OCK_LIVE=1 to run the ten-actor Doc Ock stress test.");
	process.exit(2);
}

const ACTOR_COUNT = 10;
const WAVE_COUNT = Math.max(2, Math.min(10, Number(process.env.SCUA_DOC_OCK_WAVES ?? 4)));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${Date.now()}-${process.pid}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browserMutationStarts = new Set();

function contentText(result) {
	return (result?.content ?? []).map((item) => item?.text ?? "").filter(Boolean).join("\n");
}

class Client {
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
				SCUA_AGENT_ID: `doc-ock-${runId}`,
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

	async request(method, params = {}, timeoutMs = 60_000) {
		const id = this.nextId++;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		const key = String(id);
		if (!this.responses.has(key)) {
			await Promise.race([
				new Promise((resolve) => this.waiters.set(key, resolve)),
				new Promise((_, reject) => {
					const timer = setTimeout(() => reject(new Error(`MCP timeout for request ${key}: ${this.stderr}`)), timeoutMs);
					timer.unref();
				}),
			]);
		}
		this.waiters.delete(key);
		const message = this.responses.get(key);
		this.responses.delete(key);
		return message;
	}

	async initialize() {
		const response = await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "scua-doc-ock-live", version: "1" },
		});
		assert.equal(response?.result?.serverInfo?.name, "scua", "SCUA MCP did not initialize.");
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}

	async call(name, args, token, allowError = false, timeoutMs = 60_000) {
		const startedAt = performance.now();
		const response = await this.request("tools/call", {
			name,
			arguments: args,
			...(token ? { _meta: { scuaActorToken: token } } : {}),
		}, timeoutMs);
		const result = response?.result;
		const output = {
			ok: result?.isError === false,
			durationMs: performance.now() - startedAt,
			text: contentText(result),
			details: result?.structuredContent,
		};
		if (!allowError && !output.ok) throw new Error(`${name} failed: ${output.text || this.stderr}`);
		return output;
	}

	async close() {
		if (this.child.exitCode !== null) return;
		this.child.stdin.end();
		await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(4_000)]);
		if (this.child.exitCode === null) {
			this.child.kill("SIGTERM");
			await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(2_000)]);
		}
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
	}
}

function fixturePage(requestUrl) {
	const url = new URL(requestUrl, "http://127.0.0.1");
	const lane = Number(url.searchParams.get("lane") ?? 0);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SCUA Arm ${lane + 1}</title>
<style>body{font-family:system-ui;padding:36px;max-width:680px}main{border:1px solid #888;border-radius:16px;padding:24px}input{font:inherit;width:90%;padding:12px}p{font-size:18px}</style></head>
<body><main><h1>SCUA arm ${lane + 1}</h1><label for="work">Handoff work item</label><input id="work" aria-label="Handoff work item"><p id="status" aria-live="polite">Lane ${lane + 1}: idle</p></main>
<script>const lane=${lane + 1};let generation=0;document.querySelector('#work').addEventListener('input',(event)=>{const value=event.target.value;const own=++generation;fetch('/_started?marker='+encodeURIComponent(value),{cache:'no-store'}).catch(()=>{});setTimeout(()=>{if(own===generation)document.querySelector('#status').textContent='Lane '+lane+': '+value},650)})</script></body></html>`;
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

function stateId(details) {
	return details?.stateId ?? details?.capture?.stateId;
}

function errorCode(call) {
	return call.details?.error?.code;
}

function ownerFor(resourceIndex, wave) {
	return (resourceIndex + wave) % ACTOR_COUNT;
}

function nextOwnerFor(resourceIndex, wave) {
	return ownerFor(resourceIndex, wave + 1);
}

async function waitUntil(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
		await delay(10);
	}
}

async function visibleCursorWindows() {
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

async function safeDesktopTargets() {
	const result = await macosHelper.command("listRoots", {}, { timeoutMs: 15_000 });
	const roots = result?.roots ?? result;
	const preferences = [
		{ appName: "Calculator", title: "Calculator" },
		{ appName: "Finder", title: "Downloads" },
		{ appName: "Calendar", title: "Calendar" },
		{ appName: "Notes", title: "Notes" },
		{ appName: "App Store", title: "App Store" },
		{ appName: "System Settings", title: "Accessibility" },
		{ appName: "Google Chrome", title: "Example Domain - Google Chrome" },
		{ appName: "Spotify", title: "Spotify Premium" },
		{ appName: "Notion", title: "Orbit Roadmap" },
		{ appName: "Linear" },
	];
	const selected = [];
	for (const preference of preferences) {
		const match = roots.find((candidate) => candidate.isOnscreen !== false
			&& candidate.pid && candidate.windowId
			&& candidate.appName === preference.appName
			&& (preference.title === undefined || candidate.title === preference.title)
			&& !selected.some((entry) => entry.pid === candidate.pid));
		if (match) selected.push(match);
	}
	assert.equal(selected.length, ACTOR_COUNT, `Need ${ACTOR_COUNT} safe visible desktop roots; found ${selected.length}: ${selected.map((item) => item.appName).join(", ")}`);
	return selected;
}

async function prepareBrowserTask(client, actors, browserResources, resourceIndex, wave) {
	const actorIndex = ownerFor(resourceIndex, wave);
	const actor = actors[actorIndex];
	const roots = await client.call("find_roots", { kind: "browser_page" }, actor.token);
	const rootEntry = roots.details?.windows?.find((entry) => entry.url?.includes(`lane=${resourceIndex}`));
	assert(rootEntry?.windowRef, `Actor ${actorIndex + 1} could not discover browser lane ${resourceIndex + 1}.`);
	const observed = await client.call("observe_ui", { root: rootEntry.windowRef, mode: "semantic" }, actor.token);
	const observedStateId = stateId(observed.details);
	assert(observedStateId, `Browser lane ${resourceIndex + 1} returned no state.`);
	const searched = await client.call("search_ui", { stateId: observedStateId, text: "Handoff work item", role: "textbox" }, actor.token);
	const ref = searched.details?.matches?.[0]?.ref;
	assert(ref, `Browser lane ${resourceIndex + 1} returned no textbox.`);
	const marker = `wave-${wave + 1} actor-${actorIndex + 1}`;
	return {
		actor,
		actorIndex,
		resourceIndex,
		resource: browserResources[resourceIndex],
		stateId: observedStateId,
		ref,
		marker,
	};
}

async function prepareDesktopTask(client, actors, desktopResources, resourceIndex, wave) {
	const actorIndex = ownerFor(resourceIndex, wave);
	const actor = actors[actorIndex];
	const resource = desktopResources[resourceIndex];
	const roots = await client.call("find_roots", { pid: resource.target.pid }, actor.token);
	const rootEntry = roots.details?.windows?.find((entry) => entry.windowId === resource.target.windowId);
	assert(rootEntry?.windowRef, `Actor ${actorIndex + 1} could not resolve ${resource.target.appName}.`);
	const observed = await client.call("observe_ui", { root: rootEntry.windowRef, mode: "semantic" }, actor.token, false, 45_000);
	const observedStateId = stateId(observed.details);
	assert(observedStateId, `${resource.target.appName} returned no usable desktop state.`);
	const searched = await client.call("search_ui", { stateId: observedStateId, role: "window" }, actor.token);
	const matches = searched.details?.matches ?? [];
	assert(matches.length > 0, `${resource.target.appName} returned no semantic window target for its visual cursor.`);
	const match = matches[0];
	return { actor, actorIndex, resourceIndex, resource, stateId: observedStateId, ref: match.ref, label: match.label };
}

async function executeBrowserTask(client, task, wave) {
	const startedAt = performance.now();
	const call = await client.call("act_ui", {
		stateId: task.stateId,
		actions: [{ action: "setText", ref: task.ref, text: task.marker }],
		expect: { text: `Lane ${task.resourceIndex + 1}: ${task.marker}`, timeoutMs: 5_000 },
	}, task.actor.token, false, 30_000);
	assert.equal(call.details?.execution?.delivery, "cdp");
	assert.equal(call.details?.execution?.verification?.status, "verified");
	return {
		type: "browser",
		wave: wave + 1,
		actor: task.actorIndex + 1,
		lane: task.resourceIndex + 1,
		durationMs: performance.now() - startedAt,
		stateId: stateId(call.details),
	};
}

async function executeDesktopTask(client, task, wave) {
	const startedAt = performance.now();
	const call = await client.call("act_ui", {
		stateId: task.stateId,
		actions: [{ action: "moveMouse", ref: task.ref }],
	}, task.actor.token, false, 45_000);
	return {
		type: "cursor",
		wave: wave + 1,
		actor: task.actorIndex + 1,
		app: task.resource.target.appName,
		target: task.label,
		durationMs: performance.now() - startedAt,
		delivery: call.details?.execution?.delivery,
		performed: call.details?.execution?.performed,
		stateId: stateId(call.details),
	};
}

async function handoffRing(client, actors, resources, wave) {
	return await Promise.all(resources.map(async (resource, resourceIndex) => {
		const fromIndex = ownerFor(resourceIndex, wave);
		const toIndex = nextOwnerFor(resourceIndex, wave);
		const handed = await client.call("claim_resource", {
			action: "handoff",
			resourceKey: resource.key,
			leaseId: resource.leaseId,
			recipientActorId: actors[toIndex].actorId,
			ttlMs: 120_000,
		}, actors[fromIndex].token);
		resource.leaseId = handed.details?.leaseId;
		resource.generation = handed.details?.generation;
		assert(resource.leaseId, `Handoff returned no lease for ${resource.key}.`);
		return { resourceKey: resource.key, from: fromIndex + 1, to: toIndex + 1, generation: resource.generation };
	}));
}

async function run() {
	const fixtureServer = http.createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/_started") {
			const marker = requestUrl.searchParams.get("marker");
			if (marker) browserMutationStarts.add(marker);
			response.writeHead(204, { "cache-control": "no-store" });
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(fixturePage(request.url ?? "/"));
	});
	const port = await listen(fixtureServer);
	const baseUrl = `http://127.0.0.1:${port}`;
	const client = new Client();
	const actors = [];
	const report = {
		runId,
		actorCount: ACTOR_COUNT,
		mcpProcessCount: 1,
		managedBrowserCount: 1,
		nativePipelineLimit: ACTOR_COUNT,
		waveCount: WAVE_COUNT,
		browserMutations: 0,
		cursorMoves: 0,
		handoffs: 0,
		busyHandoffRejections: 0,
		waves: [],
		desktopTargets: [],
		isolation: {},
		cleanup: {},
	};
	try {
		await client.initialize();
		report.diagnostics = await macosHelper.ensureProtocol();
		for (let index = 0; index < ACTOR_COUNT; index += 1) {
			const created = await client.call("actor_session", { action: "create", maxActions: 100, ttlMs: 300_000 });
			actors.push({ actorId: created.details?.actorId, token: created.details?.actorToken, index });
		}

		const desktopTargets = await safeDesktopTargets();
		report.desktopTargets = desktopTargets.map(({ appName, title, pid, windowId }) => ({ appName, title, pid, windowId }));

		const browserResources = await Promise.all(actors.map(async (actor, resourceIndex) => {
			const opened = await client.call("open_root", { kind: "browser_page", url: `${baseUrl}/?lane=${resourceIndex}` }, actor.token, false, 45_000);
			const resource = opened.details?.resource;
			assert(resource?.key, `Browser lane ${resourceIndex + 1} returned no resource.`);
			const claimed = await client.call("claim_resource", { action: "acquire", resourceKey: resource.key, ttlMs: 120_000 }, actor.token);
			return { key: resource.key, leaseId: claimed.details?.leaseId, generation: claimed.details?.generation, lane: resourceIndex };
		}));

		const desktopResources = await Promise.all(desktopTargets.map(async (target, resourceIndex) => {
			const key = `desktop-app:${target.pid}`;
			const claimed = await client.call("claim_resource", { action: "acquire", resourceKey: key, ttlMs: 120_000 }, actors[resourceIndex].token);
			return { key, leaseId: claimed.details?.leaseId, generation: claimed.details?.generation, target };
		}));

		const beforeMouse = await macosHelper.command("getMousePosition");
		const beforeFocus = await macosHelper.command("getFrontmost");

		for (let wave = 0; wave < WAVE_COUNT; wave += 1) {
			const preparedAt = performance.now();
			const [browserTasks, desktopTasks] = await Promise.all([
				Promise.all(browserResources.map((_resource, resourceIndex) => prepareBrowserTask(client, actors, browserResources, resourceIndex, wave))),
				Promise.all(desktopResources.map((_resource, resourceIndex) => prepareDesktopTask(client, actors, desktopResources, resourceIndex, wave))),
			]);
			const prepareMs = performance.now() - preparedAt;

			const executionStartedAt = performance.now();
			const browserPromises = browserTasks.map((task) => executeBrowserTask(client, task, wave));
			const browserStartedAt = performance.now();
			const browserCompletion = Promise.all(browserPromises).then((results) => ({ results, wallMs: performance.now() - browserStartedAt }));
			const cursorPromise = Promise.all(desktopTasks.map((task) => executeDesktopTask(client, task, wave)));

			await waitUntil(() => browserTasks.every((task) => browserMutationStarts.has(task.marker)), 3_000, `all ${ACTOR_COUNT} browser mutations in wave ${wave + 1}`);
			const busyProbes = await Promise.all(browserResources.map(async (resource, resourceIndex) => {
				const fromIndex = ownerFor(resourceIndex, wave);
				const toIndex = nextOwnerFor(resourceIndex, wave);
				return await client.call("claim_resource", {
					action: "handoff",
					resourceKey: resource.key,
					leaseId: resource.leaseId,
					recipientActorId: actors[toIndex].actorId,
				}, actors[fromIndex].token, true);
			}));
			const busyCount = busyProbes.filter((call) => !call.ok && errorCode(call) === "resource_busy").length;
			report.busyHandoffRejections += busyCount;

			const [browserCompletionResult, cursorResults] = await Promise.all([browserCompletion, cursorPromise]);
			const browserResults = browserCompletionResult.results;
			const results = [...browserResults, ...cursorResults];
			const wallMs = performance.now() - executionStartedAt;
			const serialEstimateMs = results.reduce((sum, result) => sum + result.durationMs, 0);
			report.browserMutations += browserPromises.length;
			report.cursorMoves += cursorResults.length;
			const waveReport = {
				wave: wave + 1,
				prepareMs,
				wallMs,
				serialEstimateMs,
				speedup: serialEstimateMs / wallMs,
				overlapRatio: Math.max(0, (serialEstimateMs - wallMs) / serialEstimateMs),
				browserWallMs: browserCompletionResult.wallMs,
				browserSerialEstimateMs: browserResults.reduce((sum, result) => sum + result.durationMs, 0),
				busyHandoffRejections: busyCount,
				browser: results.filter((result) => result.type === "browser"),
				cursors: results.filter((result) => result.type === "cursor"),
			};
			waveReport.browserSpeedup = waveReport.browserSerialEstimateMs / waveReport.browserWallMs;
			waveReport.browserOverlapRatio = Math.max(0, (waveReport.browserSerialEstimateMs - waveReport.browserWallMs) / waveReport.browserSerialEstimateMs);

			if (wave < WAVE_COUNT - 1) {
				const sample = browserTasks[0];
				const sampleSuccessor = browserResults.find((result) => result.lane === sample.resourceIndex + 1)?.stateId;
				assert(sampleSuccessor, `Wave ${wave + 1} returned no successor state for the fencing probe.`);
				const sampleSearch = await client.call("search_ui", { stateId: sampleSuccessor, text: "Handoff work item", role: "textbox" }, sample.actor.token);
				const sampleSuccessorRef = sampleSearch.details?.matches?.[0]?.ref;
				assert(sampleSuccessorRef, `Wave ${wave + 1} returned no successor ref for the fencing probe.`);

				const [browserHandoffs, desktopHandoffs] = await Promise.all([
					handoffRing(client, actors, browserResources, wave),
					handoffRing(client, actors, desktopResources, wave),
				]);
				report.handoffs += browserHandoffs.length + desktopHandoffs.length;
				waveReport.handoffs = { browser: browserHandoffs, desktop: desktopHandoffs };

				const oldOwnerAttempt = await client.call("act_ui", {
					stateId: sampleSuccessor,
					actions: [{ action: "setText", ref: sampleSuccessorRef, text: "stale-owner-should-fail" }],
				}, sample.actor.token, true);
				assert.equal(errorCode(oldOwnerAttempt), "resource_owned", `Old owner did not receive a typed ownership rejection after wave ${wave + 1}: ${JSON.stringify(oldOwnerAttempt.details?.error)}`);
				const recipientIndex = nextOwnerFor(0, wave);
				const recipientOldState = await client.call("search_ui", { stateId: sampleSuccessor, text: "Handoff work item" }, actors[recipientIndex].token, true);
				assert.equal(errorCode(recipientOldState), "state_unavailable", `Recipient reused another actor's state after wave ${wave + 1}.`);
				waveReport.fencing = { oldOwnerRejected: true, oldOwnerErrorCode: errorCode(oldOwnerAttempt), recipientOldStateRejected: true };
			}
			report.waves.push(waveReport);
		}

		const overlays = await visibleCursorWindows();
		const afterMouse = await macosHelper.command("getMousePosition");
		const afterFocus = await macosHelper.command("getFrontmost");
		const cursorResults = report.waves.flatMap((wave) => wave.cursors);
		const deliverySafe = cursorResults.every((result) => result.delivery !== "hid"
			&& result.performed?.activated !== true
			&& result.performed?.raised !== true);
		report.isolation = {
			overlayCount: overlays.length,
			overlays,
			beforeMouse,
			afterMouse,
			physicalMouseDistance: Math.hypot(afterMouse.x - beforeMouse.x, afterMouse.y - beforeMouse.y),
			beforeFocus: focusSummary(beforeFocus),
			afterFocus: focusSummary(afterFocus),
			focusUnchanged: beforeFocus.pid === afterFocus.pid && beforeFocus.windowId === afterFocus.windowId,
			deliverySafe,
		};

		const meanSpeedup = report.waves.reduce((sum, wave) => sum + wave.browserSpeedup, 0) / report.waves.length;
		const minimumSpeedup = Math.min(...report.waves.map((wave) => wave.browserSpeedup));
		report.summary = {
			logicalOperations: report.browserMutations + report.cursorMoves,
			meanSpeedup,
			minimumSpeedup,
			meanOverlapRatio: report.waves.reduce((sum, wave) => sum + wave.browserOverlapRatio, 0) / report.waves.length,
		};
		report.pass = {
			parallel: minimumSpeedup > 4,
			handoffs: report.handoffs === (WAVE_COUNT - 1) * ACTOR_COUNT * 2,
			busyFencing: report.busyHandoffRejections === WAVE_COUNT * ACTOR_COUNT,
			independentCursors: overlays.length >= ACTOR_COUNT,
			nonInterference: deliverySafe,
		};
		report.pass.overall = Object.values(report.pass).every(Boolean);
		if (!report.pass.overall) console.error(JSON.stringify(report, null, 2));
		assert.equal(report.pass.overall, true, `Doc Ock stress test failed: ${JSON.stringify(report.pass)}`);

		for (const actor of actors) await client.call("actor_session", { action: "close" }, actor.token);
	} finally {
		await client.close();
		await closeServer(fixtureServer);
		report.cleanup = { actorsClosed: actors.length, mcpClosed: true, fixtureServerClosed: true };
	}
	console.log(JSON.stringify(report, null, 2));
}

await run();
