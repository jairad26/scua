#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { macosHelper } from "../src/platform/macos/helper.ts";

if (process.env.SCUA_FOREGROUND_SHOWCASE_LIVE !== "1") {
	console.error("Set SCUA_FOREGROUND_SHOWCASE_LIVE=1 to run the foreground showcase.");
	process.exit(2);
}

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runId = `${Date.now()}-${process.pid}`;
const parallel = process.env.SCUA_SHOWCASE_PARALLEL === "1";
const batchLanes = process.env.SCUA_SHOWCASE_BATCH_LANES === "1";
const executionMode = process.env.SCUA_SHOWCASE_EXECUTION_MODE === "background" ? "background" : "foreground";

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
				SCUA_AGENT_ID: `showcase-${runId}`,
				PI_COMPUTER_USE_HEADLESS: "false",
				PI_COMPUTER_USE_CURSOR_OVERLAY: "true",
				PI_COMPUTER_USE_EXECUTION_MODE: executionMode,
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
					const timer = setTimeout(() => reject(new Error(`MCP timeout for ${key}: ${this.stderr}`)), timeoutMs);
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
			clientInfo: { name: "scua-foreground-showcase", version: "1" },
		});
		assert.equal(response?.result?.serverInfo?.name, "scua");
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}

	async call(name, args, token, allowError = false, timeoutMs = 60_000) {
		const response = await this.request("tools/call", {
			name,
			arguments: args,
			...(token ? { _meta: { scuaActorToken: token } } : {}),
		}, timeoutMs);
		const result = response?.result;
		const output = {
			ok: result?.isError === false,
			text: contentText(result),
			details: result?.structuredContent,
		};
		if (!allowError && !output.ok) throw new Error(`${name} failed: ${output.text || this.stderr}`);
		return output;
	}

	async close() {
		if (this.child.exitCode !== null) return;
		this.child.stdin.end();
		await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(3_000)]);
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
	}
}

const appSpecs = [
	{ appName: "Calculator", steps: [
		{ text: "7", role: "button", press: true },
		{ text: "Multiply", role: "button", press: true },
		{ text: "6", role: "button", press: true },
		{ text: "Equals", role: "button", press: true },
	] },
	{ appName: "Finder", title: "Downloads", steps: [{ text: "Search", role: "button" }] },
	{ appName: "Calendar", steps: [
		{ text: "next month", role: "button", press: true },
		{ text: "previous month", role: "button", press: true },
	] },
	{ appName: "Notes", steps: [{ text: "New Note", role: "button" }] },
	{ appName: "App Store", steps: [{ text: "search field", role: "textbox" }] },
	{ appName: "System Settings", steps: [{ text: "Back", role: "button" }] },
	{ appName: "Google Chrome", titlePrefix: "Example Domain", steps: [{ text: "Address and search bar", role: "textbox" }] },
	{ appName: "Spotify", steps: [{ text: "Search", role: "button" }] },
	{ appName: "Notion", steps: [{ text: "Home", role: "radio" }] },
	{ appName: "Linear", steps: [{ text: "Inbox" }] },
];

function chooseRoot(windows, spec) {
	return windows.find((candidate) => candidate.isOnscreen !== false
		&& candidate.pid
		&& candidate.windowId
		&& (spec.title === undefined || (candidate.windowTitle ?? candidate.title) === spec.title)
		&& (spec.titlePrefix === undefined || (candidate.windowTitle ?? candidate.title)?.startsWith(spec.titlePrefix)))
		?? windows.find((candidate) => candidate.isOnscreen !== false && candidate.pid && candidate.windowId);
}

async function runStep(client, actor, lane, step) {
	const startedAt = performance.now();
	const roots = await client.call("find_roots", { pid: lane.root.pid }, actor.token, false, 45_000);
	const liveRoot = (roots.details?.windows ?? []).find((candidate) => candidate.windowId === lane.root.windowId)
		?? (roots.details?.windows ?? []).find((candidate) => candidate.pid === lane.root.pid && candidate.isOnscreen !== false);
	assert(liveRoot?.windowRef, `${lane.spec.appName} root disappeared.`);
	const observed = await client.call("observe_ui", { root: liveRoot.windowRef, mode: "semantic" }, actor.token, false, 45_000);
	const stateId = observed.details?.stateId ?? observed.details?.capture?.stateId;
	assert(stateId, `${lane.spec.appName} returned no state.`);
	const searched = await client.call("search_ui", { stateId, text: step.text, role: step.role }, actor.token);
	const match = searched.details?.matches?.[0];
	assert(match?.ref, `${lane.spec.appName} could not find ${step.role} ${JSON.stringify(step.text)}.`);

	const actions = [{ action: "moveMouse", ref: match.ref }];
	if (step.press) actions.push({ action: "press", ref: match.ref });
	const acted = await client.call("act_ui", { stateId, actions }, actor.token, false, 45_000);
	await delay(step.press ? 650 : 950);
	return {
		app: lane.spec.appName,
		target: match.name ?? match.label ?? step.text,
		action: step.press ? "move+press" : "move",
		outcome: acted.details?.execution?.outcome,
		delivery: acted.details?.execution?.delivery ?? acted.details?.execution?.performed?.delivery,
		durationMs: Math.round(performance.now() - startedAt),
	};
}

