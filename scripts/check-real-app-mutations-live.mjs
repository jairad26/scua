#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

if (process.env.SCUA_REAL_APP_MUTATIONS_LIVE !== "1") {
	console.error("Set SCUA_REAL_APP_MUTATIONS_LIVE=1 to run the real-app mutation matrix.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const open = (app) => new Promise((resolve, reject) => execFile("/usr/bin/open", ["-g", "-a", app], (error) => error ? reject(error) : resolve()));

class Client {
	constructor() {
		this.nextId = 1; this.buffer = ""; this.responses = new Map(); this.waiters = new Map(); this.stderr = "";
		this.child = spawn(process.execPath, [path.join(root, "mcp/server.ts")], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_COMPUTER_USE_EXECUTION_MODE: "background" } });
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
	async request(method, params = {}, timeoutMs = 60_000) {
		const id = this.nextId++; const key = String(id); this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		if (!this.responses.has(key)) await Promise.race([
			new Promise((resolve) => this.waiters.set(key, resolve)),
			new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`MCP timeout ${key}: ${this.stderr}`)), timeoutMs); timer.unref(); }),
		]);
		this.waiters.delete(key); const response = this.responses.get(key); this.responses.delete(key); return response;
	}
	async call(name, args, token, allowError = false, timeoutMs = 60_000) {
		const startedAt = performance.now();
		const response = await this.request("tools/call", { name, arguments: args, ...(token ? { _meta: { scuaActorToken: token } } : {}) }, timeoutMs);
		const result = response?.result;
		if (!allowError && result?.isError !== false) throw new Error(`${name} failed: ${result?.content?.[0]?.text ?? this.stderr}`);
		return { ok: result?.isError === false, durationMs: performance.now() - startedAt, details: result?.structuredContent };
	}
	async close() { this.child.stdin.end(); await Promise.race([new Promise((resolve) => this.child.once("exit", resolve)), delay(3_000)]); if (this.child.exitCode === null) this.child.kill("SIGTERM"); }
}

const stateId = (result) => result.details?.stateId ?? result.details?.capture?.stateId;
async function lane(client, actor, app) {
	const roots = await client.call("find_roots", { app }, actor.token);
	const selected = (roots.details.windows ?? []).find((entry) => entry.windowRef && entry.isOnscreen !== false) ?? (roots.details.windows ?? []).find((entry) => entry.windowRef);
	assert(selected?.windowRef && selected.pid, `${app} exposed no controllable root.`);
	await client.call("claim_resource", { action: "acquire", resourceKey: `desktop-app:${selected.pid}`, ttlMs: 120_000 }, actor.token);
	const observed = await client.call("observe_ui", { root: selected.windowRef, mode: "semantic" }, actor.token, false, 45_000);
	return { actor, root: selected, stateId: stateId(observed), observeMs: observed.durationMs, nativeTimings: observed.details.timings };
}

async function notesMutation(client, actor, token) {
	const current = await lane(client, actor, "Notes");
	let searched = await client.call("search_ui", { stateId: current.stateId, text: "New Note", role: "button" }, actor.token);
	current.stateId = searched.details.stateId ?? current.stateId;
	const newButton = searched.details.matches?.find((match) => match.role === "AXButton")?.ref;
	assert(newButton, "Notes New Note button was not found.");
	let acted = await client.call("act_ui", { stateId: current.stateId, actions: [{ action: "press", ref: newButton }] }, actor.token, false, 45_000);
	let sid = stateId(acted);
	searched = await client.call("search_ui", { stateId: sid, role: "textbox", capability: "setValue" }, actor.token);
	sid = searched.details.stateId ?? sid;
	const editor = searched.details.matches?.find((match) => match.role === "AXTextArea" && match.path.includes("Note Body"));
	assert(editor?.ref, "Notes note-body editor was not found after creating a note.");
	acted = await client.call("act_ui", { stateId: sid, actions: [{ action: "setText", ref: editor.ref, text: token }], expect: { ref: editor.ref, value: token, timeoutMs: 3_000 } }, actor.token, false, 45_000);
	assert.equal(acted.details.execution?.verification?.status, "verified"); sid = stateId(acted);
	searched = await client.call("search_ui", { stateId: sid, text: "Delete", role: "button" }, actor.token);
	sid = searched.details.stateId ?? sid;
	const deleteButton = searched.details.matches?.[0]?.ref; assert(deleteButton, "Notes Delete button was not found.");
	const deleted = await client.call("act_ui", { stateId: sid, actions: [{ action: "press", ref: deleteButton }], expect: { text: token, until: "absent", timeoutMs: 3_000 } }, actor.token, false, 45_000);
	return { observeMs: current.observeMs, totalMs: deleted.durationMs + acted.durationMs, delivery: acted.details.execution?.steps?.[0]?.performed?.delivery ?? acted.details.execution?.performed?.delivery, verified: true, cleanupVerified: deleted.details.execution?.verification?.status === "verified" };
}

