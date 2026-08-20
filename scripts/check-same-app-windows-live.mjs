#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ScuaMcpClient } from "../benchmarks/lib/mcp-client.mjs";

if (process.env.SCUA_SAME_APP_WINDOWS_LIVE !== "1") {
	console.error("Set SCUA_SAME_APP_WINDOWS_LIVE=1 to run the same-app multi-window test.");
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scua-same-app-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const specs = [0, 1].map((index) => ({ folder: `SCUA Window ${index + 1} ${process.pid}`, from: `source-${index + 1}.txt`, to: `finished-${index + 1}.txt` }));

async function run(command, args, timeoutMs = 10_000) {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${command} timed out after ${timeoutMs}ms`)); }, timeoutMs);
		child.once("exit", (value) => { clearTimeout(timer); resolve(value ?? 1); });
	});
	if (code !== 0) throw new Error(`${command} failed (${code}): ${stderr}`);
}

async function openFinderWindow(folder) {
	await run("osascript", [
		"-e", "on run argv",
		"-e", "tell application \"Finder\" to make new Finder window to (POSIX file (item 1 of argv) as alias)",
		"-e", "end run",
		"--", folder,
	]);
}

async function closeFinderWindow(folder) {
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

async function timed(work) { const startedAt = performance.now(); const value = await work(); return { value, durationMs: performance.now() - startedAt }; }
async function rootFor(client, title, windowId) {
	const roots = await client.call("find_roots", { app: "Finder" });
	const found = roots.details.windows.find((candidate) => candidate.windowId === windowId && candidate.windowRef)
		?? roots.details.windows.find((candidate) => candidate.windowTitle === title && candidate.windowRef);
	assert(found?.windowRef, `Finder window ${JSON.stringify(title)} was not found.`);
	return found;
}

async function waitForNewFinderWindow(client, knownWindowIds, title) {
	const deadline = Date.now() + 20_000;
	do {
		const roots = await client.call("find_roots", { app: "Finder" });
		const exact = roots.details.windows.find((candidate) => candidate.windowTitle === title && candidate.windowId && !knownWindowIds.has(candidate.windowId));
		const newest = roots.details.windows
			.filter((candidate) => candidate.windowId && !knownWindowIds.has(candidate.windowId))
			.sort((left, right) => right.windowId - left.windowId)[0];
		const found = exact ?? newest;
		if (found?.windowId) return found.windowId;
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error(`Finder did not expose a new window for ${JSON.stringify(title)}.`);
}
async function observe(client, rootEntry, stateId) {
	return await timed(() => client.call("observe_ui", { root: rootEntry.windowRef, ...(stateId ? { stateId } : {}), mode: "semantic" }, 30_000));
}

const clients = specs.map((_, index) => new ScuaMcpClient({ root, actorId: `same-app-window-${process.pid}-${index}` }));
const report = { reads: {}, writes: {} };
try {
	await Promise.all(clients.map((client) => client.initialize()));
	const initialRoots = await clients[0].call("find_roots", { app: "Finder" });
	const knownWindowIds = new Set(initialRoots.details.windows.map((entry) => entry.windowId).filter(Number.isFinite));
	const openedWindowIds = [];
	for (const spec of specs) {
		const folder = path.join(tempRoot, spec.folder); await mkdir(folder); await writeFile(path.join(folder, spec.from), `window ${spec.folder}\n`, "utf8");
		await openFinderWindow(folder);
		const windowId = await waitForNewFinderWindow(clients[0], knownWindowIds, spec.folder);
		knownWindowIds.add(windowId); openedWindowIds.push(windowId);
	}
	const roots = await Promise.all(clients.map((client, index) => rootFor(client, specs[index].folder, openedWindowIds[index])));

	const sequential = [];
	for (let index = 0; index < clients.length; index += 1) sequential.push(await observe(clients[index], roots[index]));
	const parallelStartedAt = performance.now();
	const parallel = await Promise.all(clients.map((client, index) => observe(client, roots[index], sequential[index].value.details.capture.stateId)));
	const parallelWallMs = performance.now() - parallelStartedAt;
	const serialEstimateMs = parallel.reduce((sum, result) => sum + result.durationMs, 0);
	report.reads = { parallelWallMs, serialEstimateMs, speedup: serialEstimateMs / parallelWallMs, windows: roots.map((entry) => entry.windowTitle) };
	assert(report.reads.speedup > 1.25, `same-app reads did not overlap: ${report.reads.speedup.toFixed(2)}x`);

	const prepared = [];
	for (let index = 0; index < clients.length; index += 1) {
		const stateId = parallel[index].value.details.capture.stateId;
		const searched = await clients[index].call("search_ui", { stateId, text: specs[index].from });
		const target = searched.details.matches.find((match) => match.label === specs[index].from) ?? searched.details.matches[0];
		assert(target?.ref, `missing ${specs[index].from}`);
		prepared.push({ stateId, ref: target.ref });
	}
	const writeStartedAt = performance.now();
	const writes = await Promise.all(clients.map(async (client, index) => await timed(() => client.call("execute_plan", {
		planId: `same-app-window-${index}`,
		maxConcurrency: 1,
		nodes: [{
			id: "rename",
			stateId: prepared[index].stateId,
			guards: [{ ref: prepared[index].ref, text: specs[index].from }],
			actions: [
				{ action: "select", ref: prepared[index].ref },
				{ action: "wait", ms: 80 },
				{ action: "keypress", keys: ["ENTER"] },
				{ action: "wait", ms: 120 },
				{ action: "keypress", keys: ["CMD", "A"] },
				{ action: "typeText", text: specs[index].to },
				{ action: "keypress", keys: ["ENTER"] },
			],
			expect: { text: specs[index].to, timeoutMs: 3_000 },
			conflictPolicy: "refresh",
			retry: { maxAttempts: 3, budgetMs: 10_000 },
		}],
	}, 30_000))));
	const writeWallMs = performance.now() - writeStartedAt;
	const files = await Promise.all(specs.map(async (spec) => {
		let oldExists = true; let newExists = true;
		try { await readFile(path.join(tempRoot, spec.folder, spec.from)); } catch { oldExists = false; }
		try { await readFile(path.join(tempRoot, spec.folder, spec.to)); } catch { newExists = false; }
		return { oldExists, newExists };
	}));
	const statuses = writes.map((entry) => entry.value.details.status);
	report.writes = { wallMs: writeWallMs, serialEstimateMs: writes.reduce((sum, entry) => sum + entry.durationMs, 0), statuses, attempts: writes.map((entry) => entry.value.details.nodes?.[0]?.attempts?.length), files };
	assert(statuses.every((status) => status === "succeeded"), `rename plans failed: ${JSON.stringify(report.writes)}`);
	assert(files.every((entry) => !entry.oldExists && entry.newExists), `filesystem evaluator failed: ${JSON.stringify(files)}`);
	report.pass = true;
} finally {
	await Promise.all(clients.map((client) => client.close()));
	await Promise.all(specs.map((spec) => closeFinderWindow(path.join(tempRoot, spec.folder)).catch(() => undefined)));
	await rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
