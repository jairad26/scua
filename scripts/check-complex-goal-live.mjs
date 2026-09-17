#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { withScuaMcpClient } from "./lib/scua-mcp-client.mjs";

if (process.env.SCUA_COMPLEX_GOAL_LIVE !== "1") {
	console.error("Set SCUA_COMPLEX_GOAL_LIVE=1 to run the complex goal test.");
	process.exit(2);
}

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operandA = randomInt(11, 20);
const operandB = randomInt(2, 10);
const expectedResult = String(operandA * operandB);

function fixturePage(route) {
	const shared = `<style>
		body{font:18px system-ui;max-width:720px;margin:40px auto;padding:24px}
		main{border:1px solid #888;border-radius:16px;padding:28px;display:grid;gap:18px}
		button,input{font:inherit;padding:12px 16px} output{font-weight:700}
	</style>`;
	if (route === "/source-a") return `<!doctype html><title>Mission source A</title>${shared}<main><h1>Source A</h1><button aria-label="Reveal input A">Reveal input A</button><output aria-live="polite">Input A: hidden</output><script>document.querySelector('button').onclick=e=>{e.currentTarget.remove();document.querySelector('output').textContent='Input A: ${operandA}'}</script></main>`;
	if (route === "/source-b") return `<!doctype html><title>Mission source B</title>${shared}<main><h1>Source B</h1><button aria-label="Reveal input B">Reveal input B</button><output aria-live="polite">Input B: hidden</output><script>document.querySelector('button').onclick=e=>{e.currentTarget.remove();document.querySelector('output').textContent='Input B: ${operandB}'}</script></main>`;
	if (route === "/review") return `<!doctype html><title>Mission review lane</title>${shared}<main><h1>Review lane</h1><button aria-label="Run preflight">Run preflight</button><output aria-live="polite">Preflight: pending</output><script>const b=document.querySelector('button'),o=document.querySelector('output');b.onclick=()=>{if(o.textContent==='Preflight: pending'){o.textContent='Preflight: passed';b.textContent='Approve handoff';b.setAttribute('aria-label','Approve handoff');b.onclick=()=>{b.remove();o.textContent='Handoff: approved'}}}</script></main>`;
	return `<!doctype html><title>Mission workspace</title>${shared}<main><h1>Mission workspace</h1><button id="prepare" aria-label="Prepare workspace">Prepare workspace</button><output id="workspace" aria-live="polite">Workspace: pending</output><label>Calculation result <input id="result" aria-label="Calculation result"></label><output id="echo" aria-live="polite">Result: empty</output><button id="validate" aria-label="Validate mission" disabled>Validate mission</button><output id="mission" aria-live="polite">Mission: pending</output><script>const p=document.querySelector('#prepare'),w=document.querySelector('#workspace'),i=document.querySelector('#result'),e=document.querySelector('#echo'),v=document.querySelector('#validate'),m=document.querySelector('#mission');p.onclick=()=>{p.remove();w.textContent='Workspace: ready'};i.oninput=()=>{e.textContent='Result: '+(i.value||'empty');v.disabled=i.value!=='${expectedResult}'};v.onclick=()=>{if(w.textContent==='Workspace: ready'&&i.value==='${expectedResult}'){v.remove();m.textContent='Mission: complete'}else m.textContent='Mission: rejected'}</script></main>`;
}

