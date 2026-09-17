import assert from "node:assert/strict";
import { selectGoalAction } from "../src/jev-policy.ts";

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

console.log("Jev policy checks passed: complete pairs, calibrated metadata, and uncapped hierarchical selection.");
