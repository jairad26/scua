#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ScuaMcpClient } from "../benchmarks/lib/mcp-client.mjs";
import { macosHelper } from "../src/platform/macos/helper.ts";

if (process.env.SCUA_ELECTRON_COMPATIBILITY_LIVE !== "1") {
	console.error("Set SCUA_ELECTRON_COMPATIBILITY_LIVE=1 to run the Electron/custom-rendered compatibility gate.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const open = (app) => new Promise((resolve, reject) => execFile("/usr/bin/open", ["-g", "-a", app], (error) => error ? reject(error) : resolve()));
const stateId = (result) => result.details?.capture?.stateId ?? result.details?.stateId;
const skipped = new Set(String(process.env.SCUA_SKIP_ELECTRON_APPS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));

function clientFor(app) {
	return new ScuaMcpClient({
		root,
		actorId: `electron-compat-${app.toLowerCase()}-${process.pid}`,
		env: {
			PI_COMPUTER_USE_EXECUTION_MODE: "background",
			PI_COMPUTER_USE_HEADLESS: "0",
			PI_COMPUTER_USE_CURSOR_OVERLAY: "1",
		},
	});
}

async function observeApp(client, app, mode = "semantic") {
	let selected;
	for (let attempt = 0; attempt < 20 && !selected; attempt += 1) {
		const roots = await client.call("find_roots", { app });
		const candidates = (roots.details.windows ?? []).filter((candidate) => candidate.windowRef);
		selected = candidates.find((candidate) => candidate.isMain && candidate.isOnscreen !== false)
			?? candidates.find((candidate) => candidate.isFocused && candidate.isOnscreen !== false)
			?? candidates.filter((candidate) => candidate.isOnscreen !== false).sort((left, right) => (right.framePoints?.w ?? 0) * (right.framePoints?.h ?? 0) - (left.framePoints?.w ?? 0) * (left.framePoints?.h ?? 0))[0]
			?? candidates[0];
		if (!selected) await delay(250);
	}
	assert(selected?.windowRef, `${app} exposed no controllable root.`);
	const startedAt = performance.now();
	const observed = await client.call("observe_ui", { root: selected.windowRef, mode }, 45_000);
	return { root: selected, observed, stateId: stateId(observed), observeMs: performance.now() - startedAt };
}

function exactEditable(matches, labelPattern) {
	const editable = (match) => match.ref && (match.capabilities ?? []).includes("setValue");
	return (matches ?? []).find((match) => editable(match) && labelPattern.test(`${match.label} ${match.placeholder ?? ""}`))
		?? (matches ?? []).find(editable);
}

function backgroundDeliveryEvidence(result, label) {
	const execution = result.details?.execution;
	const steps = execution?.steps ?? [execution];
	const deliveries = steps.map((step) => step?.performed?.delivery ?? step?.delivery).filter(Boolean);
	assert(deliveries.length > 0, `${label} omitted delivery evidence.`);
	assert(deliveries.every((delivery) => delivery !== "hid"), `${label} used physical HID delivery: ${JSON.stringify(execution)}`);
	assert(!steps.some((step) => step?.performed?.activated || step?.performed?.raised || step?.foregrounded), `${label} activated or raised the application: ${JSON.stringify(execution)}`);
	return deliveries;
}

async function reversibleSearch(app, query, labelPattern, marker) {
	const client = clientFor(app);
	try {
		await client.initialize();
		const current = await observeApp(client, app);
		let searched = await client.call("search_ui", { stateId: current.stateId, ...query }, 45_000);
		const field = exactEditable(searched.details.matches, labelPattern);
		assert(field?.ref, `${app} did not expose its search field: ${searched.text}`);
		const setStartedAt = performance.now();
		let acted = await client.call("act_ui", {
			stateId: stateId(searched) ?? current.stateId,
			actions: [{ action: "setText", ref: field.ref, text: marker }],
			expect: { ref: field.ref, value: marker, timeoutMs: 5_000 },
		}, 45_000);
		assert.equal(acted.details.execution?.verification?.status, "verified", `${app} did not verify the search-field value: ${JSON.stringify(acted.details)}`);
		const setMs = performance.now() - setStartedAt;
		const deliveries = backgroundDeliveryEvidence(acted, `${app} search write`);
		const cleared = await client.call("act_ui", {
			stateId: stateId(acted),
			actions: [{ action: "setText", ref: field.ref, text: "" }],
			expect: { ref: field.ref, value: "", timeoutMs: 5_000 },
		}, 45_000);
		assert.equal(cleared.details.execution?.verification?.status, "verified", `${app} did not verify search cleanup: ${JSON.stringify(cleared.details)}`);
		const cleanupDeliveries = backgroundDeliveryEvidence(cleared, `${app} search cleanup`);
		return {
			observeMs: current.observeMs,
			setMs,
			deliveries,
			cleanupDeliveries,
			verified: true,
			cleanupVerified: true,
			verificationEvidence: acted.details.execution?.evidence,
		};
	} finally {
		await client.close();
	}
}

async function notionFieldIdentity() {
	const client = clientFor("Notion");
	try {
		await client.initialize();
		const current = await observeApp(client, "Notion");
		const searched = await client.call("search_ui", {
			stateId: current.stateId,
			queries: [
				{ id: "title", text: current.root.windowTitle, role: "textbox", capability: "setValue" },
				{ id: "all", role: "textbox", capability: "setValue" },
			],
		}, 45_000);
		const title = searched.details.queryResults?.find((result) => result.id === "title")?.matches?.[0];
		const fields = searched.details.queryResults?.find((result) => result.id === "all")?.matches ?? [];
		const body = fields.filter((match) => match.ref !== title?.ref).sort((left, right) => right.label.length - left.label.length)[0];
		assert(title?.ref && body?.ref && title.ref !== body.ref, `Notion did not expose distinct title/body fields: ${searched.text}`);
		return { observeMs: current.observeMs, titleRef: title.ref, bodyRef: body.ref, distinctFields: true };
	} finally {
		await client.close();
	}
}

async function linearCommandMenu() {
	const client = clientFor("Linear");
	try {
		await client.initialize();
		const current = await observeApp(client, "Linear", "fused");
		let searched = await client.call("search_ui", { stateId: current.stateId, text: "Search workspace", capability: "press" }, 45_000);
		const trigger = searched.details.matches?.find((match) => match.ref && (match.actions ?? []).some((action) => /press/i.test(action)));
		assert(trigger?.ref, `Linear did not expose Search workspace after fused observation: ${searched.text}`);
		let acted = await client.call("act_ui", {
			stateId: stateId(searched) ?? current.stateId,
			actions: [{ action: "keypress", ref: trigger.ref, keys: ["CMD", "K"] }],
			expect: { text: "Search issues, projects, and documents…", role: "textbox", timeoutMs: 5_000 },
		}, 45_000);
		if (!["verified", "preexisting"].includes(acted.details.execution?.verification?.status)) {
			const diagnostic = stateId(acted)
				? await client.call("search_ui", { stateId: stateId(acted), queries: [
					{ id: "role", role: "textbox", capability: "setValue" },
					{ id: "exact", text: "Search issues, projects, and documents…", role: "textbox" },
				] }, 45_000)
				: undefined;
			assert.fail(`Linear workspace search did not open: ${JSON.stringify(acted.details.execution)}${diagnostic ? `\n${diagnostic.text}` : ""}`);
		}
		assert.equal(acted.details.execution?.outcome, "worked", `Linear workspace search had no causal successor evidence: ${JSON.stringify(acted.details.execution)}`);
		const openDeliveries = backgroundDeliveryEvidence(acted, "Linear workspace-search open");
		searched = await client.call("search_ui", { stateId: stateId(acted), text: "Search issues, projects, and documents…", role: "textbox", capability: "setValue" }, 45_000);
		const field = exactEditable(searched.details.matches, /search issues, projects, and documents/i);
		assert(field?.ref, `Linear workspace-search field was not found: ${searched.text}`);
		const marker = `scua-linear-${process.pid}`;
		acted = await client.call("act_ui", {
			stateId: stateId(searched) ?? stateId(acted),
			actions: [{ action: "setText", ref: field.ref, text: marker }],
			expect: { ref: field.ref, value: marker, timeoutMs: 5_000 },
		}, 45_000);
		assert.equal(acted.details.execution?.verification?.status, "verified", `Linear workspace-search value was not verified: ${JSON.stringify(acted.details.execution)}`);
		const writeDeliveries = backgroundDeliveryEvidence(acted, "Linear workspace-search write");
		const dismissed = await client.call("act_ui", {
			stateId: stateId(acted),
			actions: [{ action: "keypress", ref: field.ref, keys: ["ESCAPE"] }],
			expect: { text: "Search issues, projects, and documents…", role: "textbox", until: "absent", timeoutMs: 5_000 },
		}, 45_000);
		assert.equal(dismissed.details.execution?.verification?.status, "verified", "Linear search cleanup was not verified.");
		const cleanupDeliveries = backgroundDeliveryEvidence(dismissed, "Linear workspace-search cleanup");
		return { observeMs: current.observeMs, openDeliveries, writeDeliveries, cleanupDeliveries, searchValueVerified: true, cleanupVerified: true };
	} finally {
		await client.close();
	}
}

const appRuns = [
	["Notion", notionFieldIdentity],
	["Slack", () => reversibleSearch("Slack", { text: "Channel or user name", role: "textbox", capability: "setValue" }, /channel or user|find a conversation/i, `scua-slack-${process.pid}`)],
	["Discord", () => reversibleSearch("Discord", { text: "Search", role: "textbox", capability: "setValue" }, /^search\b/i, `scua-discord-${process.pid}`)],
	["Postman", () => reversibleSearch("Postman", { text: "Search collections", role: "textbox", capability: "setValue" }, /search collections/i, `scua-postman-${process.pid}`)],
	["Linear", linearCommandMenu],
];

const enabled = appRuns.filter(([app]) => !skipped.has(app.toLowerCase()));
const report = { apps: {}, wallMs: 0, observedPointerDisplacement: 0, observedForegroundUnchanged: false, pass: false };
await Promise.all(enabled.map(([app]) => open(app)));
await delay(800);
const beforeMouse = await macosHelper.command("getMousePosition");
const beforeFocus = await macosHelper.command("getFrontmost");
const startedAt = performance.now();
const settled = await Promise.allSettled(enabled.map(async ([app, run]) => [app, await run()]));
report.wallMs = performance.now() - startedAt;
for (let index = 0; index < settled.length; index += 1) {
	const app = enabled[index][0];
	const result = settled[index];
	if (result.status === "fulfilled") report.apps[app] = result.value[1];
	else report.apps[app] = { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}
const afterMouse = await macosHelper.command("getMousePosition");
const afterFocus = await macosHelper.command("getFrontmost");
report.observedPointerDisplacement = Math.hypot((afterMouse.x ?? 0) - (beforeMouse.x ?? 0), (afterMouse.y ?? 0) - (beforeMouse.y ?? 0));
report.observedForegroundUnchanged = beforeFocus.pid === afterFocus.pid && beforeFocus.windowId === afterFocus.windowId;
report.pass = settled.every((result) => result.status === "fulfilled");

console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
