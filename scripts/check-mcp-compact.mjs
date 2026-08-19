import assert from "node:assert/strict";
import { compactStructuredContent } from "../mcp/compact.ts";

const node = (ref, children = [], extras = {}) => ({
	ref, role: "AXGroup", actions: [], canPress: false, canSetValue: false, canScroll: false,
	isTextInput: false, pictureOnly: false, children, ...extras,
});
const details = {
	tool: "observe_ui",
	capture: { stateId: "state-1" },
	renderedOutline: "duplicate text".repeat(1000),
	outline: {
		lookId: "look-1",
		root: node("root", [
			node("button", [], { canPress: true }),
			node("ocr", [], { pictureOnly: true }),
			node("field", [], { canSetValue: true, isTextInput: true }),
		]),
	},
};
const compact = compactStructuredContent(details);
assert.equal(compact.outline, undefined, "compact MCP details leaked the immutable outline");
assert.equal(compact.renderedOutline, undefined, "compact MCP details duplicated rendered outline text");
assert.equal(compact.capture.stateId, "state-1", "compact MCP details dropped the continuation state");
assert.deepEqual(compact.capabilities, {
	nodeCount: 4,
	semanticActionable: 2,
	pictureOnly: 1,
	textInputs: 1,
	backgroundControl: "semantic",
	visualActionsRequirePostcondition: true,
});
const manyChanges = compactStructuredContent({ tool: "act_ui", changes: Array.from({ length: 40 }, (_, index) => ({ index })) });
assert.equal(manyChanges.changes.length, 32, "compact response array budget was not enforced");
assert.deepEqual(manyChanges.truncatedArrays["$.changes"], { returned: 32, total: 40 }, "compact response omitted array truncation metadata");
console.log("MCP compact response checks passed.");
