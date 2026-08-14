type JsonSchema = Record<string, unknown>;

export interface McpToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: JsonSchema;
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	};
}

const string = (description: string, extras: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extras });
const number = (description: string, extras: JsonSchema = {}): JsonSchema => ({ type: "number", description, ...extras });

function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
	return {
		type: "object",
		properties,
		...(required.length ? { required } : {}),
		additionalProperties: false,
	};
}

function tool(
	name: string,
	title: string,
	description: string,
	inputSchema: JsonSchema,
	readOnly: boolean,
): McpToolDefinition {
	return {
		name,
		title,
		description,
		inputSchema,
		annotations: {
			readOnlyHint: readOnly,
			destructiveHint: !readOnly,
			idempotentHint: readOnly,
			openWorldHint: false,
		},
	};
}

const stateId = string("Immutable observation state owning every @e element reference used by this operation.");
const point = { x: number("Window-relative x coordinate."), y: number("Window-relative y coordinate.") };
const mouseButton = string("Mouse button.", { enum: ["left", "right", "middle"] });

const action: JsonSchema = {
	oneOf: [
		object({ action: { type: "string", const: "press" }, ref: string("Actionable element reference.") }, ["action", "ref"]),
		object({ action: { type: "string", const: "click" }, ref: string("Element reference."), button: mouseButton, clickCount: number("Click count.", { minimum: 1, maximum: 3 }) }, ["action", "ref"]),
		object({ action: { type: "string", const: "click" }, ...point, button: mouseButton, clickCount: number("Click count.", { minimum: 1, maximum: 3 }) }, ["action", "x", "y"]),
		object({ action: { type: "string", const: "setText" }, ref: string("Editable element reference."), text: string("Replacement text.") }, ["action", "ref", "text"]),
		object({ action: { type: "string", const: "typeText" }, ref: string("Optional editable element reference."), text: string("Text to type.") }, ["action", "text"]),
		object({ action: { type: "string", const: "keypress" }, ref: string("Optional focused element reference."), keys: { type: "array", items: { type: "string" }, minItems: 1 } }, ["action", "keys"]),
		object({ action: { type: "string", const: "scroll" }, ref: string("Optional scrollable element reference."), scrollX: number("Horizontal delta."), scrollY: number("Vertical delta.") }, ["action"]),
		object({ action: { type: "string", const: "drag" }, path: { type: "array", items: object(point, ["x", "y"]), minItems: 2 } }, ["action", "path"]),
		object({ action: { type: "string", const: "moveMouse" }, ...point }, ["action", "x", "y"]),
	],
};

const conditionProperties: Record<string, JsonSchema> = {
	ref: string("Specific @e reference to test."),
	scopeRef: string("Restrict matching to this @e subtree."),
	text: string("Text that must match."),
	role: string("Exact normalized role."),
	value: string("Exact normalized value; normally pair with ref."),
	until: string("Desired condition.", { enum: ["present", "absent"], default: "present" }),
	timeoutMs: number("Maximum wait in milliseconds.", { minimum: 100, maximum: 60_000, default: 10_000 }),
};

export const mcpTools: McpToolDefinition[] = [
	tool(
		"find_roots",
		"Find UI roots",
		"Find a bounded, ranked set of controllable desktop windows and browser-page roots.",
		object({
			text: string("Ranked application or title text."),
			app: string("Exact normalized application name."),
			bundleId: string("Exact bundle identifier."),
			pid: number("Exact process identifier."),
			kind: string("Exact root kind.", { enum: ["window", "menu", "sheet", "popover", "dialog", "browser_page"] }),
		}),
		true,
	),
	tool(
		"observe_ui",
		"Observe UI",
		"Capture one exact root into an immutable state and return a compact folded outline.",
		object({
			root: string("Exact @r root reference from find_roots."),
			mode: string("Observation evidence mode.", { enum: ["semantic", "visual", "fused"], default: "fused" }),
		}),
		true,
	),
	tool(
		"search_ui",
		"Search cached UI",
		"Search the complete cached outline without rescanning the live application. At least one predicate is required.",
		object({
			stateId,
			text: string("Human-readable text or label."),
			role: string("Exact normalized role, such as button."),
			capability: string("Exact capability, such as press or setValue."),
		}, ["stateId"]),
		true,
	),
	tool(
		"expand_ui",
		"Expand cached UI",
		"Return bounded local outline context around one cached element reference.",
		object({ stateId, ref: string("Element reference."), depth: number("Subtree depth.", { minimum: 1, maximum: 8, default: 3 }) }, ["stateId", "ref"]),
		true,
	),
	tool(
		"inspect_ui",
		"Inspect cached UI",
		"Inspect one exact cached element with geometry, capabilities, and evidence.",
		object({ stateId, ref: string("Element reference.") }, ["stateId", "ref"]),
		true,
	),
	tool(
		"act_ui",
		"Act on UI",
		"Perform one checked generic UI transaction from an immutable state and return its verified successor state.",
		object({
			stateId,
			actions: { type: "array", items: action, minItems: 1, maxItems: 20 },
			expect: object(conditionProperties),
		}, ["stateId", "actions"]),
		false,
	),
	tool(
		"read_text",
		"Read UI text",
		"Read a bounded page from a state-owned UI element or immutable truncated-output reference.",
		object({ ref: string("@e UI or @o output reference."), offset: number("Character or byte offset.", { minimum: 0 }), stateId }, ["ref"]),
		true,
	),
	tool(
		"wait_for",
		"Wait for UI condition",
		"Wait through the platform change-notification path for one precise condition and return the successor state.",
		object({ stateId, ...conditionProperties }, ["stateId"]),
		true,
	),
];

export const mcpToolNames = mcpTools.map((definition) => definition.name);