async function calendarMutation(client, actor, token) {
	let current = await lane(client, actor, "Calendar");
	let quick = await client.call("search_ui", { stateId: current.stateId, text: "New Quick Event", role: "textbox" }, actor.token);
	current.stateId = quick.details.stateId ?? current.stateId;
	if (quick.details.matches?.[0]?.ref) {
		const escaped = await client.call("act_ui", { stateId: current.stateId, actions: [{ action: "keypress", ref: quick.details.matches[0].ref, keys: ["ESCAPE"] }] }, actor.token, false, 45_000);
		current.stateId = stateId(escaped);
	}
	let searched = await client.call("search_ui", { stateId: current.stateId, text: "Add Event", role: "button" }, actor.token);
	current.stateId = searched.details.stateId ?? current.stateId;
	const addButton = searched.details.matches?.[0]?.ref; assert(addButton, "Calendar Add Event button was not found.");
	let acted = await client.call("act_ui", { stateId: current.stateId, actions: [{ action: "press", ref: addButton }] }, actor.token, false, 45_000);
	let sid = stateId(acted);
	searched = await client.call("search_ui", { stateId: sid, text: "New Quick Event", role: "textbox" }, actor.token);
	sid = searched.details.stateId ?? sid;
	const field = searched.details.matches?.[0]?.ref; assert(field, "Calendar quick-event editor was not found.");
	const quickEventText = `${token} tomorrow at 9am`;
	acted = await client.call("act_ui", { stateId: sid, actions: [{ action: "setText", ref: field, text: quickEventText }], expect: { ref: field, value: quickEventText, timeoutMs: 3_000 } }, actor.token, false, 45_000);
	sid = stateId(acted); assert.equal(acted.details.execution?.verification?.status, "verified");
	const committed = await client.call("act_ui", { stateId: sid, actions: [{ action: "keypress", ref: field, keys: ["ENTER"] }] }, actor.token, false, 45_000);
	sid = stateId(committed);
	const found = await client.call("search_ui", { stateId: sid, text: token }, actor.token, false, 45_000);
	sid = found.details.stateId ?? sid;
	const event = found.details.matches?.find((match) => !match.path.includes("AXTextField"));
	assert(event?.ref, "Calendar did not expose the committed event in its successor state.");
	const detailsField = found.details.matches?.find((match) => match.role === "AXTextField" && match.path.includes("AXPopover"));
	if (detailsField?.ref) {
		const escaped = await client.call("act_ui", { stateId: sid, actions: [{ action: "keypress", ref: detailsField.ref, keys: ["ESCAPE"] }] }, actor.token, false, 45_000);
		const refreshed = await client.call("observe_ui", { root: current.root.windowRef, stateId: stateId(escaped), mode: "semantic" }, actor.token, false, 45_000);
		sid = stateId(refreshed);
	}
	const freshEventSearch = await client.call("search_ui", { stateId: sid, text: token }, actor.token, false, 45_000);
	sid = freshEventSearch.details.stateId ?? sid;
	const freshEvent = freshEventSearch.details.matches?.find((match) => !match.path.includes("AXTextField"));
	if (!freshEvent?.ref) {
		return { observeMs: current.observeMs, commitOutcome: committed.details.execution?.outcome, committed: true, cleanupVerified: true, cleanupMethod: "dismissed_provisional_event" };
	}
	const removed = await client.call("act_ui", { stateId: sid, actions: [{ action: "press", ref: freshEvent.ref }, { action: "wait", ms: 80 }, { action: "keypress", ref: freshEvent.ref, keys: ["BACKSPACE"] }], expect: { text: token, until: "absent", timeoutMs: 3_000 } }, actor.token, true, 45_000);
	return { observeMs: current.observeMs, commitOutcome: committed.details.execution?.outcome, committed: true, cleanupVerified: removed.ok && removed.details.execution?.verification?.status === "verified", cleanupError: removed.ok ? undefined : removed.details.error?.code };
}