async function runLaneBatched(client, actor, lane) {
	const startedAt = performance.now();
	const roots = await client.call("find_roots", { pid: lane.root.pid }, actor.token, false, 45_000);
	const liveRoot = (roots.details?.windows ?? []).find((candidate) => candidate.windowId === lane.root.windowId)
		?? (roots.details?.windows ?? []).find((candidate) => candidate.pid === lane.root.pid && candidate.isOnscreen !== false);
	assert(liveRoot?.windowRef, `${lane.spec.appName} root disappeared.`);
	const observed = await client.call("observe_ui", { root: liveRoot.windowRef, mode: "semantic" }, actor.token, false, 45_000);
	const stateId = observed.details?.stateId ?? observed.details?.capture?.stateId;
	assert(stateId, `${lane.spec.appName} returned no state.`);
	const targets = [];
	for (const step of lane.spec.steps) {
		const searched = await client.call("search_ui", { stateId, text: step.text, role: step.role }, actor.token);
		const match = searched.details?.matches?.[0];
		assert(match?.ref, `${lane.spec.appName} could not find ${step.role} ${JSON.stringify(step.text)}.`);
		targets.push({ step, match });
	}
	const actions = targets.flatMap(({ step, match }) => [
		{ action: "moveMouse", ref: match.ref },
		...(step.press ? [{ action: "press", ref: match.ref }] : []),
	]);
	const acted = await client.call("act_ui", { stateId, actions }, actor.token, false, 45_000);
	await delay(650);
	return {
		app: lane.spec.appName,
		targets: targets.map(({ step, match }) => match.name ?? match.label ?? step.text),
		actionCount: actions.length,
		outcome: acted.details?.execution?.outcome,
		durationMs: Math.round(performance.now() - startedAt),
	};
}

async function run() {
	const client = new Client();
	const actors = [];
	const report = { runId, executionMode, parallel, batchLanes, apps: [], failures: [], isolation: {} };
	try {
		await client.initialize();
		await macosHelper.ensureProtocol();
		await execFileAsync("/usr/bin/open", ["-g", "-a", "Calculator"]);
		await delay(700);
		const beforeMouse = await macosHelper.command("getMousePosition");
		const beforeFocus = await macosHelper.command("getFrontmost");
		const runSpec = async (spec) => {
			const created = await client.call("actor_session", { action: "create", maxActions: 30, ttlMs: 300_000 });
			const actor = { actorId: created.details?.actorId, token: created.details?.actorToken };
			actors.push(actor);
			try {
				const found = await client.call("find_roots", { app: spec.appName }, actor.token, false, 45_000);
				const selected = chooseRoot(found.details?.windows ?? [], spec);
				assert(selected, `No visible root for ${spec.appName}.`);
				const resourceKey = `desktop-app:${selected.pid}`;
				await client.call("claim_resource", { action: "acquire", resourceKey, ttlMs: 180_000 }, actor.token);
				const lane = { spec, root: selected };
				if (batchLanes) report.apps.push(await runLaneBatched(client, actor, lane));
				else for (const step of spec.steps) report.apps.push(await runStep(client, actor, lane, step));
			} catch (error) {
				report.failures.push({ app: spec.appName, error: error instanceof Error ? error.message : String(error) });
			}
		};
		const startedAt = performance.now();
		if (parallel) await Promise.all(appSpecs.map(runSpec));
		else for (const spec of appSpecs) await runSpec(spec);
		report.wallMs = Math.round(performance.now() - startedAt);
		const afterMouse = await macosHelper.command("getMousePosition");
		const afterFocus = await macosHelper.command("getFrontmost");
		report.isolation = {
			physicalMouseDistance: Math.round(Math.hypot(afterMouse.x - beforeMouse.x, afterMouse.y - beforeMouse.y) * 10) / 10,
			focusUnchanged: beforeFocus.pid === afterFocus.pid && beforeFocus.windowId === afterFocus.windowId,
			beforeFocus: { appName: beforeFocus.appName, windowTitle: beforeFocus.windowTitle },
			afterFocus: { appName: afterFocus.appName, windowTitle: afterFocus.windowTitle },
		};
	} finally {
		for (const actor of actors) await client.call("actor_session", { action: "close" }, actor.token, true).catch(() => {});
		await client.close();
		await execFileAsync("/usr/bin/osascript", ["-e", "tell application id \"com.openai.codex\" to activate"]).catch(() => {});
	}
	console.log(JSON.stringify(report, null, 2));
	if (report.failures.length) process.exitCode = 1;
}

await run();
