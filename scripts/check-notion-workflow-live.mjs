#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ScuaMcpClient } from "./lib/scua-mcp-client.mjs";

if (process.env.SCUA_NOTION_WORKFLOW_LIVE !== "1") {
	console.error("Set SCUA_NOTION_WORKFLOW_LIVE=1 to run the Notion create-and-write gate.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = await new ScuaMcpClient({
	root,
	actorId: `notion-workflow-live-${process.pid}`,
	env: {
		PI_COMPUTER_USE_EXECUTION_MODE: "background",
		PI_COMPUTER_USE_HEADLESS: "0",
		PI_COMPUTER_USE_CURSOR_OVERLAY: "1",
	},
}).initialize();

const stateId = (result) => result.details?.capture?.stateId ?? result.details?.stateId;
const title = `SCUA live gate ${new Date().toISOString()}`;
const body = "SCUA verifies semantic computer use without borrowing the physical cursor.";
const report = { title, body, wallMs: 0, menuSelectionRequired: false, pass: false };

try {
	const roots = await client.call("find_roots", { app: "Notion" });
	const target = (roots.details.windows ?? []).find((window) => window.isMain && window.isOnscreen !== false)
		?? (roots.details.windows ?? []).find((window) => window.isOnscreen !== false)
		?? roots.details.windows?.[0];
	assert(target?.windowRef, "Notion exposed no controllable root.");
	const observed = await client.call("observe_ui", { root: target.windowRef, mode: "semantic" });
	const startedAt = performance.now();
	const initial = await client.call("search_ui", {
		stateId: stateId(observed),
		queries: [
			{ id: "new-page-root", text: "New page", role: "webarea" },
			{ id: "new-page", text: "New page", role: "popupbutton", capability: "press" },
			{ id: "page-menu", text: "Page", role: "menuitem", capability: "press" },
		],
	});
	const initialMenu = initial.details.queryResults?.find((query) => query.id === "page-menu")?.matches?.[0];
	const initialNewPage = initial.details.queryResults?.find((query) => query.id === "new-page-root")?.matches?.[0];
	const opened = initialNewPage
		? initial
		: initialMenu
		? await client.call("act_ui", {
			stateId: stateId(initial) ?? stateId(observed),
			actions: [{ action: "press", selector: { text: "Page", role: "menuitem", capability: "press" } }],
			expect: { text: "New page", role: "webarea", timeoutMs: 1_500 },
		}, 10_000)
		: await client.call("act_ui", {
			stateId: stateId(initial) ?? stateId(observed),
			actions: [{ action: "press", selector: { text: "New page", role: "popupbutton", capability: "press", match: "first" } }],
		}, 10_000);
	let currentStateId = stateId(opened);
	assert(currentStateId, "New-page activation returned no successor state.");

	let next = await client.call("search_ui", {
		stateId: currentStateId,
		queries: [
			{ id: "new-page-root", text: "New page", role: "webarea" },
			{ id: "page-menu", text: "Page", role: "menuitem", capability: "press" },
		],
	});
	const pageMenu = next.details.queryResults?.find((query) => query.id === "page-menu")?.matches?.[0];
	const newPageRoot = next.details.queryResults?.find((query) => query.id === "new-page-root")?.matches?.[0];
	if (!newPageRoot) {
		report.menuSelectionRequired = true;
		const selected = await client.call("act_ui", {
			stateId: stateId(next) ?? currentStateId,
			actions: [{ action: "press", selector: { text: pageMenu?.label ?? "Page", role: "menuitem", capability: "press" } }],
			expect: { text: "New page", role: "webarea", timeoutMs: 1_500 },
		}, 10_000);
		currentStateId = stateId(selected);
	} else {
		currentStateId = stateId(next) ?? currentStateId;
	}

	const written = await client.call("execute_plan", {
		planId: `notion-live-${process.pid}`,
		maxConcurrency: 1,
		nodes: [
			{
				id: "title",
				stateId: currentStateId,
				actions: [{ action: "setText", selector: { text: "page title", role: "textbox", capability: "setValue" }, text: title }],
			},
			{
				id: "materialize-body",
				dependsOn: ["title"],
				stateFrom: "title",
				actions: [{ action: "keypress", selector: { text: "page title", role: "textbox", capability: "setValue" }, keys: ["ENTER"] }],
				expect: { text: "text entry area", role: "textbox", timeoutMs: 1_500 },
				skipIfExpected: false,
			},
			{
				id: "body",
				dependsOn: ["materialize-body"],
				stateFrom: "materialize-body",
				actions: [{ action: "setText", selector: { text: "text entry area", role: "textbox", capability: "setValue" }, text: body }],
			},
		],
	}, 20_000);
	report.wallMs = performance.now() - startedAt;
	assert.equal(written.details.status, "succeeded", `Notion action plan failed: ${JSON.stringify(written.details)}`);
	assert(report.wallMs <= 10_000, `Notion workflow exceeded 10 seconds (${report.wallMs.toFixed(0)}ms).`);
	const finalStateId = written.details.nodes?.find((node) => node.id === "body")?.successorStateId;
	assert(finalStateId, "Notion workflow returned no final successor state.");
	const verified = await client.call("search_ui", {
		stateId: finalStateId,
		queries: [
			{ id: "title", text: title, role: "textbox", capability: "setValue" },
			{ id: "body", text: body, role: "textbox", capability: "setValue" },
		],
	});
	for (const id of ["title", "body"]) {
		assert(verified.details.queryResults?.find((query) => query.id === id)?.matches?.length, `Final ${id} value was not searchable.`);
	}
	report.pass = true;
} finally {
	await client.close();
}

console.log(JSON.stringify(report, null, 2));
