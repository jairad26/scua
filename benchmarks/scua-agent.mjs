#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeCodexEvents } from "./lib/episode-metrics.mjs";

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function codexBinary() {
	const candidates = [
		process.env.SCUA_BENCH_CODEX,
		"/Applications/Codex.app/Contents/Resources/codex",
		"codex",
	].filter(Boolean);
	return candidates.find((candidate) => candidate === "codex" || existsSync(candidate)) ?? "codex";
}

export function benchmarkPrompt(instruction) {
	return [
		"You are the planning layer in a controlled computer-use benchmark.",
		"Complete the task using only tools from the SCUA MCP server.",
		"Do not use shell, filesystem, browser plugins, AppleScript, direct APIs, or any non-SCUA tool. Benchmark setup and evaluation are handled externally.",
		"Use find_roots/open_root, observe_ui, cached semantic queries, and checked act_ui operations. Verify the requested end state before finishing.",
		"If the task is impossible, stop without substituting another application.",
		`Task: ${instruction}`,
		'Your final line must be SCUA_BENCHMARK_RESULT {"status":"success"|"failure","summary":"brief evidence"}',
	].join("\n");
}

export async function runCodexEpisode({ instruction, model, timeoutMs = 180_000, root = benchmarkRoot, extraEnv = {} }) {
	const binary = codexBinary();
	const mcpCommand = path.join(root, "scripts/run-mcp.sh");
	const args = [
		"exec",
		"--ignore-user-config",
		"--ignore-rules",
		"--ephemeral",
		"--skip-git-repo-check",
		"--sandbox", "read-only",
		"--color", "never",
		"--json",
		"-c", `mcp_servers.scua.command=${JSON.stringify(mcpCommand)}`,
		"-c", 'mcp_servers.scua.default_tools_approval_mode="approve"',
		...(model ? ["--model", model] : []),
		benchmarkPrompt(instruction),
	];
	const startedAt = Date.now();
	const events = [];
	const timings = new Map();
	let stdoutBuffer = "";
	let stderr = "";
	let timedOut = false;
	const child = spawn(binary, args, {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			...extraEnv,
			PI_COMPUTER_USE_EXECUTION_MODE: extraEnv.PI_COMPUTER_USE_EXECUTION_MODE ?? "background",
		},
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		for (;;) {
			const newline = stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = stdoutBuffer.slice(0, newline).trim();
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (!line.startsWith("{")) continue;
			try {
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === "item.started") timings.set(event.item?.id, Date.now());
				if (event.type === "item.completed" && timings.has(event.item?.id)) timings.set(event.item.id, Date.now() - timings.get(event.item.id));
			} catch { /* Codex diagnostics remain in stderr or are ignored. */ }
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, timeoutMs);
	timer.unref();
	const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
	clearTimeout(timer);
	const completedAt = Date.now();
	return {
		backend: "codex-cli",
		model: model ?? "codex-default",
		exitCode,
		timedOut,
		startedAt,
		completedAt,
		durationMs: completedAt - startedAt,
		metrics: summarizeCodexEvents(events, timings),
		stderr: stderr.trim(),
		events,
	};
}

function parseArgs(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--instruction") out.instruction = argv[++index];
		else if (arg === "--model") out.model = argv[++index];
		else if (arg === "--timeout-ms") out.timeoutMs = Number(argv[++index]);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const options = parseArgs(process.argv.slice(2));
	if (!options.instruction) throw new Error("--instruction is required");
	const result = await runCodexEpisode(options);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
