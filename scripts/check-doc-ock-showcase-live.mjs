#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { macosHelper } from "../src/platform/macos/helper.ts";

if (process.env.SCUA_DOC_OCK_SHOWCASE_LIVE !== "1") {
	console.error("Set SCUA_DOC_OCK_SHOWCASE_LIVE=1 to run the real-app Doc Ock showcase.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${Date.now()}-${process.pid}`;
const roundCount = Math.max(2, Math.min(4, Number(process.env.SCUA_DOC_OCK_SHOWCASE_ROUNDS ?? 3)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
				SCUA_AGENT_ID: `doc-ock-showcase-${runId}`,
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
			clientInfo: { name: "scua-doc-ock-showcase", version: "1" },
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
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
	}
}

function stateId(details) {
	return details?.stateId ?? details?.capture?.stateId;
}

function press(text, role = "button") {
	return { query: { text, role }, action: (ref) => ({ action: "press", ref }), label: `press ${text}` };
}

function setText(text, query) {
	return { query, action: (ref) => ({ action: "setText", ref, text }), label: `write ${JSON.stringify(text)}` };
}

function pointAt(text, role) {
	return { query: { text, ...(role ? { role } : {}) }, action: (ref) => ({ action: "moveMouse", ref }), label: `point at ${text}` };
}

const scratchNote = `SCUA showcase ${new Date().toISOString()}\n\nTen independent workers can observe, act, verify, and hand resources to one another without taking the physical mouse or keyboard.`;
const appSpecs = [
	{ appName: "Calculator", title: "Calculator", steps: [press("7"), press("Multiply"), press("6"), press("Equals")] },
	{ appName: "Finder", title: "Downloads", steps: [press("back"), press("forward"), press("Search")] },
	{ appName: "Calendar", title: "Calendar", steps: [press("next month"), press("previous month"), press("Today")] },
	{ appName: "Notes", title: "Notes", steps: [pointAt("New Note", "button"), setText(scratchNote, { role: "textbox", capability: "setValue" }), pointAt("Checklist", "button")] },
	{ appName: "App Store", title: "App Store", steps: [setText("productivity", { text: "search field", role: "textbox" }), setText("focus timer", { text: "search field", role: "textbox" }), press("Discover")] },
	{ appName: "System Settings", steps: [press("Back"), press("Forward"), press("Back")] },
	{ appName: "Google Chrome", titlePrefix: "SCUA Arm", steps: [setText("continuous worker one", { text: "Handoff work item", role: "textbox" }), setText("handoff received", { text: "Handoff work item", role: "textbox" }), setText("verified independently", { text: "Handoff work item", role: "textbox" })] },
	{ appName: "Spotify", title: "Spotify Premium", steps: [press("Play"), pointAt("Now playing view", "button"), pointAt("Search", "button")] },
	{ appName: "Notion", title: "Orbit Roadmap", steps: [press("Home", "radio"), press("Inbox", "radio"), press("Home", "radio")] },
	{ appName: "Linear", steps: [press("My issues", "link"), press("Inbox", "link"), press("My issues", "link")] },
];

function chooseRoot(roots, spec) {
	return roots.find((candidate) => candidate.isOnscreen !== false
		&& candidate.pid && candidate.windowId
		&& (candidate.appName ?? candidate.app) === spec.appName
		&& (spec.title === undefined || (candidate.title ?? candidate.windowTitle) === spec.title)
		&& (spec.titlePrefix === undefined || (candidate.title ?? candidate.windowTitle)?.startsWith(spec.titlePrefix)));
}

async function discoverAndClaimLane(client, actors, spec, index) {
	const found = await client.call("find_roots", { app: spec.appName }, actors[index].token, false, 45_000);
	const selected = chooseRoot(found.details?.windows ?? [], spec);
	assert(selected, `No safe visible root found for ${spec.appName}.`);
	const resourceKey = `desktop-app:${selected.pid}`;
	const claimed = await client.call("claim_resource", { action: "acquire", resourceKey, ttlMs: 120_000 }, actors[index].token);
	assert(claimed.details?.leaseId, `No initial lease for ${spec.appName}.`);
	return { index, spec, root: selected, resourceKey, leaseId: claimed.details.leaseId };
}

async function performStep(client, actors, lane, round) {
	const actorIndex = (lane.index + round) % actors.length;
	const actor = actors[actorIndex];
	const step = lane.spec.steps[round % lane.spec.steps.length];
	const startedAt = performance.now();
	let rootMs = 0;
	let observeMs = 0;
	let observedStateId = lane.transferredStateId;
	if (!observedStateId) {
		const rootsStartedAt = performance.now();
		const roots = await client.call("find_roots", { pid: lane.root.pid }, actor.token);
		rootMs = performance.now() - rootsStartedAt;
		const rootEntry = roots.details?.windows?.find((entry) => entry.windowId === lane.root.windowId)
			?? roots.details?.windows?.find((entry) => entry.pid === lane.root.pid && entry.isOnscreen !== false);
		assert(rootEntry?.windowRef, `${lane.spec.appName} root disappeared.`);
		lane.root = { ...lane.root, ...rootEntry, title: rootEntry.windowTitle ?? lane.root.title };
		const observeStartedAt = performance.now();
		const observed = await client.call("observe_ui", { root: rootEntry.windowRef, mode: "semantic" }, actor.token, false, 45_000);
		observeMs = performance.now() - observeStartedAt;
		observedStateId = stateId(observed.details);
	}
	lane.transferredStateId = undefined;
	assert(observedStateId, `${lane.spec.appName} returned no state.`);
	const searchStartedAt = performance.now();
	const searched = await client.call("search_ui", { stateId: observedStateId, ...step.query }, actor.token);
	const searchMs = performance.now() - searchStartedAt;
	const ref = searched.details?.matches?.[0]?.ref;
	assert(ref, `${lane.spec.appName} could not find ${JSON.stringify(step.query)}.`);
	const actionStartedAt = performance.now();
	const acted = await client.call("act_ui", {
		stateId: observedStateId,
		actions: [step.action(ref)],
	}, actor.token, false, 45_000);
	const actionMs = performance.now() - actionStartedAt;
	const execution = acted.details?.execution;
	const record = {
		lane: lane.index + 1,
		app: lane.spec.appName,
		round: round + 1,
		actor: actorIndex + 1,
		action: step.label,
		outcome: execution?.outcome,
		delivery: execution?.delivery ?? execution?.performed?.delivery,
		rootMs,
		observeMs,
		searchMs,
		actionMs,
		deliveryMs: execution?.evidence?.deliveryMs,
		successorObservationMs: execution?.evidence?.successorObservationMs,
		durationMs: performance.now() - startedAt,
	};
	if (round < roundCount - 1) {
		const nextActorIndex = (lane.index + round + 1) % actors.length;
		const handed = await client.call("claim_resource", {
			action: "handoff",
			resourceKey: lane.resourceKey,
			leaseId: lane.leaseId,
			recipientActorId: actors[nextActorIndex].actorId,
			ttlMs: 120_000,
		}, actor.token);
		lane.leaseId = handed.details?.leaseId;
		lane.transferredStateId = handed.details?.stateId;
		record.handoffTo = nextActorIndex + 1;
		record.handoffStateTransferred = Boolean(lane.transferredStateId);
	}
	return record;
}

async function runLane(client, actors, lane) {
	// Deliberately avoid a global barrier: each worker progresses and hands off
	// as soon as its own app is ready, so motion remains continuous under load.
	await delay(80 + lane.index * 110);
	const records = [];
	for (let round = 0; round < roundCount; round += 1) {
		records.push(await performStep(client, actors, lane, round));
		await delay(140 + (lane.index % 3) * 70);
	}
	return records;
}

async function run() {
	const client = new Client();
	const actors = [];
	const report = { runId, roundCount, actorCount: appSpecs.length, lanes: [], failedLanes: [], isolation: {} };
	try {
		await client.initialize();
		await macosHelper.ensureProtocol();
		for (let index = 0; index < appSpecs.length; index += 1) {
			const created = await client.call("actor_session", { action: "create", maxActions: 100, ttlMs: 300_000 });
			actors.push({ actorId: created.details?.actorId, token: created.details?.actorToken });
		}
		const beforeMouse = await macosHelper.command("getMousePosition");
		const beforeFocus = await macosHelper.command("getFrontmost");
		const startedAt = performance.now();
		const settled = await Promise.allSettled(appSpecs.map(async (spec, index) => {
			const lane = await discoverAndClaimLane(client, actors, spec, index);
			return await runLane(client, actors, lane);
		}));
		report.wallMs = performance.now() - startedAt;
		settled.forEach((result, index) => {
			if (result.status === "fulfilled") report.lanes.push(...result.value);
			else report.failedLanes.push({ app: appSpecs[index].appName, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
		});
		const afterMouse = await macosHelper.command("getMousePosition");
		const afterFocus = await macosHelper.command("getFrontmost");
		report.isolation = {
			physicalMouseDistance: Math.hypot(afterMouse.x - beforeMouse.x, afterMouse.y - beforeMouse.y),
			focusUnchanged: beforeFocus.pid === afterFocus.pid && beforeFocus.windowId === afterFocus.windowId,
			beforeFocus: { appName: beforeFocus.appName, windowTitle: beforeFocus.windowTitle },
			afterFocus: { appName: afterFocus.appName, windowTitle: afterFocus.windowTitle },
		};
		report.summary = {
			completedActions: report.lanes.length,
			handoffs: report.lanes.filter((entry) => entry.handoffTo).length,
			nonInterferenceGuardAccepted: report.lanes.length,
		};
		for (const actor of actors) await client.call("actor_session", { action: "close" }, actor.token, true);
	} finally {
		await client.close();
	}
	console.log(JSON.stringify(report, null, 2));
	if (report.failedLanes.length) process.exitCode = 1;
}

await run();
