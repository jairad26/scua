type JsonRecord = Record<string, unknown>;

const OMIT_KEYS = new Set(["outline", "renderedOutline", "jpegBase64", "image", "debug"]);
const MAX_ARRAY_ITEMS = 32;
const MAX_STRING_CHARS = 8_000;
const INCIDENTAL_ACTIONS = new Set(["AXShowMenu", "AXScrollToVisible"]);

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outlineCapabilities(value: unknown): JsonRecord | undefined {
	if (!isRecord(value) || !isRecord(value.root)) return undefined;
	let nodeCount = 0;
	let semanticActionable = 0;
	let pictureOnly = 0;
	let textInputs = 0;
	const queue: unknown[] = [value.root];
	while (queue.length > 0) {
		const node = queue.shift();
		if (!isRecord(node)) continue;
		nodeCount += 1;
		const actions = Array.isArray(node.actions) ? node.actions.filter((action) => typeof action === "string" && !INCIDENTAL_ACTIONS.has(action)) : [];
		if (node.canPress === true || node.canSetValue === true || node.canScroll === true || node.canIncrement === true || node.canDecrement === true || node.isTextInput === true || actions.length > 0) semanticActionable += 1;
		if (node.pictureOnly === true) pictureOnly += 1;
		if (node.isTextInput === true) textInputs += 1;
		if (Array.isArray(node.children)) queue.push(...node.children);
	}
	return {
		nodeCount,
		semanticActionable,
		pictureOnly,
		textInputs,
		backgroundControl: semanticActionable > 0 ? "semantic" : pictureOnly > 0 ? "visual_best_effort" : "unsupported",
		visualActionsRequirePostcondition: pictureOnly > 0,
	};
}

function compactValue(value: unknown, depth = 0, path = "$", truncated: JsonRecord = {}): unknown {
	if (depth > 8) return "[depth-limited]";
	if (typeof value === "string") return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
	if (Array.isArray(value)) {
		if (value.length > MAX_ARRAY_ITEMS) truncated[path] = { returned: MAX_ARRAY_ITEMS, total: value.length };
		return value.slice(0, MAX_ARRAY_ITEMS).map((item, index) => compactValue(item, depth + 1, `${path}[${index}]`, truncated));
	}
	if (!isRecord(value)) return value;
	const result: JsonRecord = {};
	for (const [key, item] of Object.entries(value)) {
		if (OMIT_KEYS.has(key) || item === undefined) continue;
		result[key] = compactValue(item, depth + 1, `${path}.${key}`, truncated);
	}
	return result;
}

/** Keep immutable UI state in SCUA while returning only decision-relevant MCP metadata. */
export function compactStructuredContent(details: unknown): unknown {
	if (!isRecord(details)) return compactValue(details);
	const truncated: JsonRecord = {};
	const compact = compactValue(details, 0, "$", truncated) as JsonRecord;
	const capabilities = outlineCapabilities(details.outline);
	if (capabilities) compact.capabilities = capabilities;
	if (Object.keys(truncated).length > 0) compact.truncatedArrays = truncated;
	return compact;
}
