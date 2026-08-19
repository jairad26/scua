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

async function run(command, args) {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
	if (code !== 0) throw new Error(`${command} failed (${code}): ${stderr}`);
}

const client = new ScuaMcpClient({ root, actorId: `finder-live-${process.pid}` });
const report = {};
try {
	await mkdir(folder);
	await writeFile(path.join(folder, from), "SCUA Finder live rename\n", "utf8");
	await run("open", ["-R", path.join(folder, from)]);
	await delay(1_200);
	await client.initialize();

	const roots = await client.call("find_roots", { app: "Finder" });
	let stateId;
	let target;
	const candidates = roots.details.windows.filter((entry) => entry.windowRef).sort((left, right) => Number(right.title?.includes(path.basename(folder))) - Number(left.title?.includes(path.basename(folder))));
	for (const finder of candidates) {
		try {
			const observed = await client.call("observe_ui", { root: finder.windowRef, mode: "semantic" }, 30_000);
			const candidateStateId = observed.details.capture.stateId;
			const searched = await client.call("search_ui", { stateId: candidateStateId, text: from }, 30_000);
			const candidate = searched.details.matches.find((entry) => entry.label === from) ?? searched.details.matches[0];
			if (!candidate?.ref) continue;
			stateId = candidateStateId;
			target = candidate;
			break;
		} catch {
			// Finder can briefly retain roots for windows that closed during a prior
			// live run. Continue to the exact current folder root.
		}
	}
	assert(target?.ref && stateId, `Finder item '${from}' was not found in roots: ${JSON.stringify(roots.details.windows)}`);

	const startedAt = performance.now();
	const committed = await client.call("act_ui", {
		stateId,
		actions: [
			{ action: "click", ref: target.ref },
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
	report.target = target;
	report.commitExecution = committed.details.execution;
	report.oldExists = oldExists;
	report.newExists = newExists;
	report.pass = !oldExists && newExists;
	assert.equal(report.pass, true, `Finder did not commit the rename: ${JSON.stringify(report)}`);
} finally {
	await client.close();
	await rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
