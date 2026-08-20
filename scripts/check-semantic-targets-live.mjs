#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScuaMcpClient } from "../benchmarks/lib/mcp-client.mjs";

if (process.env.SCUA_SEMANTIC_TARGETS_LIVE !== "1") {
	console.error("Set SCUA_SEMANTIC_TARGETS_LIVE=1 to run the Notion, Slack, and Calendar semantic-target regression.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new ScuaMcpClient({ root, actorId: `semantic-targets-live-${process.pid}` });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const open = (app) => new Promise((resolve, reject) => execFile("/usr/bin/open", ["-g", "-a", app], (error) => error ? reject(error) : resolve()));
const stateId = (result) => result.details?.capture?.stateId ?? result.details?.stateId;

async function observeApp(app) {
	let roots;
	let window;
	for (let attempt = 0; attempt < 20 && !window; attempt += 1) {
		roots = await client.call("find_roots", { app });
		const candidates = roots.details.windows.filter((candidate) => candidate.windowRef);
		window = candidates.find((candidate) => candidate.isMain && candidate.isOnscreen !== false)
			?? candidates.find((candidate) => candidate.isFocused && candidate.isOnscreen !== false)
			?? candidates.filter((candidate) => candidate.isOnscreen !== false).sort((left, right) => (right.framePoints?.w ?? 0) * (right.framePoints?.h ?? 0) - (left.framePoints?.w ?? 0) * (left.framePoints?.h ?? 0))[0]
			?? candidates[0];
		if (!window) await delay(250);
	}
	assert(window?.windowRef, `${app} exposed no controllable root.`);
	const observed = await client.call("observe_ui", { root: window.windowRef, mode: "semantic", readText: "never" }, 45_000);
	return { window, stateId: stateId(observed) };
}

async function notionFields() {
	const current = await observeApp("Notion");
	const searched = await client.call("search_ui", {
		stateId: current.stateId,
		queries: [
			{ id: "title", text: current.window.windowTitle, role: "textbox", capability: "setValue" },
			{ id: "all", role: "textbox", capability: "setValue" },
		],
	});
	const title = searched.details.queryResults.find((result) => result.id === "title")?.matches?.[0];
	const fields = searched.details.queryResults.find((result) => result.id === "all")?.matches ?? [];
	const body = fields.filter((match) => match.ref !== title?.ref).sort((left, right) => right.label.length - left.label.length)[0];
	assert(title?.ref && body?.ref, `Notion did not expose distinct title/body semantics: ${searched.text}`);
	assert.notEqual(title.ref, body.ref, "Notion title and body resolved to the same field.");
	return { title: { ref: title.ref, label: title.label }, body: { ref: body.ref, labelPreview: body.label.slice(0, 80), valueLength: body.label.length } };
}

async function slackSelfDm() {
	let current = await observeApp("Slack");
	let searched = await client.call("search_ui", { stateId: current.stateId, text: "Search", role: "textbox", capability: "setValue" });
	let field = searched.details.matches?.find((match) => /search/i.test(match.label));
	if (!field?.ref) {
		const triggerSearch = await client.call("search_ui", { stateId: stateId(searched) ?? current.stateId, text: "Search", capability: "press" });
		const trigger = triggerSearch.details.matches?.find((match) => /search/i.test(match.label));
		assert(trigger?.ref, `Slack search trigger was not found: ${triggerSearch.text}`);
		const opened = await client.call("act_ui", { stateId: stateId(triggerSearch) ?? current.stateId, actions: [{ action: "press", ref: trigger.ref }] }, 45_000);
		const refreshed = await observeApp("Slack");
		searched = await client.call("search_ui", { stateId: refreshed.stateId, role: "textbox", capability: "setValue" });
		field = searched.details.matches?.find((match) => /searchfield/i.test(match.subrole) || /search|channel or user/i.test(match.label));
	}
	assert(field?.ref, `Slack search field was not found: ${searched.text}`);
	let acted = await client.call("act_ui", {
		stateId: stateId(searched) ?? current.stateId,
		actions: [{ action: "setText", ref: field.ref, text: "Jai Radhakrishnan" }],
		expect: { ref: field.ref, value: "Jai Radhakrishnan", timeoutMs: 5_000 },
	}, 45_000);
	await delay(350);
	const resultsState = await observeApp("Slack");
	searched = await client.call("search_ui", { stateId: resultsState.stateId, text: "Jai Radhakrishnan", role: "row", capability: "press" }, 45_000);
	let row = searched.details.matches?.[0];
	if (!row?.ref) {
		const refreshed = await client.call("observe_ui", { root: current.window.windowRef, stateId: stateId(acted), mode: "semantic" }, 45_000);
		searched = await client.call("search_ui", { stateId: stateId(refreshed), text: "Jai Radhakrishnan", capability: "press" }, 45_000);
		row = searched.details.matches?.[0];
	}
	assert(row?.ref, `Slack self-result row was not found: ${searched.text}`);
	acted = await client.call("act_ui", {
		stateId: stateId(searched) ?? stateId(acted),
		actions: [{ action: "press", ref: row.ref }],
		expect: { text: "Message Jai Radhakrishnan", timeoutMs: 5_000 },
	}, 45_000);
	const destinationState = await observeApp("Slack");
	const destination = await client.call("search_ui", { stateId: destinationState.stateId, text: "Message Jai Radhakrishnan", role: "textbox", capability: "setValue" }, 45_000);
	assert(destination.details.matches?.[0]?.ref, `Slack did not open the self-DM composer: ${destination.text}`);
	return { selected: row.label, composer: destination.details.matches[0].label };
}

async function calendarUrlDisclosure() {
	const token = `SCUA disclosure ${Date.now()}`;
	let current = await observeApp("Calendar");
	let searched = await client.call("search_ui", { stateId: current.stateId, text: "Add Event", role: "button", capability: "press" });
	let add = searched.details.matches?.[0];
	if (!add?.ref) {
		const quickOpen = await client.call("search_ui", { stateId: stateId(searched) ?? current.stateId, text: "New Quick Event", role: "textbox" });
		const quickField = quickOpen.details.matches?.[0];
		if (quickField?.ref) {
			await client.call("act_ui", { stateId: stateId(quickOpen) ?? current.stateId, actions: [{ action: "keypress", ref: quickField.ref, keys: ["ESCAPE"] }] }, 45_000);
			current = await observeApp("Calendar");
			searched = await client.call("search_ui", { stateId: current.stateId, text: "Add Event", role: "button", capability: "press" });
			add = searched.details.matches?.[0];
		}
	}
	assert(add?.ref, "Calendar Add Event button was not found.");
	let acted = await client.call("act_ui", { stateId: stateId(searched) ?? current.stateId, actions: [{ action: "press", ref: add.ref }] }, 45_000);
	searched = await client.call("search_ui", { stateId: stateId(acted), text: "New Quick Event", role: "textbox", capability: "setValue" });
	const quick = searched.details.matches?.[0];
	assert(quick?.ref, "Calendar quick-event field was not found.");
	acted = await client.call("act_ui", {
		stateId: stateId(searched) ?? stateId(acted),
		actions: [{ action: "setText", ref: quick.ref, text: token }],
		expect: { ref: quick.ref, value: token, timeoutMs: 5_000 },
	}, 45_000);
	searched = await client.call("search_ui", { stateId: stateId(acted), text: "New Quick Event", role: "textbox" });
	const commitField = searched.details.matches?.[0];
	assert(commitField?.ref, "Calendar quick-event field disappeared before commit.");
	acted = await client.call("act_ui", { stateId: stateId(searched) ?? stateId(acted), actions: [{ action: "keypress", ref: commitField.ref, keys: ["ENTER"] }] }, 45_000);
	await delay(600);
	current = await observeApp("Calendar");
	searched = await client.call("search_ui", { stateId: current.stateId, text: token }, 45_000);
	const event = searched.details.matches?.find((match) => !match.path.includes("AXTextField")) ?? searched.details.matches?.[0];
	assert(event?.ref, `Calendar event was not found after creation: ${searched.text}`);
	acted = await client.call("act_ui", {
		stateId: stateId(searched) ?? stateId(acted),
		actions: [{ action: "press", ref: event.ref }],
		expect: { text: "Add Notes, URL, or Attachments", timeoutMs: 5_000 },
	}, 45_000);
	const refreshed = await client.call("observe_ui", { root: current.window.windowRef, stateId: stateId(acted), mode: "semantic", readText: "never" }, 45_000);
	searched = await client.call("search_ui", { stateId: stateId(refreshed), text: "URL", role: "textbox", capability: "setValue" }, 45_000);
	const disclosure = searched.details.revealCandidates?.find((match) => /url/i.test(match.label)) ?? searched.details.revealCandidates?.[0];
	assert(disclosure?.ref, `Calendar URL disclosure was not surfaced: ${searched.text}`);
	acted = await client.call("act_ui", { stateId: stateId(searched) ?? stateId(acted), actions: [{ action: "press", ref: disclosure.ref }] }, 45_000);
	searched = await client.call("search_ui", { stateId: stateId(acted), text: "URL", role: "textbox", capability: "setValue" }, 45_000);
	const url = searched.details.matches?.[0];
	assert(url?.ref, `Calendar URL field was not revealed: ${searched.text}`);
	const value = "https://example.com/scua-regression";
	acted = await client.call("act_ui", { stateId: stateId(searched) ?? stateId(acted), actions: [{ action: "setText", ref: url.ref, text: value }], expect: { ref: url.ref, value, timeoutMs: 5_000 } }, 45_000);
	return { token, disclosure: disclosure.label, urlField: url.label, verification: acted.details.execution?.verification?.status };
}

const report = {};
try {
	await Promise.all([open("Notion"), open("Slack"), open("Calendar")]);
	await delay(800);
	await client.initialize();
	report.notion = process.env.SCUA_SKIP_NOTION === "1" ? { skipped: true } : await notionFields();
	report.slack = process.env.SCUA_SKIP_SLACK === "1" ? { skipped: true } : await slackSelfDm();
	report.calendar = process.env.SCUA_SKIP_CALENDAR === "1" ? { skipped: true } : await calendarUrlDisclosure();
	report.pass = true;
} finally {
	await client.close();
	if (report.calendar?.token) {
		await new Promise((resolve) => execFile("/usr/bin/osascript", [
			"-e", "on run argv",
			"-e", "set requestedSummary to item 1 of argv",
			"-e", "tell application \"Calendar\"",
			"-e", "repeat with c in calendars",
			"-e", "delete (every event of c whose summary is requestedSummary)",
			"-e", "end repeat",
			"-e", "end tell",
			"-e", "end run",
			"--", report.calendar.token,
		], () => resolve()));
	}
}

console.log(JSON.stringify(report, null, 2));