const server = http.createServer((request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(fixturePage(new URL(request.url, "http://localhost").pathname));
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const report = { graph: {}, execution: {}, verification: {}, pass: false };
try {
	try {
		await execFileAsync("/usr/bin/killall", ["Calculator"]);
	} catch {
		// Calculator may not be running before an isolated live test.
	}
	await new Promise((resolve) => setTimeout(resolve, 500));
	await execFileAsync("open", ["-a", "Calculator"]);
	await execFileAsync("osascript", ["-e", "tell application \"System Events\" to tell process \"Calculator\" to set frontmost to true"]);
	await new Promise((resolve) => setTimeout(resolve, 800));

	await withScuaMcpClient({
		root,
		actorId: `complex-goal-live-${process.pid}`,
		env: {
			PI_COMPUTER_USE_CURSOR_OVERLAY: "true",
			PI_COMPUTER_USE_EXECUTION_MODE: "background",
			SCUA_CHROME_WORKSPACE_NAME: "SCUA complex mission",
		},
		clientName: "scua-complex-goal-live",
	}, async (client) => {
		const opened = await Promise.all([
			client.call("open_root", { kind: "browser_page", url: `${baseUrl}/source-a` }, 45_000),
			client.call("open_root", { kind: "browser_page", url: `${baseUrl}/source-b` }, 45_000),
			client.call("open_root", { kind: "browser_page", url: `${baseUrl}/review` }, 45_000),
			client.call("open_root", { kind: "browser_page", url: `${baseUrl}/workspace` }, 45_000),
		]);
		const [sourceA, sourceB, review, workspace] = opened.map((entry) => entry.details.root.ref);
		const calculatorRoots = await client.call("find_roots", { app: "Calculator" });
		const calculator = calculatorRoots.details.windows.find((candidate) => candidate.app === "Calculator" && candidate.pairing?.confidence === "exact")
			?? calculatorRoots.details.windows.find((candidate) => candidate.app === "Calculator" && candidate.kind === "window" && candidate.windowId > 0);
		assert(calculator?.windowRef, "Calculator root was not discovered.");

		const tasks = [
			{ id: "source-a", root: sourceA, objective: `Press Reveal input A and stop when Input A is ${operandA}.`, completion: { text: `Input A: ${operandA}` }, maxSteps: 3 },
			{ id: "source-b", root: sourceB, objective: `Press Reveal input B and stop when Input B is ${operandB}.`, completion: { text: `Input B: ${operandB}` }, maxSteps: 3 },
			{ id: "prepare", root: workspace, objective: "Press Prepare workspace and stop when Workspace is ready. Do not type a result or validate yet.", completion: { text: "Workspace: ready" }, maxSteps: 3 },
			{ id: "preflight", root: review, objective: "Press Run preflight and stop when Preflight has passed. Do not approve the handoff yet.", completion: { text: "Preflight: passed" }, maxSteps: 3 },
			{ id: "compute", root: calculator.windowRef, dependsOn: ["source-a", "source-b"], objective: `Clear Calculator, calculate ${operandA} * ${operandB}, and stop when its display is ${expectedResult}.`, completion: { text: expectedResult }, maxSteps: 3, maxBatchActions: 6 },
			{ id: "approve", stateFrom: "preflight", dependsOn: ["preflight"], objective: "Press Approve handoff and stop when Handoff is approved.", completion: { text: "Handoff: approved" }, maxSteps: 3 },
			{ id: "enter-result", stateFrom: "prepare", dependsOn: ["prepare", "compute", "approve"], objective: `Set Calculation result to the exact named result payload and stop when Result is ${expectedResult}. Do not validate yet.`, completion: { text: `Result: ${expectedResult}` }, textValues: { result: expectedResult }, maxSteps: 3 },
			{ id: "finalize", stateFrom: "enter-result", dependsOn: ["enter-result"], objective: "Press Validate mission and stop when Mission is complete.", completion: { text: "Mission: complete" }, maxSteps: 3 },
		];
		report.graph = { tasks: tasks.map(({ id, dependsOn = [], stateFrom }) => ({ id, dependsOn, stateFrom })), expectedPeakConcurrency: 4 };
		const startedAt = performance.now();
		const result = await client.call("execute_goal", {
			goal: `Combine two revealed inputs into one verified result: reveal ${operandA} and ${operandB} in parallel, prepare and preflight the workspace, calculate ${operandA} * ${operandB} = ${expectedResult}, approve the browser handoff, enter ${expectedResult}, then validate the mission.`,
			tasks,
			maxConcurrency: 4,
			minConfidence: 0.4,
		}, 90_000);
		report.execution = {
			status: result.details.status,
			durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
			peakConcurrency: result.details.peakConcurrency,
			tasks: result.details.tasks.map((task) => ({
				id: task.id,
				status: task.status,
				durationMs: task.durationMs,
				startedAt: task.startedAt,
				completedAt: task.completedAt,
				transactions: task.steps.length,
				models: [...new Set(task.steps.map((step) => step.model))],
				maxActionBatch: Math.max(0, ...task.steps.map((step) => step.microBatch?.executedCount ?? 0)),
				jevLatencyMs: Math.round(task.steps.reduce((sum, step) => sum + step.jevLatencyMs, 0) * 10) / 10,
				actLatencyMs: Math.round(task.steps.reduce((sum, step) => sum + (step.actLatencyMs ?? 0), 0) * 10) / 10,
				outcomes: task.steps.map((step) => ({ outcome: step.outcome, verification: step.verification, action: step.action?.action })),
				cursorOverlays: task.steps.reduce((totals, step) => ({
					requested: totals.requested + (step.cursorOverlays?.requested ?? 0),
					presented: totals.presented + (step.cursorOverlays?.presented ?? 0),
				}), { requested: 0, presented: 0 }),
			})),
		};
		if (result.details.status !== "succeeded") console.error(JSON.stringify({ text: result.text, details: result.details }, null, 2));
		assert.equal(result.details.status, "succeeded", result.text);
		assert.equal(result.details.peakConcurrency, 4, "four independent first-wave workers did not overlap");
		assert(result.details.tasks.find((task) => task.id === "compute")?.steps.some((step) => step.microBatch?.executedCount === 6), "Calculator did not compile the six-action sequence");
		assert(result.details.tasks.filter((task) => ["source-a", "source-b", "prepare", "preflight"].includes(task.id)).every((task) => task.steps.some((step) => (step.cursorOverlays?.presented ?? 0) > 0)), "one or more concurrent first-wave cursors were not visually acknowledged");

		const taskById = new Map(result.details.tasks.map((task) => [task.id, task]));
		assert(taskById.get("compute").startedAt >= Math.max(taskById.get("source-a").completedAt, taskById.get("source-b").completedAt), "compute crossed its dependency barrier");
		assert(taskById.get("approve").startedAt >= taskById.get("preflight").completedAt, "approval crossed its state handoff barrier");
		assert(taskById.get("enter-result").startedAt >= Math.max(taskById.get("prepare").completedAt, taskById.get("compute").completedAt, taskById.get("approve").completedAt), "result entry crossed its dependency barrier");
		assert(taskById.get("finalize").startedAt >= taskById.get("enter-result").completedAt, "finalization crossed its state handoff barrier");

		const finalStateId = taskById.get("finalize").finalStateId;
		const [mission, resultValue, calculatorValue] = await Promise.all([
			client.call("search_ui", { stateId: finalStateId, text: "Mission: complete" }),
			client.call("search_ui", { stateId: finalStateId, text: `Result: ${expectedResult}` }),
			client.call("search_ui", { stateId: taskById.get("compute").finalStateId, text: expectedResult }),
		]);
		assert(mission.details.matches.length > 0, "final mission state was not verified");
		assert(resultValue.details.matches.length > 0, "final result handoff was not verified");
		assert(calculatorValue.details.matches.length > 0, "Calculator result was not verified");
		report.verification = { mission: "complete", workspaceResult: expectedResult, calculator: expectedResult, dependencyBarriers: "verified" };
		report.pass = true;
	});
} finally {
	server.closeAllConnections?.();
	await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify(report, null, 2));