async function spotifyMutation(client, actor) {
	const current = await lane(client, actor, "Spotify");
	let searched = await client.call("search_ui", { stateId: current.stateId, text: "Search", role: "button" }, actor.token);
	current.stateId = searched.details.stateId ?? current.stateId;
	const searchButton = searched.details.matches?.[0]?.ref; assert(searchButton, "Spotify Search button was not found.");
	let acted = await client.call("act_ui", { stateId: current.stateId, actions: [{ action: "press", ref: searchButton }] }, actor.token, false, 45_000);
	let sid = stateId(acted);
	searched = await client.call("search_ui", { stateId: sid, text: "What do you want to play?" }, actor.token, false, 45_000);
	sid = searched.details.stateId ?? sid;
	const box = searched.details.matches?.find((match) => match.role === "AXComboBox" || match.role === "AXTextField"); assert(box?.ref, "Spotify Search textbox was not found.");
	const query = "Raga of Madness";
	acted = await client.call("act_ui", { stateId: sid, actions: [{ action: "setText", ref: box.ref, text: query }], expect: { text: query, timeoutMs: 5_000 } }, actor.token, false, 45_000);
	sid = stateId(acted);
	const results = await client.call("search_ui", { stateId: sid, text: query }, actor.token, false, 45_000);
	sid = results.details.stateId ?? sid;
	const resultOutsideInput = results.details.matches?.some((match) => match.ref !== box.ref && !match.path.includes("AXTextField"));
	assert.equal(resultOutsideInput, true, "Spotify accepted the field value but did not expose a search result.");
	const currentBoxSearch = await client.call("search_ui", { stateId: sid, text: "What do you want to play?" }, actor.token, false, 45_000);
	sid = currentBoxSearch.details.stateId ?? sid;
	const currentBox = currentBoxSearch.details.matches?.find((match) => match.role === "AXComboBox" || match.role === "AXTextField");
	assert(currentBox?.ref, "Spotify Search textbox disappeared before cleanup.");
	const cleared = await client.call("act_ui", { stateId: sid, actions: [{ action: "setText", ref: currentBox.ref, text: "" }] }, actor.token, true, 45_000);
	return { observeMs: current.observeMs, totalMs: acted.durationMs, delivery: acted.details.execution?.steps?.[0]?.performed?.delivery ?? acted.details.execution?.performed?.delivery, resultVerified: true, cleanupVerified: cleared.ok };
}

async function appStoreMutation(client, actor) {
	const current = await lane(client, actor, "App Store");
	const searched = await client.call("search_ui", { stateId: current.stateId, text: "search field", role: "textbox" }, actor.token, false, 45_000);
	current.stateId = searched.details.stateId ?? current.stateId;
	const field = searched.details.matches?.find((match) => match.role === "AXTextField");
	assert(field?.ref, "App Store search field was not found.");
	const query = "Notion";
	let acted = await client.call("act_ui", { stateId: current.stateId, actions: [{ action: "setText", ref: field.ref, text: query }], expect: { ref: field.ref, value: query, timeoutMs: 3_000 } }, actor.token, false, 45_000);
	let sid = stateId(acted);
	const submitFieldSearch = await client.call("search_ui", { stateId: sid, text: "search field", role: "textbox" }, actor.token, false, 45_000);
	sid = submitFieldSearch.details.stateId ?? sid;
	const submitField = submitFieldSearch.details.matches?.find((match) => match.role === "AXTextField");
	assert(submitField?.ref, "App Store search field disappeared before submit.");
	const submitted = await client.call("act_ui", { stateId: sid, actions: [{ action: "keypress", ref: submitField.ref, keys: ["ENTER"] }] }, actor.token, false, 45_000);
	sid = stateId(submitted);
	const results = await client.call("search_ui", { stateId: sid, text: query }, actor.token, false, 45_000);
	sid = results.details.stateId ?? sid;
	const outsideField = results.details.matches?.some((match) => match.ref !== submitField.ref && !match.path.includes("AXTextField"));
	assert.equal(outsideField, true, "App Store did not expose a result after submitting its generic search field.");
	const freshFieldSearch = await client.call("search_ui", { stateId: sid, text: "search field", role: "textbox" }, actor.token, false, 45_000);
	sid = freshFieldSearch.details.stateId ?? sid;
	const freshField = freshFieldSearch.details.matches?.find((match) => match.role === "AXTextField");
	const cleared = freshField?.ref ? await client.call("act_ui", { stateId: sid, actions: [{ action: "setText", ref: freshField.ref, text: "" }] }, actor.token, true, 45_000) : { ok: false };
	return { observeMs: current.observeMs, resultVerified: true, commitOutcome: submitted.details.execution?.outcome, cleanupVerified: cleared.ok };
}

const client = new Client();
const actors = [];
const report = { apps: {}, wallMs: 0 };
try {
	await Promise.all(["Notes", "Calendar", "Spotify", "App Store"].map((app) => open(app)));
	await delay(800);
	const initialized = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scua-real-app-mutations", version: "1" } });
	assert.equal(initialized?.result?.serverInfo?.name, "scua");
	for (let index = 0; index < 4; index += 1) actors.push((await client.call("actor_session", { action: "create", maxActions: 50 }, undefined)).details);
	const runToken = `SCUA compatibility ${new Date().toISOString()}`;
	const startedAt = performance.now();
	const [notes, calendar, spotify, appStore] = await Promise.all([
		notesMutation(client, actors[0], `${runToken} Notes`),
		calendarMutation(client, actors[1], `${runToken} Calendar`),
		spotifyMutation(client, actors[2]),
		appStoreMutation(client, actors[3]),
	]);
	report.wallMs = performance.now() - startedAt; report.apps = { Notes: notes, Calendar: calendar, Spotify: spotify, "App Store": appStore }; report.pass = notes.verified && calendar.committed && spotify.resultVerified && appStore.resultVerified;
} finally {
	for (const actor of actors) await client.call("actor_session", { action: "close" }, actor.actorToken, true).catch(() => undefined);
	await client.close();
}

console.log(JSON.stringify(report, null, 2));
