#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateEpisodes, summarizeCodexEvents } from "../benchmarks/lib/episode-metrics.mjs";
import { benchmarkPrompt } from "../benchmarks/scua-agent.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tasks = JSON.parse(await readFile(path.join(root, "benchmarks/pilot/tasks.json"), "utf8"));
assert.equal(tasks.length, 20, "macOS pilot must contain exactly 20 versioned tasks");
assert.equal(new Set(tasks.map((task) => task.id)).size, 20, "pilot task IDs must be unique");
assert.deepEqual(Object.fromEntries([...new Set(tasks.map((task) => task.domain))].map((domain) => [domain, tasks.filter((task) => task.domain === domain).length])), {
	calculator: 8,
	textedit: 4,
	finder: 4,
	browser: 4,
});
for (const task of tasks) assert(task.instruction && task.setup?.kind && task.evaluate?.kind, `task ${task.id} is incomplete`);

const events = [
	{ type: "item.completed", item: { id: "1", type: "mcp_tool_call", server: "scua", tool: "act_ui", status: "completed", result: { structured_content: { execution: { outcome: "worked", delivery: "ax", verification: { status: "verified" } }, nested: { error: { code: "guard_failed" } } } } } },
	{ type: "item.completed", item: { id: "2", type: "command_execution", command: "osascript" } },
	{ type: "item.completed", item: { id: "3", type: "agent_message", text: 'SCUA_BENCHMARK_RESULT {"status":"success","summary":"verified"}' } },
	{ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } },
];
const metrics = summarizeCodexEvents(events, new Map([["1", 25]]));
assert.equal(metrics.integrityPassed, false, "non-SCUA task action was not rejected by integrity audit");
assert.equal(metrics.scuaToolCalls, 1);
assert.equal(metrics.outcomes.worked, 1);
assert.equal(metrics.verification.verified, 1);
assert.equal(metrics.staleErrors, 1);
assert.equal(metrics.agentClaim.status, "success");
assert.equal(metrics.claimConsistent, true);
assert.match(benchmarkPrompt("rename the file"), /only tools from the SCUA MCP server/);

const inconsistent = summarizeCodexEvents([
	{ type: "item.completed", item: { id: "failed", type: "mcp_tool_call", server: "scua", tool: "act_ui", status: "completed", result: { structured_content: { execution: { outcome: "didnt", verification: { status: "failed" } } } } } },
	{ type: "item.completed", item: { id: "claim", type: "agent_message", text: 'SCUA_BENCHMARK_RESULT {"status":"success","summary":"looked right"}' } },
]);
assert.equal(inconsistent.claimConsistent, false, "a read-only follow-up could legitimize a failed final mutation");

const preexistingAfterFailure = summarizeCodexEvents([
	{ type: "item.completed", item: { type: "mcp_tool_call", server: "scua", tool: "act_ui", status: "completed", result: { structured_content: { execution: { outcome: "unknown", error: { code: "post_action_observation_failed" } } } } } },
	{ type: "item.completed", item: { type: "mcp_tool_call", server: "scua", tool: "act_ui", status: "completed", result: { structured_content: { execution: { outcome: "worked", verification: { status: "preexisting" } } } } } },
	{ type: "item.completed", item: { type: "agent_message", text: 'SCUA_BENCHMARK_RESULT {"status":"success"}' } },
]);
assert.equal(preexistingAfterFailure.claimConsistent, false, "a preexisting value incorrectly cleared an unresolved mutation failure");

const verifiedRecovery = summarizeCodexEvents([
	{ type: "item.completed", item: { type: "mcp_tool_call", server: "scua", tool: "act_ui", status: "completed", result: { structured_content: { execution: { outcome: "didnt" } } } } },
	{ type: "item.completed", item: { type: "mcp_tool_call", server: "scua", tool: "act_ui", status: "completed", result: { structured_content: { execution: { outcome: "worked", verification: { status: "verified" } } } } } },
	{ type: "item.completed", item: { type: "agent_message", text: 'SCUA_BENCHMARK_RESULT {"status":"success"}' } },
]);
assert.equal(verifiedRecovery.claimConsistent, true, "a later verified mutation did not clear a prior recoverable failure");

const unknownClaim = summarizeCodexEvents([
	{ type: "item.completed", item: { type: "mcp_tool_call", server: "scua", tool: "act_ui", status: "completed", result: { structured_content: { execution: { outcome: "unknown" } } } } },
	{ type: "item.completed", item: { type: "agent_message", text: 'SCUA_BENCHMARK_RESULT {"status":"success"}' } },
]);
assert.equal(unknownClaim.claimConsistent, false, "an unverified mutation was accepted as a successful task claim");

const successfulPlanClaim = summarizeCodexEvents([
	{ type: "item.completed", item: { type: "mcp_tool_call", server: "scua", tool: "execute_plan", status: "completed", result: { structured_content: { status: "succeeded", nodes: [{ status: "succeeded", outcome: "worked" }] } } } },
	{ type: "item.completed", item: { type: "agent_message", text: 'SCUA_BENCHMARK_RESULT {"status":"success"}' } },
]);
assert.equal(successfulPlanClaim.claimConsistent, true, "a fully succeeded action plan was not accepted as conclusive mutation evidence");

const summary = aggregateEpisodes([
	{ durationMs: 100, evaluation: { passed: true }, activity: { focusChanges: 0, maximumCursorDistance: 0 }, agent: { metrics: { integrityPassed: true, scuaToolCalls: 2, foregroundEscalations: 0, staleErrors: 0, usage: { input_tokens: 10, output_tokens: 4 } } } },
	{ durationMs: 300, evaluation: { passed: false }, activity: { focusChanges: 2, maximumCursorDistance: 12 }, agent: { metrics: { integrityPassed: false, scuaToolCalls: 4, foregroundEscalations: 1, staleErrors: 1, usage: { input_tokens: 20, output_tokens: 6 } } } },
]);
assert.deepEqual(summary, { tasks: 2, passed: 1, successRate: 0.5, qualifiedPassed: 1, qualifiedSuccessRate: 0.5, integrityPassed: 1, integrityRate: 0.5, claimConsistent: 2, claimConsistencyRate: 1, durationMs: 400, meanDurationMs: 200, scuaToolCalls: 6, meanScuaToolCalls: 3, inputTokens: 30, outputTokens: 10, focusChanges: 2, maximumCursorDistance: 12, physicalCursorMovedEpisodes: 1, foregroundEscalations: 1, staleErrors: 1 });

const adapter = await readFile(path.join(root, "benchmarks/adapters/macagentbench/scua_agent.py"), "utf8");
assert.match(adapter, /class ScuaAgent/);
assert.match(adapter, /mcp_servers\.scua\.command/);
assert.match(adapter, /default_tools_approval_mode/);
assert.match(adapter, /env\.run_command_with_status/);
assert.match(adapter, /trajectory\.jsonl/);

const macAgentBenchPatch = await readFile(path.join(root, "benchmarks/adapters/macagentbench/batch_run.patch"), "utf8");
assert.match(macAgentBenchPatch, /isinstance\(agent, \(OpenClawAgent, ScuaAgent\)\)/);

console.log("Benchmark harness checks passed.");
