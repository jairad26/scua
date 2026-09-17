#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { withScuaMcpClient } from "./lib/scua-mcp-client.mjs";

if (process.env.SCUA_AUTO_PLANNER_LIVE !== "1") {
	console.error("Set SCUA_AUTO_PLANNER_LIVE=1 to run the bounded automatic-planner test.");
	process.exit(2);
}

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = `<!doctype html><meta charset="utf-8"><title>SCUA automatic planner browser task</title>
<button aria-label="Complete task">Complete task</button><p aria-live="polite">Status: idle</p>
<script>document.querySelector('button').onclick=()=>document.querySelector('p').textContent='Status: complete'</script>`;
const server = http.createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
	response.end(fixture);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;

const report = { setup: {}, goal: {}, planning: {}, verification: {}, pass: false };
try {
	try {
		await execFileAsync("/usr/bin/killall", ["Calculator"]);
	} catch {
		// Calculator may not be running before an isolated live test.
	}
	await new Promise((resolve) => setTimeout(resolve, 750));
	await execFileAsync("open", ["-a", "Calculator"]);
	await execFileAsync("osascript", ["-e", "tell application \"System Events\" to tell process \"Calculator\" to set frontmost to true"]);
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	await withScuaMcpClient({
		root,
		actorId: `auto-planner-live-${process.pid}`,
		env: {
			PI_COMPUTER_USE_EXECUTION_MODE: "background",
			SCUA_CHROME_WORKSPACE_NAME: "SCUA automatic planner",
		},
		clientName: "scua-auto-planner-live",
	}, async (client) => {
		const browser = await client.call("open_root", { kind: "browser_page", url: fixtureUrl }, 60_000);
		const calculatorRoots = await client.call("find_roots", { app: "Calculator" });
		const calculator = calculatorRoots.details.windows.find((candidate) => candidate.app === "Calculator" && candidate.pairing?.confidence === "exact")
			?? calculatorRoots.details.windows.find((candidate) => candidate.app === "Calculator" && candidate.kind === "window" && candidate.windowId > 0);
		assert(calculator?.windowRef, "Calculator root was not discovered.");
		const browserRoot = browser.details.root.ref;
		report.setup = { calculator: "isolated process", browser: "Status: idle" };
		const startedAt = performance.now();
		const result = await client.call("execute_goal", {
			goal: "Complete both independent parts: in the browser press Complete task until the page says Status: complete; in Calculator calculate 12 + 30 so the display is 42. Do not use any other application.",
			planning: {
				mode: "automatic",
				roots: [browserRoot, calculator.windowRef],
				excludeApps: ["Slack", "Notion"],
				maxTasks: 2,
				maxWaves: 2,
			},
			maxConcurrency: 2,
		}, 60_000);
		report.goal = {
			status: result.details.status,
			durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
			peakConcurrency: result.details.peakConcurrency,
			taskStatuses: result.details.tasks.map((task) => ({
				id: task.id,
				status: task.status,
				durationMs: task.durationMs,
				transactions: task.steps.length,
				maxActionBatch: Math.max(0, ...task.steps.map((step) => step.microBatch?.executedCount ?? 0)),
				jevLatencyMs: Math.round(task.steps.reduce((sum, step) => sum + step.jevLatencyMs, 0) * 10) / 10,
				initialObservationMs: task.initialObservationMs,
				actLatencyMs: Math.round(task.steps.reduce((sum, step) => sum + (step.actLatencyMs ?? 0), 0) * 10) / 10,
			})),
		};
		report.planning = result.details.planning;
		if (result.details.status !== "succeeded") console.error(JSON.stringify({ text: result.text, details: result.details }, null, 2));
		assert.equal(result.details.status, "succeeded", result.text);
		assert.equal(result.details.tasks.length, 2, "the planner did not select both allowlisted roots");
		assert.equal(result.details.planning.selected.every((task) => task.wave === 0), true, "independent work was unnecessarily serialized");
		assert.equal(result.details.peakConcurrency, 2, "automatic wave-zero workers did not overlap");

		const browserTaskId = result.details.planning.selected.find((task) => task.root === browserRoot).taskId;
		const calculatorTaskId = result.details.planning.selected.find((task) => task.root === calculator.windowRef).taskId;
		const browserTask = result.details.tasks.find((task) => task.id === browserTaskId);
		const calculatorTask = result.details.tasks.find((task) => task.id === calculatorTaskId);
		assert(calculatorTask.steps.some((step) => step.microBatch?.executedCount === 6), "Calculator expression did not use one six-action stable transaction");
		const [browserEvidence, calculatorEvidence] = await Promise.all([
			client.call("search_ui", { stateId: browserTask.finalStateId, text: "Status: complete" }),
			client.call("search_ui", { stateId: calculatorTask.finalStateId, text: "42", role: "statictext" }),
		]);
		assert(browserEvidence.details.matches.length > 0, "browser completion was not semantically verified");
		assert(calculatorEvidence.details.matches.length > 0, "Calculator result 42 was not semantically verified");
		report.verification = { browser: "Status: complete", calculator: "42" };
		report.pass = true;
	});
} finally {
	server.closeAllConnections?.();
	await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify(report, null, 2));
