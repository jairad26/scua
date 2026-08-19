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
		object({ action: { type: "string", const: "moveMouse" }, ref: string("Element reference whose semantic center should receive the visual agent cursor.") }, ["action", "ref"]),
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

const condition = object(conditionProperties);
const planNodeProperties: Record<string, JsonSchema> = {
	id: string("Stable node ID within this plan."),
	dependsOn: { type: "array", items: string("Predecessor node ID."), uniqueItems: true, maxItems: 16 },
	actions: { type: "array", items: action, minItems: 1, maxItems: 20 },
	guards: { type: "array", items: condition, minItems: 1, maxItems: 8 },
	expect: condition,
	conflictPolicy: string("Refresh and retry definitely-undelivered conflicts, or fail this branch immediately.", { enum: ["refresh", "abort"], default: "refresh" }),
	retry: object({
		maxAttempts: number("Total attempts including the first.", { minimum: 1, maximum: 3, default: 2 }),
		budgetMs: number("Per-node retry budget.", { minimum: 0, maximum: 10000, default: 2500 }),
	}),
	acceptUnknown: { type: "boolean", description: "Allow an unverified unknown action outcome to satisfy dependencies. Defaults to false." },
};
const planNode: JsonSchema = {
	oneOf: [
		object({ ...planNodeProperties, stateId }, ["id", "stateId", "actions", "guards"]),
		object({ ...planNodeProperties, stateFrom: string("Predecessor node whose successor state becomes this node's input.") }, ["id", "stateFrom", "dependsOn", "actions", "guards"]),
	],
};

export const mcpTools: McpToolDefinition[] = [
	tool(
		"actor_session",
		"Manage logical actor",
		"Create, inspect, or close a coordinator-issued logical actor. Use the returned actorToken only as MCP request metadata scuaActorToken, never as a UI action argument.",
		{
			oneOf: [
				object({ action: { type: "string", const: "create" }, maxActions: number("Optional mutation budget.", { minimum: 1, maximum: 100000 }), ttlMs: number("Optional actor lifetime.", { minimum: 1000, maximum: 86400000 }) }, ["action"]),
				object({ action: { type: "string", const: "status" } }, ["action"]),
				object({ action: { type: "string", const: "close" } }, ["action"]),
			],
		},
		false,
	),
	tool(
		"claim_resource",
		"Manage resource ownership",
		"Acquire, renew, release, or atomically hand off a generic SCUA resource. The caller identity comes from authenticated MCP request metadata, not this action payload.",
		{
			oneOf: [
				object({ action: { type: "string", const: "acquire" }, resourceKey: string("Resource key returned by observe_ui or open_root."), ttlMs: number("Lease duration.", { minimum: 1000, maximum: 300000 }) }, ["action", "resourceKey"]),
				object({ action: { type: "string", const: "renew" }, resourceKey: string("Owned resource key."), leaseId: string("Coordinator-issued lease ID."), ttlMs: number("Lease duration.", { minimum: 1000, maximum: 300000 }) }, ["action", "resourceKey", "leaseId"]),
				object({ action: { type: "string", const: "release" }, resourceKey: string("Owned resource key."), leaseId: string("Coordinator-issued lease ID.") }, ["action", "resourceKey", "leaseId"]),
				object({ action: { type: "string", const: "handoff" }, resourceKey: string("Owned resource key."), leaseId: string("Coordinator-issued lease ID."), recipientActorId: string("Coordinator-issued recipient actor ID."), ttlMs: number("Recipient lease duration.", { minimum: 1000, maximum: 300000 }) }, ["action", "resourceKey", "leaseId", "recipientActorId"]),
			],
		},
		false,
	),
	tool(
		"open_root",
		"Open isolated root",
		"Create an agent-owned browser-page root at an absolute HTTP(S) URL, or navigate an existing browser-page state. The temporary profile is isolated from the user's normal browser and other SCUA processes.",
		object({
			kind: string("Root kind to create or navigate.", { enum: ["browser_page"], default: "browser_page" }),
			url: string("Absolute HTTP(S) URL."),
			stateId: string("Existing browser-page state to navigate; omit to create a new isolated root."),
		}, ["url"]),
		false,
	),
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
			stateId: string("Optional prior state to refresh while preserving stable element identities."),
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
		"Perform one checked generic UI transaction from an immutable state and return its verified successor state. Visual-only click, press, and drag actions require expect; semantic actions do not.",
		object({
			stateId,
			actions: { type: "array", items: action, minItems: 1, maxItems: 20 },
			guards: { type: "array", items: condition, minItems: 1, maxItems: 8 },
			expect: condition,
		}, ["stateId", "actions"]),
		false,
	),
	tool(
		"execute_plan",
		"Execute adaptive action plan",
		"Execute a guarded dependency DAG locally. Independent nodes overlap; successors flow through stateFrom; definitely-undelivered conflicts refresh and retry within a bounded budget; failed branches do not cancel unrelated work.",
		object({
			planId: string("Optional caller-defined plan identifier."),
			nodes: { type: "array", items: planNode, minItems: 1, maxItems: 64 },
			maxConcurrency: number("Maximum concurrently running ready nodes.", { minimum: 1, maximum: 32, default: 16 }),
		}, ["nodes"]),
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
