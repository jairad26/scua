#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScuaMcpClient } from "../benchmarks/lib/mcp-client.mjs";

if (process.env.SCUA_FINDER_RENAME_LIVE !== "1") {
	console.error("Set SCUA_FINDER_RENAME_LIVE=1 to run the Finder rename live test.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scua-finder-live-"));
const folder = path.join(tempRoot, "SCUA Finder Rename Live");
const from = "alpha-source.txt";
const to = "alpha-finished.txt";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(command, args, timeoutMs = 10_000) {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${command} timed out after ${timeoutMs}ms`)); }, timeoutMs);
		child.once("exit", (value) => { clearTimeout(timer); resolve(value ?? 1); });
	});
	if (code !== 0) throw new Error(`${command} failed (${code}): ${stderr}`);
}

async function openFinderWindow() {
	await run("osascript", [
		"-e", "on run argv",
		"-e", "tell application \"Finder\" to make new Finder window to (POSIX file (item 1 of argv) as alias)",
		"-e", "end run",
		"--", folder,
	]);
}

async function closeFinderWindow() {
	await run("osascript", [
		"-e", "on run argv",
		"-e", "set requestedPath to item 1 of argv",
		"-e", "tell application \"Finder\"",
		"-e", "repeat with candidateWindow in every Finder window",
		"-e", "try",
		"-e", "set candidatePath to POSIX path of (target of candidateWindow as alias)",
		"-e", "if candidatePath is requestedPath or candidatePath is (requestedPath & \"/\") then close candidateWindow",
		"-e", "end try",
		"-e", "end repeat",
		"-e", "end tell",
		"-e", "end run",
		"--", folder,
	], 2_000);
}

async function waitForNewFinderWindow(knownWindowIds) {
	const deadline = Date.now() + 20_000;
	do {
		const roots = await client.call("find_roots", { app: "Finder" });
		const found = roots.details.windows
			.filter((candidate) => candidate.windowId && candidate.windowRef && !knownWindowIds.has(candidate.windowId))
			.sort((left, right) => right.windowId - left.windowId)[0];
		if (found) return { roots, found };
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error("Finder did not expose the newly created rename-test window.");
}

const client = new ScuaMcpClient({ root, actorId: `finder-live-${process.pid}` });
const report = {};
try {
	await mkdir(folder);
	await writeFile(path.join(folder, from), "SCUA Finder live rename\n", "utf8");
	await client.initialize();
	const initialRoots = await client.call("find_roots", { app: "Finder" });
	const knownWindowIds = new Set(initialRoots.details.windows.map((entry) => entry.windowId).filter(Number.isFinite));
	await openFinderWindow();
	const { roots, found: finder } = await waitForNewFinderWindow(knownWindowIds);
	const stableNativeRoots = roots.details.windows.filter((entry) => entry.windowId && entry.nativeWindowRef);
	assert.equal(
		new Set(stableNativeRoots.map((entry) => entry.nativeWindowRef)).size,
		stableNativeRoots.length,
		"Distinct Finder window ids collapsed onto one Accessibility root.",
	);
	const observationStartedAt = performance.now();
	const observed = await client.call("observe_ui", { root: finder.windowRef, mode: "semantic" }, 30_000);
	const observationMs = performance.now() - observationStartedAt;
	const stateId = observed.details.capture.stateId;
	const searched = await client.call("search_ui", { stateId, text: from }, 30_000);
	const target = searched.details.matches.find((entry) => entry.label === from) ?? searched.details.matches[0];
	const observationTimings = observed.details.timings;
	assert(target?.ref && stateId, `Finder item '${from}' was not found in roots: ${JSON.stringify(roots.details.windows)}`);

	const startedAt = performance.now();
	const committed = await client.call("act_ui", {
		stateId,
		actions: [
			{ action: "select", ref: target.ref },
			{ action: "wait", ms: 80 },
			// Finder's ordinary selected filename field is not yet an editor.
			// Return enters the transient inline editor, whose AX node disappears;
			// the remaining unscoped actions intentionally operate on that focus.
			{ action: "keypress", keys: ["ENTER"] },
			{ action: "wait", ms: 120 },
			{ action: "keypress", keys: ["CMD", "A"] },
			{ action: "typeText", text: to },
			{ action: "keypress", keys: ["ENTER"] },
		],
		expect: { text: to, timeoutMs: 3_000 },
	}, 30_000);
	await delay(300);
	let oldExists = true;
	let newExists = true;
	try { await readFile(path.join(folder, from)); } catch { oldExists = false; }
	try { await readFile(path.join(folder, to)); } catch { newExists = false; }
	report.executionMs = Math.round(performance.now() - startedAt);
	report.observationMs = Math.round(observationMs);
	report.observationTimings = observationTimings;
	report.target = target;
	report.commitExecution = committed.details.execution;
	report.oldExists = oldExists;
	report.newExists = newExists;
	report.pass = !oldExists && newExists;
	assert.equal(report.pass, true, `Finder did not commit the rename: ${JSON.stringify(report)}`);
} finally {
	await client.close();
	await closeFinderWindow().catch(() => undefined);
	await rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
