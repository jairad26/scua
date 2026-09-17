import assert from "node:assert/strict";
import { createGoalExecutor, goalConditionSatisfied } from "../src/goal-executor.ts";
import { restoreOutline } from "../src/outline.ts";
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

const markedValue = serializedOutline("marked");
markedValue.root.children[0].role = "AXStaticText";
markedValue.root.children[0].value = "\u200e0";
assert.equal(goalConditionSatisfied(restoreOutline(markedValue), { role: "statictext", value: "0" }), true, "platform role or format-control normalization broke exact value verification");

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
const decisionStates = [];
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
		decisionStates.push(state);
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
assert.equal(decisionStates.some((state) => state.ui.semanticFacts.some((fact) => fact.label === "Continue")), true, "Jev state omitted non-policy semantic UI facts");
assert.equal(decisionStates.some((state) => state.recentActions.some((action) => action.description?.target?.label === "Continue")), true, "recent action history retained only an unstable candidate ID");
assert.equal(decisionStates.some((state) => state.recentActions.some((action) => action.summary === "press \"Continue\" -> worked")), true, "recent action history omitted its human-readable ordered summary");

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
assert.equal(lowConfidence.details.status, "escalated", "an all-escalated worker run was misreported as failed");
assert.equal(lowConfidence.details.tasks[0].status, "escalated");
assert.equal(unsafeActions, 0, "a low-confidence Jev decision caused a side effect");

function sparseOutline(title) {
	return {
		lookId: `look-${title}`,
		root: {
			ref: "@e0", role: "RootWebArea", subrole: "", identifier: "", roleDescription: "", placeholder: "", title, description: "", value: "", actions: [],
			canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false,
			focused: false, offscreen: false, pictureOnly: false, truncated: false, text: [], children: [],
		},
	};
}
let settlingObservations = 0;
let settlingDecisions = 0;
const settling = createGoalExecutor({
	observe: async () => {
		settlingObservations += 1;
		return settlingObservations === 1 ? result("initial") : { content: [], details: { stateId: "loaded", outline: sparseOutline("Loaded") } };
	},
	act: async () => ({ content: [], details: { stateId: "loading", outline: sparseOutline("Loading"), execution: { outcome: "worked" } } }),
	decide: async (_state, candidates) => {
		settlingDecisions += 1;
		const candidate = candidates.find((item) => item.kind === "action");
		return { candidate, confidence: 0.95, margin: 0.8, probabilities: { [candidate.id]: 0.95 }, model: "fake-jev", usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestCount: 1, selectionDepth: 1 };
	},
});
const settled = await settling("settle", { goal: "Navigate", tasks: [{ id: "page", completion: { text: "Loaded" } }] }, undefined, {});
assert.equal(settled.details.status, "succeeded");
assert.equal(settlingObservations, 2, "a sparse post-navigation successor was not re-observed");
assert.equal(settlingDecisions, 1, "Jev was asked to classify a transient sparse loading tree");

const automaticStarts = [];
const automatic = createGoalExecutor({
	findRoots: async () => ({
		content: [],
		details: {
			windows: [
				{ windowRef: "@r10", app: "Browser", windowTitle: "Research", kind: "browser_page", browserUseAllowed: true },
				{ windowRef: "@r11", app: "Calculator", windowTitle: "Calculator", kind: "window", browserUseAllowed: true },
				{ windowRef: "@r12", app: "Slack", windowTitle: "General", kind: "window", browserUseAllowed: true },
			],
		},
	}),
	observe: async (_id, params) => {
		automaticStarts.push(params.root ?? params.stateId);
		return result(params.root ?? params.stateId);
	},
	act: async (_id, params) => result(`${params.stateId}-next`, { outcome: "worked", verification: { status: "verified" } }),
	decide: async (state, candidates) => {
		const candidate = state.recentActions.length ? candidates.find((item) => item.kind === "done") : candidates.find((item) => item.kind === "action");
		return { candidate, confidence: 0.95, margin: 0.8, probabilities: { [candidate.id]: 0.95 }, model: "fake-jev", usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestCount: 1, selectionDepth: 1 };
	},
	plan: async (_goal, roots) => ({
		selected: [
			{ ...roots[0], role: "inspect", wave: 0, confidence: 0.95, margin: 0.8, probabilities: { wave_0_inspect: 0.95 } },
			{ ...roots[1], role: "transform", wave: 1, confidence: 0.94, margin: 0.78, probabilities: { wave_1_transform: 0.94 } },
		],
		excluded: [{ id: roots[2].id, app: roots[2].app, title: roots[2].title, confidence: 0.98 }],
		model: "fake-planner",
		usage: { inputTokens: 12, outputTokens: 3 },
		latencyMs: 2,
	}),
});
const automaticallyPlanned = await automatic("automatic", {
	goal: "Research a value, then calculate with it",
	planning: { mode: "automatic", excludeApps: ["Notion"], maxTasks: 2, maxWaves: 3 },
	maxConcurrency: 2,
}, undefined, {});
assert.equal(automaticallyPlanned.details.status, "succeeded");
assert.equal(automaticallyPlanned.details.planning.status, "ready");
assert.deepEqual(automaticallyPlanned.details.tasks.map((task) => task.id), ["auto-0-browser", "auto-1-calculator"]);
assert.deepEqual(automaticStarts.slice(0, 2), ["@r10", "@r11"], "automatic dependency waves did not preserve root allocation order");
assert(automaticallyPlanned.details.tasks[1].startedAt >= automaticallyPlanned.details.tasks[0].completedAt, "wave-one work began before its prerequisite wave completed");
assert.equal(automaticallyPlanned.details.planning.excluded[0].app, "Slack");

let plannedUnsafeActions = 0;
const unsafePlan = createGoalExecutor({
	findRoots: async () => ({ content: [], details: { windows: [{ windowRef: "@r20", app: "Mail", windowTitle: "Inbox", kind: "window", browserUseAllowed: true }] } }),
	observe: async () => result("unused"),
	act: async () => { plannedUnsafeActions += 1; return result("unsafe"); },
	plan: async (_goal, roots) => ({
		selected: [{ ...roots[0], role: "communicate", wave: 0, confidence: 0.2, margin: 0.01, probabilities: { wave_0_communicate: 0.2 } }],
		excluded: [], model: "fake-planner", usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
	}),
});
const unsafePlanning = await unsafePlan("unsafe-plan", { goal: "Send something", planning: { mode: "automatic" }, minConfidence: 0.6 }, undefined, {});
assert.equal(unsafePlanning.details.status, "escalated");
assert.equal(unsafePlanning.details.peakConcurrency, 0);
assert.equal(plannedUnsafeActions, 0, "a low-confidence automatic plan caused a side effect");

console.log(`Goal executor checks passed: ${actions} actions, true overlap, state handoff, automatic task graphs, distinct cursors, and fail-closed confidence gates.`);
