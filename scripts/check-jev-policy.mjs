import assert from "node:assert/strict";
import { planGoalTaskGraph, selectGoalAction, selectGoalActionSequence } from "../src/jev-policy.ts";

const baseState = {
	goal: "Complete the task",
	taskId: "main",
	objective: "Complete the task",
	step: 0,
	ui: {},
	dependencies: [],
	recentActions: [],
};

function fakeClient(select) {
	return {
		calls: [],
		async systemOne(request) {
			this.calls.push(request);
			const answers = {};
			for (const [name, question] of Object.entries(request.questions)) {
				const labels = Object.keys(question.criteria);
				const selected = select(labels, question, name, this.calls.length);
				answers[name] = {
					type: "choice",
					choice: selected,
					confidence: 0.91,
					probabilities: Object.fromEntries(labels.map((label) => [label, label === selected ? 0.91 : 0.09 / Math.max(1, labels.length - 1)])),
				};
			}
			return { model: "fake-jev", answers, usage: { input_tokens: 10, output_tokens: 2 } };
		},
	};
}

const simpleClient = fakeClient((labels) => labels.includes("a1") ? "a1" : labels[0]);
const simple = await selectGoalAction(baseState, [
	{ id: "a0", kind: "action", action: { action: "press", ref: "@e1" }, description: { operation: "press", target: "Cancel" } },
	{ id: "a1", kind: "action", action: { action: "press", ref: "@e2" }, description: { operation: "press", target: "Continue" } },
	{ id: "escalate", kind: "escalate", description: { operation: "escalate" } },
], { client: simpleClient });
assert.equal(simple.candidate.id, "a1");
assert.equal(simple.margin > 0.8, true);
assert.equal(simple.requestCount, 1);

const sequenceClient = fakeClient((labels) => labels[0]);
const sequenceLabels = ["1", "2", "Add", "3", "0", "Equals"];
const sequenceCandidates = sequenceLabels.map((label, index) => ({
	id: `a${index}`,
	kind: "action",
	action: { action: "press", ref: `@e${index}` },
	description: { operation: "press", target: { label } },
	microBatchStable: true,
}));
sequenceCandidates.push(
	{ id: "done", kind: "done", description: { operation: "done" } },
	{ id: "escalate", kind: "escalate", description: { operation: "escalate" } },
);
const sequence = await selectGoalActionSequence({ ...baseState, objective: "Calculate 12 + 30" }, sequenceCandidates, { maxActions: 6, client: sequenceClient });
assert.deepEqual(sequence.decisions.map((decision) => decision.candidate.id), ["a0", "a1", "a2", "a3", "a4", "a5"]);
assert.equal(sequence.compiledSequence, true);
assert.equal(sequence.requestCount, 0);
assert.equal(sequenceClient.calls.length, 0, "an exact stable sequence unnecessarily called TypeSafe");

const completedSequenceClient = fakeClient((labels) => labels.includes("done") ? "done" : labels[0]);
const afterSequence = await selectGoalActionSequence({
	...baseState,
	objective: "Calculate 12 + 30",
	recentActions: sequenceLabels.map((label) => ({ description: { target: { label } }, outcome: "unknown" })),
}, sequenceCandidates, { maxActions: 6, client: completedSequenceClient });
assert.equal(afterSequence.decisions[0].candidate.id, "done", "a delivered stable sequence was compiled a second time");
assert.equal(completedSequenceClient.calls.length, 1);

const largeCandidates = Array.from({ length: 520 }, (_, index) => ({
	id: `a${index}`,
	kind: "action",
	action: { action: "press", ref: `@e${index}` },
	description: { operation: "press", ordinal: index },
}));
largeCandidates.push(
	{ id: "done", kind: "done", description: { operation: "done" } },
	{ id: "wait", kind: "wait", action: { action: "wait", ms: 250 }, description: { operation: "wait" } },
	{ id: "escalate", kind: "escalate", description: { operation: "escalate" } },
);
const largeClient = fakeClient((labels) => labels.find((label) => label.startsWith("a")) ?? labels[0]);
const large = await selectGoalAction(baseState, largeCandidates, { client: largeClient });
assert.equal(large.selectionDepth, 2);
assert.equal(large.requestCount, 2, "all first-round groups should share one System One request");
const surfaced = new Set();
for (const call of largeClient.calls) {
	for (const question of Object.values(call.questions)) {
		for (const label of Object.keys(question.criteria)) surfaced.add(label);
	}
}
for (let index = 0; index < 520; index += 1) assert(surfaced.has(`a${index}`), `large-tree selection silently omitted a${index}`);
assert(surfaced.has("done") && surfaced.has("wait") && surfaced.has("escalate"), "terminal choices were not retained during hierarchical selection");

const plannerClient = fakeClient((_labels, _question, name) => {
	if (name === "root_r0") return "wave_0_inspect";
	if (name === "root_r1") return "wave_1_transform";
	return "exclude";
});
const plan = await planGoalTaskGraph("Research a fact and calculate a result", [
	{ id: "r0", root: "@r1", app: "Browser", title: "Research", kind: "browser_page", url: "https://example.com" },
	{ id: "r1", root: "@r2", app: "Calculator", title: "Calculator", kind: "window" },
	{ id: "r2", root: "@r3", app: "Slack", title: "General", kind: "window" },
], { maxWaves: 3, maxTasks: 2, client: plannerClient });
assert.deepEqual(plan.selected.map(({ app, role, wave }) => ({ app, role, wave })), [
	{ app: "Browser", role: "inspect", wave: 0 },
	{ app: "Calculator", role: "transform", wave: 1 },
]);
assert.deepEqual(plan.excluded.map(({ app }) => app), ["Slack"]);
assert.equal(plannerClient.calls.length, 1, "independent root-allocation questions were not batched into one System One request");
assert.equal(Object.keys(plannerClient.calls[0].questions).length, 3);

console.log("Jev policy checks passed: complete pairs, calibrated metadata, uncapped hierarchical selection, and batched task-graph allocation.");
