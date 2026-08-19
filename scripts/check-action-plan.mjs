import assert from "node:assert/strict";
import { executeAdaptiveActionPlan } from "../src/action-plan.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const classify = (error) => ({
	code: error.code ?? "operation_failed",
	message: error.message ?? String(error),
	retryable: error.delivery === "definitely_not_delivered",
	delivery: error.delivery ?? "may_have_been_delivered",
	recovery: error.recovery ?? "abort",
});

let active = 0;
let peak = 0;
const calls = [];
const refreshed = [];
const plan = await executeAdaptiveActionPlan({
	planId: "fixture-adaptive",
	maxConcurrency: 8,
	nodes: [
		{ id: "alpha", stateId: "state-alpha", guards: [{ text: "alpha fixture" }], actions: [{ action: "setText", ref: "@e1", text: "alpha" }] },
		{ id: "beta", stateId: "state-beta", guards: [{ text: "beta fixture" }], actions: [{ action: "setText", ref: "@e1", text: "beta" }] },
		{ id: "alpha-followup", dependsOn: ["alpha"], stateFrom: "alpha", guards: [{ text: "followup fixture" }], actions: [{ action: "press", ref: "@e2" }] },
	],
}, {
	execute: async (node, stateId, attempt) => {
		calls.push({ id: node.id, stateId, attempt });
		active += 1;
		peak = Math.max(peak, active);
		await sleep(25);
		active -= 1;
		if (node.id === "alpha" && attempt === 1) {
			const error = new Error("live guard changed");
			error.code = "guard_failed";
			error.delivery = "definitely_not_delivered";
			error.recovery = "reobserve";
			throw error;
		}
		return { stateId: `${stateId}:${node.id}:${attempt}` };
	},
	refresh: async (node, stateId) => {
		refreshed.push(node.id);
		return `${stateId}:refreshed`;
	},
	successorStateId: (result) => result.stateId,
	classify,
});

assert.equal(plan.status, "succeeded", "recoverable branch did not complete the plan");
assert.equal(plan.peakConcurrency, 2, "independent ready nodes did not overlap");
assert(peak >= 2, "adapter did not execute independent nodes concurrently");
assert.deepEqual(refreshed, ["alpha"], "only the conflicting branch should refresh");
assert.equal(plan.nodes.find((node) => node.id === "alpha")?.attempts.length, 2, "conflicting node did not retry exactly once");
assert.equal(plan.nodes.find((node) => node.id === "alpha")?.attempts[0]?.status, "refreshed", "first conflict was not recorded as a refresh");
assert.equal(calls.find((call) => call.id === "alpha-followup")?.stateId, "state-alpha:refreshed:alpha:2", "successor state did not flow through stateFrom");

let unsafeAttempts = 0;
const partial = await executeAdaptiveActionPlan({
	planId: "fixture-partial",
	nodes: [
		{ id: "unsafe", stateId: "unsafe-state", guards: [{ text: "unsafe fixture" }], actions: [{ action: "press", ref: "@e1" }] },
		{ id: "blocked-child", dependsOn: ["unsafe"], stateFrom: "unsafe", guards: [{ text: "blocked fixture" }], actions: [{ action: "press", ref: "@e2" }] },
		{ id: "independent", stateId: "independent-state", guards: [{ text: "independent fixture" }], actions: [{ action: "setText", ref: "@e1", text: "ok" }] },
	],
}, {
	execute: async (node, stateId) => {
		if (node.id === "unsafe") {
			unsafeAttempts += 1;
			const error = new Error("delivery may have happened");
			error.code = "unverified_outcome";
			error.delivery = "may_have_been_delivered";
			throw error;
		}
		return { stateId: `${stateId}:done` };
	},
	refresh: async () => { throw new Error("unsafe delivery must not refresh"); },
	successorStateId: (result) => result.stateId,
	classify,
});
assert.equal(partial.status, "partially_failed", "unrelated success should survive a failed branch");
assert.equal(unsafeAttempts, 1, "possibly-delivered action was replayed");
assert.equal(partial.nodes.find((node) => node.id === "blocked-child")?.status, "blocked", "failed dependency did not block only its descendant");
assert.equal(partial.nodes.find((node) => node.id === "independent")?.status, "succeeded", "unrelated branch was cancelled");

await assert.rejects(
	() => executeAdaptiveActionPlan({
		nodes: [
			{ id: "a", dependsOn: ["b"], stateFrom: "b", guards: [{ text: "a fixture" }], actions: [{ action: "press", ref: "@e1" }] },
			{ id: "b", dependsOn: ["a"], stateFrom: "a", guards: [{ text: "b fixture" }], actions: [{ action: "press", ref: "@e1" }] },
		],
	}, {
		execute: async () => ({ stateId: "unused" }),
		refresh: async () => "unused",
		successorStateId: (result) => result.stateId,
		classify,
	}),
	/dependency cycle/,
	"cyclic action plan was accepted",
);

const cancelledController = new AbortController();
let cancelledStarted = 0;
const cancelledPlanPromise = executeAdaptiveActionPlan({
	planId: "fixture-cancelled",
	maxConcurrency: 1,
	nodes: [
		{ id: "running", stateId: "running-state", guards: [{ text: "running" }], actions: [{ action: "press", ref: "@e1" }] },
		{ id: "not-started", stateId: "pending-state", guards: [{ text: "pending" }], actions: [{ action: "press", ref: "@e2" }] },
	],
}, {
	execute: async (_node, _stateId, _attempt, signal) => {
		cancelledStarted += 1;
		await new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, 1_000);
			signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Action plan was aborted.")); }, { once: true });
		});
		return { stateId: "unexpected" };
	},
	refresh: async () => "unexpected",
	successorStateId: (result) => result.stateId,
	classify: (error) => cancelledController.signal.aborted
		? { code: "cancelled", message: error.message ?? String(error), retryable: true, delivery: "may_have_been_delivered", recovery: "reobserve" }
		: classify(error),
}, cancelledController.signal);
setTimeout(() => cancelledController.abort(), 20);
const cancelledPlan = await cancelledPlanPromise;
assert.equal(cancelledPlan.status, "cancelled", "aborted action plan did not return an explicit cancelled status");
assert.equal(cancelledStarted, 1, "cancellation allowed a pending plan node to start");
assert.equal(cancelledPlan.nodes.find((node) => node.id === "running")?.status, "cancelled", "in-flight plan node did not report cancellation");
assert.equal(cancelledPlan.nodes.find((node) => node.id === "not-started")?.status, "cancelled", "pending plan node was not cancelled before delivery");
assert.equal(cancelledPlan.nodes.find((node) => node.id === "not-started")?.error?.delivery, "definitely_not_delivered", "never-started cancellation lost delivery certainty");

console.log(`Adaptive action-plan checks passed (fixture ${plan.durationMs}ms, peak concurrency ${plan.peakConcurrency}).`);
