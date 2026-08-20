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
const selector = object({
	text: string("Human-readable text or label."),
	role: string("Exact normalized role, such as button or textbox."),
	capability: string("Exact capability, such as press or setValue."),
	match: string("Require one unambiguous match, or deliberately use the first ranked match.", { enum: ["unique", "first"], default: "unique" }),
});

const action: JsonSchema = {
	oneOf: [
		object({ action: { type: "string", const: "press" }, ref: string("Actionable element reference.") }, ["action", "ref"]),
		object({ action: { type: "string", const: "press" }, selector }, ["action", "selector"]),
		object({ action: { type: "string", const: "click" }, ref: string("Element reference."), button: mouseButton, clickCount: number("Click count.", { minimum: 1, maximum: 3 }) }, ["action", "ref"]),
		object({ action: { type: "string", const: "click" }, selector, button: mouseButton, clickCount: number("Click count.", { minimum: 1, maximum: 3 }) }, ["action", "selector"]),
		object({ action: { type: "string", const: "click" }, ...point, button: mouseButton, clickCount: number("Click count.", { minimum: 1, maximum: 3 }) }, ["action", "x", "y"]),
		object({ action: { type: "string", const: "select" }, ref: string("Selectable element or descendant reference.") }, ["action", "ref"]),
		object({ action: { type: "string", const: "select" }, selector }, ["action", "selector"]),
		object({ action: { type: "string", const: "setText" }, ref: string("Editable element reference."), text: string("Replacement text.") }, ["action", "ref", "text"]),
		object({ action: { type: "string", const: "setText" }, selector, text: string("Replacement text.") }, ["action", "selector", "text"]),
		object({ action: { type: "string", const: "typeText" }, ref: string("Optional editable element reference."), text: string("Text to type.") }, ["action", "text"]),
		object({ action: { type: "string", const: "typeText" }, selector, text: string("Text to type.") }, ["action", "selector", "text"]),
		object({ action: { type: "string", const: "keypress" }, ref: string("Optional focused element reference."), keys: { type: "array", items: { type: "string" }, minItems: 1 } }, ["action", "keys"]),
		object({ action: { type: "string", const: "keypress" }, selector, keys: { type: "array", items: { type: "string" }, minItems: 1 } }, ["action", "selector", "keys"]),
		object({ action: { type: "string", const: "scroll" }, ref: string("Optional scrollable element reference."), scrollX: number("Horizontal delta."), scrollY: number("Vertical delta.") }, ["action"]),
		object({ action: { type: "string", const: "scroll" }, selector, scrollX: number("Horizontal delta."), scrollY: number("Vertical delta.") }, ["action", "selector"]),
		object({ action: { type: "string", const: "drag" }, path: { type: "array", items: object(point, ["x", "y"]), minItems: 2 } }, ["action", "path"]),
		object({ action: { type: "string", const: "moveMouse" }, ref: string("Element reference whose semantic center should receive the visual agent cursor.") }, ["action", "ref"]),
		object({ action: { type: "string", const: "moveMouse" }, selector }, ["action", "selector"]),
		object({ action: { type: "string", const: "moveMouse" }, ...point }, ["action", "x", "y"]),
		object({ action: { type: "string", const: "wait" }, ms: number("Focus-preserving delay before the next action in the same transaction.", { minimum: 0, maximum: 60_000 }) }, ["action", "ms"]),
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

const searchQueryProperties: Record<string, JsonSchema> = {
	id: string("Optional caller label echoed with this query's result."),
	text: string("Human-readable text or label."),
	role: string("Exact normalized role, such as button."),
	capability: string("Exact capability, such as press or setValue."),
};

const condition = object(conditionProperties);
const planNodeProperties: Record<string, JsonSchema> = {
	id: string("Stable node ID within this plan."),
	dependsOn: { type: "array", items: string("Predecessor node ID."), uniqueItems: true, maxItems: 16 },
	actions: { type: "array", items: action, minItems: 1, maxItems: 20 },
	guards: { type: "array", items: condition, minItems: 1, maxItems: 8 },
	expect: condition,
	skipIfExpected: { type: "boolean", description: "Skip delivery and return an unchanged successor when expect is already satisfied." },
	conflictPolicy: string("Refresh and retry definitely-undelivered conflicts, or fail this branch immediately.", { enum: ["refresh", "abort"], default: "refresh" }),
	retry: object({
		maxAttempts: number("Total attempts including the first.", { minimum: 1, maximum: 3, default: 2 }),
		budgetMs: number("Per-node retry budget.", { minimum: 0, maximum: 10000, default: 2500 }),
	}),
	acceptUnknown: { type: "boolean", description: "Allow an unverified unknown action outcome to satisfy dependencies. Defaults to false." },
};
const planNode: JsonSchema = {
	oneOf: [
		object({ ...planNodeProperties, stateId }, ["id", "stateId", "actions"]),
		object({ ...planNodeProperties, stateFrom: string("Predecessor node whose successor state becomes this node's input.") }, ["id", "stateFrom", "dependsOn", "actions"]),
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
		"Create an agent-owned browser-page root at an absolute HTTP(S) URL, or navigate an existing browser-page state. With the SCUA companion extension, new inactive tabs share one process-scoped group in the user's existing Chrome window; ownership fences exclude unrelated tabs. A separate temporary-profile browser is the fallback.",
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
		"Search the complete cached outline without rescanning the live application. Batch independent selectors in queries to avoid model round trips. If a requested control is hidden, results identify likely pressable disclosures; press one and search the successor state.",
		{
			oneOf: [
				object({ stateId, ...searchQueryProperties }, ["stateId"]),
				object({ stateId, queries: { type: "array", items: object(searchQueryProperties), minItems: 1, maxItems: 16 } }, ["stateId", "queries"]),
			],
		},
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
			skipIfExpected: { type: "boolean", description: "Skip delivery when expect is already satisfied." },
		}, ["stateId", "actions"]),
		false,
	),
	tool(
		"execute_plan",
		"Execute adaptive action plan",
		"Execute a guarded dependency DAG locally. Actions may use semantic selectors resolved against each predecessor's successor state, so menus and editors need not exist when the plan is authored. Independent nodes overlap; definitely-undelivered conflicts refresh within a bounded budget.",
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
	tool(
		"subscribe_ui",
		"Subscribe to UI changes",
		"Create an actor-owned, request-independent subscription from an immutable UI state. Native Accessibility and browser DOM notifications wake the stream; every delivered change is followed by an authoritative semantic observation.",
		object({ stateId, label: string("Optional caller label for diagnostics."), ...conditionProperties }, ["stateId"]),
		false,
	),
	tool(
		"read_ui_events",
		"Read UI events",
		"Long-read a durable UI subscription from an opaque resume cursor. Returns bounded events, an explicit overflow signal, the next cursor, and a fresh successor state after changes.",
		object({
			subscriptionId: string("Subscription returned by subscribe_ui."),
			cursor: string("Opaque cursor returned by subscribe_ui or a prior read_ui_events call."),
			timeoutMs: number("Long-read timeout.", { minimum: 0, maximum: 60_000, default: 30_000 }),
			maxEvents: number("Maximum events to return.", { minimum: 1, maximum: 128, default: 64 }),
		}, ["subscriptionId", "cursor"]),
		true,
	),
	tool(
		"unsubscribe_ui",
		"Unsubscribe from UI changes",
		"Close one actor-owned UI subscription and stop its native/browser event pump.",
		object({ subscriptionId: string("Subscription returned by subscribe_ui.") }, ["subscriptionId"]),
		false,
	),
];

export const mcpToolNames = mcpTools.map((definition) => definition.name);
