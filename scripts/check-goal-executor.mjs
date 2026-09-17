import assert from "node:assert/strict";
import { createGoalExecutor } from "../src/goal-executor.ts";
import { currentVisualAgentId } from "../src/control-plane.ts";

function serializedOutline(stateId) {
	return {
		lookId: `look-${stateId}`,
		root: {
			ref: "@e0", role: "AXWindow", subrole: "", identifier: "", roleDescription: "window", placeholder: "", title: "Test", description: "", value: "", actions: [],
			canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false,
			focused: false, offscreen: false, pictureOnly: false, truncated: false, text: [],
			children: [{
				ref: "@e1", role: "AXButton", subrole: "", identifier: "continue", roleDescription: "button", placeholder: "", title: "Continue", description: "", value: "", actions: ["AXPress"],
				canPress: true, canFocus: true, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false,
				focused: true, offscreen: false, pictureOnly: false, truncated: false, text: [], children: [],
			}],
		},
	};
}

function result(stateId, execution) {
	return {
		content: [{ type: "text", text: stateId }],
		details: {
			capture: { stateId },
			outline: serializedOutline(stateId),
			resource: { key: `resource:${stateId}` },
			target: { app: "Test", windowTitle: stateId },
			...(execution ? { execution } : {}),
		},
	};
}

let activeObservations = 0;
let peakObservations = 0;
let slowObservationFinished = false;
let fastAdvancedBeforeSlow = false;
const observedParams = [];
const visualIds = [];
let actions = 0;
const adapter = {
	async observe(_id, params) {
		observedParams.push(params);
		activeObservations += 1;
		peakObservations = Math.max(peakObservations, activeObservations);
		await new Promise((resolve) => setTimeout(resolve, params.root === "@r1" ? 70 : 10));
		if (params.root === "@r1") slowObservationFinished = true;
		activeObservations -= 1;
		return result(params.stateId ?? params.root ?? "frontmost");
	},
	async act(_id, params) {
		actions += 1;
		if (params.stateId === "@r2" && !slowObservationFinished) fastAdvancedBeforeSlow = true;
		visualIds.push(currentVisualAgentId());
		await new Promise((resolve) => setTimeout(resolve, 15));
		return result(`${params.stateId}-next`, { outcome: "worked", verification: { status: "verified" } });
	},
	async decide(state, candidates) {
		const chosen = state.recentActions.length ? candidates.find((candidate) => candidate.kind === "done") : candidates.find((candidate) => candidate.kind === "action");
		return { candidate: chosen, confidence: 0.94, margin: 0.72, probabilities: { [chosen.id]: 0.94 }, model: "fake-jev", usage: { inputTokens: 4, outputTokens: 1 }, latencyMs: 1, requestCount: 1, selectionDepth: 1 };
	},
};
const execute = createGoalExecutor(adapter);
const parallel = await execute("test", {
	goal: "Advance all windows",
	tasks: [
		{ id: "one", root: "@r1" },
		{ id: "two", root: "@r2" },
		{ id: "three", root: "@r3" },
	],
	maxConcurrency: 3,
}, undefined, {});
assert.equal(parallel.details.status, "succeeded");
assert.equal(parallel.details.peakConcurrency, 3);
assert.equal(peakObservations, 3, "workers did not independently overlap");
assert.equal(fastAdvancedBeforeSlow, true, "a fast worker waited at a global phase barrier for a slow worker");
assert.equal(new Set(visualIds).size, 3, "parallel workers did not receive independent cursor identities");

observedParams.length = 0;
const handoff = await execute("handoff", {
	goal: "Complete a two-stage workflow",
	tasks: [
		{ id: "author", root: "@r4" },
		{ id: "review", stateFrom: "author", dependsOn: ["author"] },
	],
}, undefined, {});
assert.equal(handoff.details.status, "succeeded");
const author = handoff.details.tasks.find((task) => task.id === "author");
assert.equal(observedParams[1].stateId, author.finalStateId, "stateFrom did not hand the exact successor state to its dependent");

let unsafeActions = 0;
const guarded = createGoalExecutor({
	observe: async () => result("guarded"),
	act: async () => { unsafeActions += 1; return result("unsafe"); },
	decide: async (_state, candidates) => ({ candidate: candidates[0], confidence: 0.51, margin: 0.01, probabilities: { [candidates[0].id]: 0.51 }, model: "fake-jev", usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestCount: 1, selectionDepth: 1 }),
});
const lowConfidence = await guarded("guard", { goal: "Do something", minConfidence: 0.6, minMargin: 0.1 }, undefined, {});
assert.equal(lowConfidence.details.tasks[0].status, "escalated");
assert.equal(unsafeActions, 0, "a low-confidence Jev decision caused a side effect");

console.log(`Goal executor checks passed: ${actions} actions, true overlap, state handoff, distinct cursors, and fail-closed confidence gates.`);
