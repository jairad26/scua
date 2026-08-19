#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateEpisodes } from "./lib/episode-metrics.mjs";
import { ScuaMcpClient } from "./lib/mcp-client.mjs";
import { runCodexEpisode } from "./scua-agent.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tasksPath = path.join(root, "benchmarks/pilot/tasks.json");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
	const options = { taskIds: [], domains: [], timeoutMs: 180_000 };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--task") options.taskIds.push(argv[++index]);
		else if (arg === "--domain") options.domains.push(argv[++index]);
		else if (arg === "--limit") options.limit = Number(argv[++index]);
		else if (arg === "--model") options.model = argv[++index];
		else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
		else if (arg === "--allow-desktop-mutation") options.allowDesktopMutation = true;
		else if (arg === "--dry-run") options.dryRun = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

async function run(command, args, { timeoutMs = 20_000 } = {}) {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
	timer.unref();
	const code = await new Promise((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
	clearTimeout(timer);
	if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trim();
}

function formHtml(taskId) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>SCUA Pilot ${taskId}</title></head><body>
	<main><h1>SCUA benchmark form</h1><label for="benchmark-value">Benchmark value</label>
	<input id="benchmark-value" aria-label="Benchmark value"><button id="save">Save</button>
	<p id="status" role="status">Not saved</p></main><script>
	document.querySelector('#save').addEventListener('click', async () => {
		const value = document.querySelector('#benchmark-value').value;
		await fetch('/record/${taskId}', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value})});
		document.querySelector('#status').textContent = 'Saved: ' + value;
	});</script></body></html>`;
}

async function fixtureServer(records) {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "GET" && url.pathname.startsWith("/task/")) {
			const taskId = decodeURIComponent(url.pathname.slice("/task/".length));
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(formHtml(taskId));
			return;
		}
		if (request.method === "POST" && url.pathname.startsWith("/record/")) {
			const taskId = decodeURIComponent(url.pathname.slice("/record/".length));
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => { body += chunk; });
			request.on("end", () => {
				try { records.set(taskId, JSON.parse(body)); } catch { records.set(taskId, { invalid: body }); }
				response.writeHead(204);
				response.end();
			});
			return;
		}
		response.writeHead(404);
		response.end("not found");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function compileMonitor(tempRoot) {
	if (process.platform !== "darwin") return undefined;
	const output = path.join(tempRoot, "scua-activity-monitor");
	await run("xcrun", ["swiftc", path.join(root, "benchmarks/native/activity_monitor.swift"), "-o", output], { timeoutMs: 60_000 });
	return output;
}

function startMonitor(binary) {
	if (!binary) return undefined;
	const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	return {
		async stop() {
			child.kill("SIGTERM");
			await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
			try { return JSON.parse(stdout.trim()); } catch { return { error: "activity_monitor_output_invalid", raw: stdout.trim() }; }
		},
	};
}

async function setupTask(task, tempRoot, baseUrl) {
	const taskRoot = path.join(tempRoot, task.id);
	await mkdir(taskRoot, { recursive: true });
	if (task.setup.kind === "calculator") {
		await run("open", ["-a", "Calculator"]);
		await delay(500);
		return { instruction: task.instruction, taskRoot };
	}
	if (task.setup.kind === "textedit") {
		const filePath = path.join(taskRoot, `${task.id}.txt`);
		await writeFile(filePath, task.setup.initial, "utf8");
		await run("open", ["-a", "TextEdit", filePath]);
		await delay(800);
		return { instruction: task.instruction.replaceAll("{{title}}", path.basename(filePath)), taskRoot, filePath, expected: task.setup.target };
	}
	if (task.setup.kind === "finderRename") {
		const folder = path.join(taskRoot, `${task.id}-folder`);
		await mkdir(folder, { recursive: true });
		await writeFile(path.join(folder, task.setup.from), `SCUA pilot ${task.id}\n`, "utf8");
		await run("open", [folder]);
		await delay(800);
		return { instruction: task.instruction.replaceAll("{{title}}", path.basename(folder)), taskRoot, folder, from: task.setup.from, to: task.setup.to };
	}
	if (task.setup.kind === "browserForm") {
		const url = `${baseUrl}/task/${encodeURIComponent(task.id)}`;
		return { instruction: task.instruction.replaceAll("{{url}}", url), taskRoot, expected: task.setup.target };
	}
	throw new Error(`Unknown setup kind: ${task.setup.kind}`);
}

function normalizeVisibleText(value) {
	return String(value ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "").replaceAll(",", "").trim();
}

async function evaluateTask(task, context, records, evaluator) {
	if (task.evaluate.kind === "fileContent") {
		const actual = (await readFile(context.filePath, "utf8")).replace(/\r\n/g, "\n").replace(/\n$/, "");
		return { passed: actual === context.expected, expected: context.expected, actual };
	}
	if (task.evaluate.kind === "renamedFile") {
		let fromExists = true;
		let toExists = true;
		try { await readFile(path.join(context.folder, context.from)); } catch { fromExists = false; }
		try { await readFile(path.join(context.folder, context.to)); } catch { toExists = false; }
		return { passed: !fromExists && toExists, fromExists, toExists, expected: context.to };
	}
	if (task.evaluate.kind === "browserRecord") {
		const record = records.get(task.id);
		return { passed: record?.value === context.expected, expected: context.expected, actual: record?.value };
	}
	if (task.evaluate.kind === "calculator") {
		const roots = await evaluator.call("find_roots", { app: "Calculator" });
		const calculator = roots.details?.windows?.find((item) => item.app === "Calculator" && item.windowRef);
		if (!calculator) return { passed: false, error: "calculator_root_missing" };
		const observed = await evaluator.call("observe_ui", { root: calculator.windowRef, mode: "semantic" });
		const search = await evaluator.call("search_ui", { stateId: observed.details.capture.stateId, text: String(task.evaluate.expected) });
		const normalizedExpected = normalizeVisibleText(task.evaluate.expected);
		const candidates = (search.details?.matches ?? []).filter((candidate) => !/button/i.test(String(candidate.role ?? "")));
		const match = candidates.find((candidate) => normalizeVisibleText(candidate.label) === normalizedExpected);
		return { passed: Boolean(match), expected: task.evaluate.expected, match, candidates: candidates.slice(0, 24) };
	}
	throw new Error(`Unknown evaluator kind: ${task.evaluate.kind}`);
}

const options = parseArgs(process.argv.slice(2));
const allTasks = JSON.parse(await readFile(tasksPath, "utf8"));
let selected = allTasks.filter((task) => !options.taskIds.length || options.taskIds.includes(task.id));
selected = selected.filter((task) => !options.domains.length || options.domains.includes(task.domain));
if (Number.isFinite(options.limit)) selected = selected.slice(0, Math.max(0, options.limit));
if (!selected.length) throw new Error("No pilot tasks selected.");
const mutating = selected.filter((task) => ["textedit", "finder"].includes(task.domain));
if (mutating.length && !options.allowDesktopMutation && !options.dryRun) {
	throw new Error(`The selected suite opens and edits temporary Finder/TextEdit artifacts (${mutating.length} tasks). Re-run with --allow-desktop-mutation.`);
}
if (options.dryRun) {
	process.stdout.write(`${JSON.stringify({ tasks: selected.map(({ id, domain, instruction }) => ({ id, domain, instruction })) }, null, 2)}\n`);
	process.exit(0);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scua-pilot-"));
const records = new Map();
const fixture = await fixtureServer(records);
const evaluator = new ScuaMcpClient({ root });
const episodes = [];
try {
	await evaluator.initialize();
	const monitorBinary = await compileMonitor(tempRoot);
	for (const [index, task] of selected.entries()) {
		process.stderr.write(`[${index + 1}/${selected.length}] ${task.id}: setup\n`);
		const context = await setupTask(task, tempRoot, fixture.baseUrl);
		const monitor = startMonitor(monitorBinary);
		const startedAt = Date.now();
		process.stderr.write(`[${index + 1}/${selected.length}] ${task.id}: agent\n`);
		let agent;
		try {
			agent = await runCodexEpisode({ instruction: context.instruction, model: options.model, timeoutMs: options.timeoutMs, root });
		} catch (error) {
			agent = { backend: "codex-cli", exitCode: 1, error: error instanceof Error ? error.message : String(error), metrics: { integrityPassed: false, scuaToolCalls: 0, usage: {} } };
		}
		const activity = await monitor?.stop();
		process.stderr.write(`[${index + 1}/${selected.length}] ${task.id}: evaluate\n`);
		let evaluation;
		try { evaluation = await evaluateTask(task, context, records, evaluator); }
		catch (error) { evaluation = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
		const completedAt = Date.now();
		const episode = { protocolVersion: 1, taskId: task.id, domain: task.domain, instruction: context.instruction, startedAt, completedAt, durationMs: completedAt - startedAt, agent, activity, evaluation };
		episodes.push(episode);
		process.stderr.write(`[${index + 1}/${selected.length}] ${task.id}: ${evaluation.passed ? "PASS" : "FAIL"} in ${episode.durationMs}ms\n`);
	}
} finally {
	await evaluator.close();
	await new Promise((resolve) => fixture.server.close(resolve));
	await rm(tempRoot, { recursive: true, force: true });
}

const report = {
	protocolVersion: 1,
	suite: "scua-macos-pilot-v1",
	generatedAt: new Date().toISOString(),
	platform: { os: process.platform, arch: process.arch, release: os.release() },
	agent: { backend: "codex-cli", model: options.model ?? "codex-default" },
	summary: aggregateEpisodes(episodes),
	episodes,
};
const resultsDir = path.join(root, "benchmarks/results");
await mkdir(resultsDir, { recursive: true });
const outputPath = path.join(resultsDir, `pilot-${new Date().toISOString().replaceAll(":", "-")}.local.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, summary: report.summary }, null, 2)}\n`);
