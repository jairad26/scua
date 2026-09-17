import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecuteGoalParams, GoalTask, UiAction, UiCondition } from "./contract.ts";
import { runAsVisualAgent } from "./control-plane.ts";
import { outlineNodeLabel, restoreOutline, type Outline, type OutlineNode, type SerializedOutline } from "./outline.ts";
import {
	planGoalTaskGraph,
	selectGoalAction,
	selectGoalActionSequence,
	type JevActionCandidate,
	type JevActionSequenceDecision,
	type JevDecision,
	type JevDecisionState,
	type JevPlanningRoot,
	type JevTaskPlanDecision,
} from "./jev-policy.ts";

interface ToolResult {
	content: Array<{ type: string; [key: string]: unknown }>;
	details?: Record<string, any>;
}

export interface GoalExecutorAdapter {
	findRoots?(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult>;
	observe(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult>;
	act(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult>;
	decide?(state: JevDecisionState, candidates: JevActionCandidate[], signal?: AbortSignal): Promise<JevDecision>;
	decideSequence?(state: JevDecisionState, candidates: JevActionCandidate[], options: { maxActions: number; signal?: AbortSignal }): Promise<JevActionSequenceDecision>;
	plan?(goal: string, roots: JevPlanningRoot[], options: { maxWaves: number; maxTasks: number; signal?: AbortSignal }): Promise<JevTaskPlanDecision>;
}

type GoalTaskStatus = "succeeded" | "failed" | "blocked" | "escalated" | "cancelled";

export interface GoalTaskTrace {
	id: string;
	objective: string;
	visualAgentId: string;
	status: GoalTaskStatus;
	startedAt: number;
	completedAt: number;
	durationMs: number;
	initialStateId?: string;
	initialObservationMs?: number;
	finalStateId?: string;
	resourceKey?: string;
	steps: GoalStepTrace[];
	error?: string;
	escalation?: { reason: string; confidence?: number; margin?: number };
}

export interface GoalStepTrace {
	step: number;
	stateId: string;
	candidateCount: number;
	choice: string;
	kind: JevActionCandidate["kind"];
	confidence: number;
	margin: number;
	model: string;
	jevLatencyMs: number;
	actLatencyMs?: number;
	requestCount: number;
	selectionDepth: number;
	usage: JevDecision["usage"];
	action?: Record<string, unknown>;
	outcome?: string;
	verification?: string;
	successorStateId?: string;
	microBatch?: {
		compiled: boolean;
		plannedCount: number;
		executedCount: number;
		choices: string[];
	};
	cursorOverlays?: {
		requested: number;
		presented: number;
		renderers: string[];
		maxVisualAckMs: number;
	};
}

function traceAction(action: UiAction | undefined): Record<string, unknown> | undefined {
	if (!action) return undefined;
	const { text, ...safe } = action;
	return text === undefined ? safe : { ...safe, text: "<redacted>", textLength: text.length };
}

function executionCursorEvidence(execution: any): Array<Record<string, unknown>> {
	const direct = execution?.evidence;
	if (Array.isArray(direct?.cursorVisuals)) return direct.cursorVisuals.filter((item: unknown) => item && typeof item === "object");
	if (Array.isArray(execution?.steps)) return execution.steps.flatMap((step: unknown) => executionCursorEvidence(step));
	return direct && typeof direct === "object" && "overlayRequested" in direct ? [direct] : [];
}

function actionSummary(candidate: JevActionCandidate, outcome?: string): string {
	const description = candidate.description && typeof candidate.description === "object" && !Array.isArray(candidate.description)
		? candidate.description as Record<string, any>
		: {};
	const operation = typeof description.operation === "string" ? description.operation : candidate.kind;
	const target = description.target && typeof description.target === "object"
		? description.target as Record<string, unknown>
		: {};
	const label = typeof target.label === "string" && target.label ? ` ${JSON.stringify(target.label)}` : "";
	const payload = description.payload && typeof description.payload === "object" && typeof (description.payload as Record<string, unknown>).name === "string"
		? ` using payload ${JSON.stringify((description.payload as Record<string, unknown>).name)}`
		: "";
	return `${operation}${label}${payload}${outcome ? ` -> ${outcome}` : ""}`;
}

export interface GoalExecutionTrace {
	tool: "execute_goal";
	runId: string;
	goal: string;
	status: "succeeded" | "partial" | "failed" | "escalated" | "cancelled";
	startedAt: number;
	completedAt: number;
	durationMs: number;
	peakConcurrency: number;
	tasks: GoalTaskTrace[];
	planning?: GoalPlanningTrace;
}

export interface GoalPlanningTrace {
	mode: "automatic";
	status: "ready" | "escalated";
	candidateCount: number;
	selected: Array<{
		taskId: string;
		root: string;
		app: string;
		title: string;
		role: string;
		wave: number;
		confidence: number;
		margin: number;
	}>;
	excluded: Array<{ rootId: string; app: string; title: string; confidence: number }>;
	omittedDueToLimit: string[];
	model: string;
	latencyMs: number;
	usage: { inputTokens: number; outputTokens: number };
	reason?: string;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(Number(value)))) : fallback;
}

function boundedProbability(value: unknown, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : fallback;
}

function normalizedName(value: unknown): string {
	return typeof value === "string" ? value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim() : "";
}

function taskIdPart(value: string): string {
	return value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 28) || "root";
}

function automaticObjective(goal: string, role: string, app: string, title: string): string {
	const target = `${app} window ${JSON.stringify(title)}`;
	const ownership = `Within the overall goal ${JSON.stringify(goal)}, complete only the requirement explicitly associated with ${target}. Mark this worker done as soon as that application-specific requirement is visibly satisfied; other workers own the other applications.`;
	if (role === "inspect") return `${ownership} Inspect and read the relevant evidence without changing application content.`;
	if (role === "transform") return `${ownership} Calculate, create, edit, or transform the required content in this application.`;
	if (role === "communicate") return `${ownership} Deliver only the result explicitly requested by the goal, and verify the recipient or destination before committing.`;
	return `${ownership} Verify or consolidate the relevant work produced by earlier execution waves.`;
}

interface AutomaticPlanResult {
	tasks: GoalTask[];
	trace: GoalPlanningTrace;
}

async function automaticGoalPlan(
	goal: string,
	params: ExecuteGoalParams,
	adapter: GoalExecutorAdapter,
	toolCallId: string,
	ctx: ExtensionContext,
	thresholds: { minConfidence: number; minMargin: number },
	signal?: AbortSignal,
): Promise<AutomaticPlanResult> {
	if (params.tasks?.length) throw new Error("execute_goal cannot combine explicit tasks with automatic planning.");
	const planning = params.planning!;
	const maxTasks = boundedInteger(planning.maxTasks, 6, 1, 16);
	const maxWaves = boundedInteger(planning.maxWaves, 3, 1, 4);
	const excludedApps = new Set((planning.excludeApps ?? []).map(normalizedName).filter(Boolean));
	let candidates: JevPlanningRoot[];
	if (planning.roots?.length) {
		if (planning.roots.length > 16) throw new Error("Automatic planning accepts at most 16 allowlisted roots.");
		const snapshots = await Promise.all(planning.roots.map(async (root, index) => {
			const exactRoot = String(root);
			const observation = await adapter.observe(`${toolCallId}_plan_root_${index}`, { root: exactRoot, mode: "semantic" }, signal, ctx);
			const stateId = stateIdFrom(observation);
			const app = String(observation.details?.target?.app ?? (observation.details?.root?.kind === "browser_page" ? "Browser" : "Unknown App"));
			if (!stateId || !outlineFrom(observation)) throw new Error(`Automatic planning root '${exactRoot}' could not produce a complete immutable observation.`);
			return {
				id: `r${index}`,
				root: exactRoot,
				stateId,
				app,
				title: String(observation.details?.target?.windowTitle ?? observation.details?.root?.title ?? "(untitled)"),
				kind: String(observation.details?.root?.kind ?? "window"),
				...(typeof observation.details?.root?.url === "string" ? { url: observation.details.root.url } : {}),
			} satisfies JevPlanningRoot;
		}));
		candidates = snapshots.filter((candidate) => !excludedApps.has(normalizedName(candidate.app)));
	} else {
		if (!adapter.findRoots) throw new Error("Automatic goal planning is unavailable because this runtime cannot discover roots.");
		const found = await adapter.findRoots(`${toolCallId}_plan_roots`, {}, signal, ctx);
		const windows = Array.isArray(found.details?.windows) ? found.details.windows as Array<Record<string, unknown>> : [];
		candidates = windows
			.filter((window) => {
				const root = String(window.windowRef ?? "");
				const app = String(window.app ?? "Unknown App");
				return root && !excludedApps.has(normalizedName(app)) && window.browserUseAllowed !== false;
			})
			.slice(0, 16)
			.map((window, index) => ({
				id: `r${index}`,
				root: String(window.windowRef),
				app: String(window.app ?? "Unknown App"),
				title: String(window.windowTitle ?? "(untitled)"),
				kind: String(window.kind ?? "window"),
				...(typeof window.url === "string" ? { url: window.url } : {}),
			}));
	}
	if (!candidates.length) throw new Error("Automatic goal planning found no eligible roots after applying its allowlist and exclusions.");
	const decision = adapter.plan
		? await adapter.plan(goal, candidates, { maxWaves, maxTasks, signal })
		: await planGoalTaskGraph(goal, candidates, { maxWaves, maxTasks, signal });
	const ranked = [...decision.selected].sort((a, b) => b.confidence - a.confidence || b.margin - a.margin || a.wave - b.wave || a.id.localeCompare(b.id));
	const retained = ranked.slice(0, maxTasks);
	const omittedDueToLimit = ranked.slice(maxTasks).map((root) => root.root);
	const unsafe = retained.filter((root) => root.confidence < thresholds.minConfidence || root.margin < thresholds.minMargin);
	const waves = [...new Set(retained.map((root) => root.wave))].sort((a, b) => a - b);
	const normalizedWave = new Map(waves.map((wave, index) => [wave, index]));
	const ids = new Map(retained.map((root, index) => [root.id, `auto-${index}-${taskIdPart(root.app)}`]));
	const tasks = retained.map((root) => {
		const wave = normalizedWave.get(root.wave) ?? 0;
		const previous = wave === 0 ? [] : retained.filter((candidate) => normalizedWave.get(candidate.wave) === wave - 1).map((candidate) => ids.get(candidate.id)!);
		return {
			id: ids.get(root.id)!,
			objective: automaticObjective(goal, root.role, root.app, root.title),
			...(root.stateId ? { stateId: root.stateId } : { root: root.root }),
			dependsOn: previous,
			textValues: params.textValues,
			context: {
				automaticPlan: true,
				assignedApplication: root.app,
				assignedWindow: root.title,
				role: root.role,
				wave,
				plannerConfidence: root.confidence,
				plannerMargin: root.margin,
			},
		} satisfies GoalTask;
	});
	const selected = retained.map((root) => ({
		taskId: ids.get(root.id)!,
		root: root.root,
		app: root.app,
		title: root.title,
		role: root.role,
		wave: normalizedWave.get(root.wave) ?? 0,
		confidence: root.confidence,
		margin: root.margin,
	}));
	const reason = !retained.length
		? "Jev found no current root which could materially advance the goal."
		: unsafe.length
			? `Automatic plan contained ${unsafe.length} selected root${unsafe.length === 1 ? "" : "s"} below the configured confidence gates.`
			: undefined;
	return {
		tasks: reason ? [] : tasks,
		trace: {
			mode: "automatic",
			status: reason ? "escalated" : "ready",
			candidateCount: candidates.length,
			selected,
			excluded: decision.excluded.map((root) => ({ rootId: root.id, app: root.app, title: root.title, confidence: root.confidence })),
			omittedDueToLimit,
			model: decision.model,
			latencyMs: decision.latencyMs,
			usage: decision.usage,
			...(reason ? { reason } : {}),
		},
	};
}

function stateIdFrom(result: ToolResult): string | undefined {
	const details = result.details;
	const value = details?.capture?.stateId ?? details?.stateId;
	return nonEmpty(value);
}

function outlineFrom(result: ToolResult): SerializedOutline | undefined {
	const outline = result.details?.outline;
	return outline && typeof outline === "object" && typeof outline.lookId === "string" && outline.root ? outline as SerializedOutline : undefined;
}

function safeLabel(node: OutlineNode): string {
	const raw = node.title || node.description || node.placeholder || node.roleDescription || node.identifier
		|| (!node.isTextInput ? outlineNodeLabel(node) : "");
	return raw.replace(/\s+/g, " ").trim().slice(0, 180);
}

function safePath(node: OutlineNode): string {
	const parts: string[] = [];
	let current: OutlineNode | undefined = node;
	while (current) {
		const label = safeLabel(current);
		parts.unshift(`${current.role || "unknown"}${label ? ` ${JSON.stringify(label)}` : ""}`);
		current = current.parent;
	}
	return parts.slice(-5).join(" > ").slice(0, 600);
}

function candidateDescription(node: OutlineNode, operation: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		operation,
		target: {
			role: node.role || "unknown",
			label: safeLabel(node) || undefined,
			identifier: node.identifier || undefined,
			path: safePath(node),
			offscreen: node.offscreen || undefined,
		},
		...extra,
	};
}

const MICRO_BATCH_RISK_LABEL = /\b(?:accept|allow|apply|authorize|book|buy|checkout|close|confirm|decline|delete|deny|install|log\s*out|order|pay|post|publish|purchase|quit|remove|save|send|share|sign\s*out|submit|transfer|uninstall)\b/i;
const MICRO_BATCH_WORD_LABELS = new Set([
	"add", "all clear", "backspace", "clear", "decimal", "divide", "equals", "minus", "multiply", "percent", "plus", "subtract",
]);

function compactStableControl(node: OutlineNode): boolean {
	if (!node.canPress || node.offscreen || node.children.length > 0) return false;
	if (!normalizedRole(node.role).includes("button")) return false;
	const label = safeLabel(node).normalize("NFKC").replace(/\s+/g, " ").trim();
	if (!label || MICRO_BATCH_RISK_LABEL.test(label)) return false;
	const normalizedLabel = label.toLowerCase();
	return /^[\p{N}\p{S}\p{P}\s]{1,6}$/u.test(label)
		|| /^(?:ac|c|ce)$/i.test(label)
		|| MICRO_BATCH_WORD_LABELS.has(normalizedLabel);
}

/** Stable control banks are compact leaf-button groups such as keypads and
 * calculators. We intentionally exclude ordinary navigation/action buttons:
 * stale retained controls must never become a compiled click-through path. */
function microBatchStable(node: OutlineNode): boolean {
	if (!compactStableControl(node)) return false;
	let ancestor = node.parent;
	for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parent) {
		if (descendants(ancestor).filter(compactStableControl).length >= 4) return true;
	}
	return false;
}

export function buildGoalCandidates(outline: Outline, task: GoalTask): JevActionCandidate[] {
	const candidates: JevActionCandidate[] = [];
	let actionIndex = 0;
	const add = (action: UiAction, description: Record<string, unknown>) => {
		candidates.push({ id: `a${actionIndex++}`, kind: "action", action, description: description as JevActionCandidate["description"] });
	};
	for (const node of outline.nodes) {
		if (!node.ref) continue;
		if (node.canPress) {
			const candidate: JevActionCandidate = { id: `a${actionIndex++}`, kind: "action", action: { action: "press", ref: node.ref }, description: candidateDescription(node, "press") as JevActionCandidate["description"], microBatchStable: microBatchStable(node) };
			candidates.push(candidate);
		}
		else if (node.canFocus && node.rect) add({ action: "click", ref: node.ref }, candidateDescription(node, "click_to_focus"));
		if (node.actions.some((action) => action.toLowerCase().includes("select"))) {
			add({ action: "select", ref: node.ref }, candidateDescription(node, "select"));
		}
		if (node.canSetValue || node.isTextInput) {
			for (const [name, text] of Object.entries(task.textValues ?? {})) {
				add({ action: "setText", ref: node.ref, text }, candidateDescription(node, "set_text", { payload: { name, characters: text.length } }));
			}
		}
		if (node.canScroll) {
			add({ action: "scroll", ref: node.ref, scrollY: 620 }, candidateDescription(node, "scroll_down"));
			add({ action: "scroll", ref: node.ref, scrollY: -620 }, candidateDescription(node, "scroll_up"));
		}
	}
	const focused = outline.nodes.find((node) => node.focused);
	if (focused) {
		for (const [name, text] of Object.entries(task.textValues ?? {})) {
			add({ action: "typeText", ref: focused.ref, text }, candidateDescription(focused, "type_text", { payload: { name, characters: text.length } }));
		}
		for (const keys of [["ENTER"], ["TAB"], ["ESC"]]) {
			add({ action: "keypress", ref: focused.ref, keys }, candidateDescription(focused, "keypress", { keys }));
		}
	}
	if (!task.completion) {
		candidates.push({ id: "done", kind: "done", description: { operation: "done", meaning: "This worker's application-specific objective is visibly satisfied in the current UI state. Other parallel workers own their application-specific portions, so they do not need to be complete. Do not choose merely because progress was made." } });
	}
	candidates.push(
		{ id: "wait", kind: "wait", action: { action: "wait", ms: 250 }, description: { operation: "wait", meaning: "The UI is visibly loading or a short delay is the correct next step." } },
		{ id: "escalate", kind: "escalate", description: { operation: "escalate", meaning: task.completion ? "No listed action-target pair is safe, and the deterministic completion condition is still false." : "This worker's application-specific objective is not yet satisfied, but no listed action-target pair is safe or sufficient; request higher-level reasoning without causing a side effect." } },
	);
	return candidates;
}

function normalized(value: unknown): string {
	return typeof value === "string" ? value.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase().replace(/\s+/g, " ").trim() : "";
}

function normalizedRole(value: unknown): string {
	const role = normalized(value).replace(/^ax/, "").replace(/[ _-]+/g, "");
	if (["textbox", "textfield", "textarea", "textview", "searchfield", "editabletext", "securetextfield"].includes(role)) return "textbox";
	if (["radio", "radiobutton"].includes(role)) return "radio";
	if (["check", "checkbox"].includes(role)) return "checkbox";
	if (["menuitem", "menuitemradio", "menuitemcheckbox"].includes(role)) return "menuitem";
	return role;
}

function descendants(node: OutlineNode): OutlineNode[] {
	const output: OutlineNode[] = [];
	const stack = [node];
	while (stack.length) {
		const current = stack.pop()!;
		output.push(current);
		stack.push(...current.children);
	}
	return output;
}

export function goalConditionSatisfied(outline: Outline, condition: UiCondition): boolean {
	const scope = condition.scopeRef ? outline.nodes.find((node) => node.ref === condition.scopeRef || node.wireRef === condition.scopeRef) : outline.root;
	const nodes = scope ? descendants(scope) : [];
	const matches = nodes.some((node) => {
		if (condition.ref !== undefined && node.ref !== condition.ref && node.wireRef !== condition.ref) return false;
		if (condition.role !== undefined && normalizedRole(node.role) !== normalizedRole(condition.role)) return false;
		if (condition.value !== undefined && normalized(node.value) !== normalized(condition.value)) return false;
		if (condition.text !== undefined) {
			const haystack = normalized([safeLabel(node), node.value, ...node.text.map((item) => item.string)].join(" "));
			if (!haystack.includes(normalized(condition.text))) return false;
		}
		return true;
	});
	return condition.until === "absent" ? !matches : matches;
}

function validateTasks(rawTasks: GoalTask[] | undefined): GoalTask[] {
	const tasks = rawTasks?.length ? rawTasks : [{ id: "main" }];
	if (tasks.length > 32) throw new Error("execute_goal supports at most 32 tasks.");
	const ids = new Set<string>();
	for (const task of tasks) {
		if (!nonEmpty(task.id) || ids.has(task.id)) throw new Error(`execute_goal task IDs must be unique and non-empty; received '${task.id}'.`);
		ids.add(task.id);
		const inputs = [task.root, task.stateId, task.stateFrom].filter((value) => nonEmpty(value)).length;
		if (inputs > 1) throw new Error(`Task '${task.id}' may specify only one of root, stateId, or stateFrom.`);
	}
	for (const task of tasks) {
		const dependencies = new Set(task.dependsOn ?? []);
		if (task.stateFrom) dependencies.add(task.stateFrom);
		for (const dependency of dependencies) {
			if (!ids.has(dependency)) throw new Error(`Task '${task.id}' depends on unknown task '${dependency}'.`);
			if (dependency === task.id) throw new Error(`Task '${task.id}' cannot depend on itself.`);
		}
		task.dependsOn = [...dependencies];
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const visit = (id: string) => {
		if (visiting.has(id)) throw new Error("execute_goal contains a dependency cycle.");
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of ids) visit(id);
	return tasks;
}

function taskDependencyContext(task: GoalTask, results: Map<string, GoalTaskTrace>): Array<Record<string, unknown>> {
	return (task.dependsOn ?? []).map((id) => {
		const result = results.get(id)!;
		return {
			id,
			status: result.status,
			finalStateId: result.finalStateId,
			lastChoice: result.steps.at(-1)?.choice,
			lastOutcome: result.steps.at(-1)?.outcome,
		};
	});
}

function semanticFacts(outline: Outline): Array<Record<string, unknown>> {
	const facts: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	for (const node of outline.nodes) {
		const secure = node.role.toLowerCase().includes("secure") || node.subrole.toLowerCase().includes("secure");
		const label = safeLabel(node);
		const text = node.text.map((item) => item.string.trim()).filter(Boolean);
		const value = node.value.trim();
		if (!label && !text.length && !value && !node.focused) continue;
		const fact: Record<string, unknown> = {
			ref: node.ref,
			role: node.role || "unknown",
			label: label || undefined,
			text: text.length ? text : undefined,
			focused: node.focused || undefined,
		};
		if (node.isTextInput || secure) {
			fact.input = { empty: value.length === 0, characters: value.length, secure: secure || undefined };
		} else if (value && value !== label) {
			fact.value = value;
		}
		const key = JSON.stringify(fact);
		if (!seen.has(key)) {
			seen.add(key);
			facts.push(fact);
		}
	}
	return facts;
}

function uiState(result: ToolResult, outline: Outline, candidateCount: number): Record<string, unknown> {
	return {
		application: result.details?.target?.app,
		windowTitle: result.details?.target?.windowTitle,
		pageTitle: result.details?.root?.title,
		url: result.details?.root?.url,
		resourceKey: result.details?.resource?.key,
		candidateCount,
		nodeCount: outline.nodes.length,
		focusedElement: safeLabel(outline.nodes.find((node) => node.focused) ?? outline.root) || undefined,
		semanticFacts: semanticFacts(outline),
	};
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("The operation was aborted.", "AbortError"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new DOMException("The operation was aborted.", "AbortError"));
		}, { once: true });
	});
}

function cancelled(signal?: AbortSignal): boolean {
	return signal?.aborted === true;
}

async function runGoalTask(
	runId: string,
	goal: string,
	task: GoalTask,
	results: Map<string, GoalTaskTrace>,
	adapter: GoalExecutorAdapter,
	toolCallId: string,
	ctx: ExtensionContext,
	thresholds: { minConfidence: number; minMargin: number },
	signal?: AbortSignal,
): Promise<GoalTaskTrace> {
	const startedAt = Date.now();
	const objective = nonEmpty(task.objective) ?? goal;
	const visualAgentId = `goal-${runId.slice(0, 8)}-${task.id}`;
	const base: Omit<GoalTaskTrace, "status" | "completedAt" | "durationMs"> = { id: task.id, objective, visualAgentId, startedAt, steps: [] };
	try {
		if (cancelled(signal)) throw new DOMException("The operation was aborted.", "AbortError");
		const inheritedStateId = task.stateFrom ? results.get(task.stateFrom)?.finalStateId : undefined;
		if (task.stateFrom && !inheritedStateId) throw new Error(`Task '${task.id}' could not inherit a final state from '${task.stateFrom}'.`);
		const initialParams = inheritedStateId || task.stateId
			? { stateId: inheritedStateId ?? task.stateId, mode: "semantic" }
			: task.root ? { root: task.root, mode: "semantic" } : { mode: "semantic" };
		const observationStartedAt = performance.now();
		let observation = await adapter.observe(`${toolCallId}_${task.id}_observe`, initialParams, signal, ctx);
		base.initialObservationMs = Math.round((performance.now() - observationStartedAt) * 10) / 10;
		let stateId = stateIdFrom(observation);
		let serialized = outlineFrom(observation);
		if (!stateId || !serialized) throw new Error(`Task '${task.id}' did not receive a complete immutable observation.`);
		base.initialStateId = stateId;
		base.resourceKey = observation.details?.resource?.key;
		const maxSteps = boundedInteger(task.maxSteps, 12, 1, 30);
		const recentActions: Array<Record<string, unknown>> = [];
		for (let step = 0; step < maxSteps; step += 1) {
			if (cancelled(signal)) throw new DOMException("The operation was aborted.", "AbortError");
			const outline = restoreOutline(serialized);
			if (task.completion && goalConditionSatisfied(outline, task.completion)) {
				const completedAt = Date.now();
				return { ...base, status: "succeeded", finalStateId: stateId, completedAt, durationMs: completedAt - startedAt };
			}
			const candidates = buildGoalCandidates(outline, task);
			const policyState: JevDecisionState = {
				goal,
				taskId: task.id,
				objective,
				step,
				ui: { ...uiState(observation, outline, candidates.length), ...(task.context ? { taskContext: task.context } : {}) },
				dependencies: taskDependencyContext(task, results),
				recentActions: recentActions.slice(-6),
			};
			const maxBatchActions = boundedInteger(task.maxBatchActions, 6, 1, 8);
			let sequence: JevActionSequenceDecision;
			if (adapter.decideSequence) {
				sequence = await adapter.decideSequence(policyState, candidates, { maxActions: maxBatchActions, signal });
			} else if (adapter.decide) {
				const decision = await adapter.decide(policyState, candidates, signal);
				sequence = {
					decisions: [{ candidate: decision.candidate, confidence: decision.confidence, margin: decision.margin, probabilities: decision.probabilities }],
					model: decision.model,
					usage: decision.usage,
					latencyMs: decision.latencyMs,
					requestCount: decision.requestCount,
					selectionDepth: decision.selectionDepth,
					compiledSequence: false,
				};
			} else {
				sequence = await selectGoalActionSequence(policyState, candidates, { maxActions: maxBatchActions, signal });
			}
			const decision = sequence.decisions[0];
			if (!decision) throw new Error("Jev returned an empty action sequence.");
			const stepTrace: GoalStepTrace = {
				step,
				stateId,
				candidateCount: candidates.length,
				choice: decision.candidate.id,
				kind: decision.candidate.kind,
				confidence: decision.confidence,
				margin: decision.margin,
				model: sequence.model,
				jevLatencyMs: sequence.latencyMs,
				requestCount: sequence.requestCount,
				selectionDepth: sequence.selectionDepth,
				usage: sequence.usage,
				action: traceAction(decision.candidate.action),
			};
			base.steps.push(stepTrace);
			if (decision.confidence < thresholds.minConfidence || decision.margin < thresholds.minMargin) {
				const completedAt = Date.now();
				return {
					...base,
					status: "escalated",
					finalStateId: stateId,
					completedAt,
					durationMs: completedAt - startedAt,
					escalation: { reason: "Jev decision did not meet the configured confidence and margin gates.", confidence: decision.confidence, margin: decision.margin },
				};
			}
			if (decision.candidate.kind === "done") {
				const completedAt = Date.now();
				return { ...base, status: "succeeded", finalStateId: stateId, completedAt, durationMs: completedAt - startedAt };
			}
			if (decision.candidate.kind === "escalate" || !decision.candidate.action) {
				const completedAt = Date.now();
				return { ...base, status: "escalated", finalStateId: stateId, completedAt, durationMs: completedAt - startedAt, escalation: { reason: "Jev explicitly requested higher-level reasoning.", confidence: decision.confidence, margin: decision.margin } };
			}
			const executable = [] as typeof sequence.decisions;
			for (const selected of sequence.decisions) {
				if (selected.confidence < thresholds.minConfidence || selected.margin < thresholds.minMargin || !selected.candidate.action) break;
				executable.push(selected);
			}
			if (!executable.length) throw new Error("Jev sequence passed its first gate but contained no executable action.");
			stepTrace.microBatch = {
				compiled: sequence.compiledSequence,
				plannedCount: sequence.decisions.length,
				executedCount: 0,
				choices: executable.map((selected) => selected.candidate.id),
			};
			const actionStartedAt = performance.now();
			const actionResult = await runAsVisualAgent(visualAgentId, async () => await adapter.act(
				`${toolCallId}_${task.id}_${step}`,
				{ stateId, actions: executable.map((selected) => selected.candidate.action), stableControlBatch: sequence.compiledSequence && executable.length > 1 },
				signal,
				ctx,
			));
			stepTrace.actLatencyMs = Math.round((performance.now() - actionStartedAt) * 10) / 10;
			const execution = actionResult.details?.execution;
			stepTrace.outcome = execution?.outcome;
			stepTrace.verification = execution?.verification?.status;
			const cursorEvidence = executionCursorEvidence(execution);
			if (cursorEvidence.length) {
				stepTrace.cursorOverlays = {
					requested: cursorEvidence.filter((evidence) => evidence.overlayRequested === true).length,
					presented: cursorEvidence.filter((evidence) => evidence.overlayPresented === true).length,
					renderers: [...new Set(cursorEvidence.map((evidence) => typeof evidence.overlayRenderer === "string" ? evidence.overlayRenderer : "unknown"))],
					maxVisualAckMs: Math.max(0, ...cursorEvidence.map((evidence) => typeof evidence.visualAckMs === "number" ? evidence.visualAckMs : 0)),
				};
			}
			const executedCount = Math.max(0, Math.min(executable.length, Number(execution?.actionCount ?? execution?.steps?.length ?? executable.length)));
			stepTrace.microBatch.executedCount = executedCount;
			const successorStateId = stateIdFrom(actionResult);
			stepTrace.successorStateId = successorStateId;
			for (let index = 0; index < executedCount; index += 1) {
				const selected = executable[index];
				const actionExecution = execution?.steps?.[index] ?? execution;
				recentActions.push({
					choice: selected.candidate.id,
					kind: selected.candidate.kind,
					summary: actionSummary(selected.candidate, actionExecution?.outcome),
					description: selected.candidate.description,
					outcome: actionExecution?.outcome,
					verification: actionExecution?.verification?.status,
				});
			}
			if (execution?.outcome === "didnt" || execution?.verification?.status === "failed") {
				// The successor still carries useful evidence. Let Jev choose a different
				// action on the next step instead of blindly retrying this one.
			}
			stateId = successorStateId ?? stateId;
			serialized = outlineFrom(actionResult);
			observation = actionResult;
			if (!serialized) {
				observation = await adapter.observe(`${toolCallId}_${task.id}_${step}_refresh`, { stateId, mode: "semantic" }, signal, ctx);
				stateId = stateIdFrom(observation) ?? stateId;
				serialized = outlineFrom(observation);
				if (!serialized) throw new Error(`Task '${task.id}' could not refresh its successor state.`);
			}
			if (execution?.outcome === "worked" && serialized) {
				for (const settleMs of [100, 200, 400, 800]) {
					const successorOutline = restoreOutline(serialized);
					const hasActionableTarget = buildGoalCandidates(successorOutline, task).some((candidate) => candidate.kind === "action");
					if (hasActionableTarget || task.completion && goalConditionSatisfied(successorOutline, task.completion)) break;
					await delay(settleMs, signal);
					observation = await adapter.observe(`${toolCallId}_${task.id}_${step}_settle_${settleMs}`, { stateId, mode: "semantic" }, signal, ctx);
					stateId = stateIdFrom(observation) ?? stateId;
					serialized = outlineFrom(observation) ?? serialized;
				}
			}
		}
		const completedAt = Date.now();
		return { ...base, status: "escalated", finalStateId: stateId, completedAt, durationMs: completedAt - startedAt, escalation: { reason: `Task reached its ${maxSteps}-step budget.` } };
	} catch (error) {
		const completedAt = Date.now();
		return {
			...base,
			status: cancelled(signal) || error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed",
			completedAt,
			durationMs: completedAt - startedAt,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function blockedTrace(runId: string, goal: string, task: GoalTask, reason: string): GoalTaskTrace {
	const now = Date.now();
	return {
		id: task.id,
		objective: nonEmpty(task.objective) ?? goal,
		visualAgentId: `goal-${runId.slice(0, 8)}-${task.id}`,
		status: "blocked",
		startedAt: now,
		completedAt: now,
		durationMs: 0,
		steps: [],
		error: reason,
	};
}

export function createGoalExecutor(adapter: GoalExecutorAdapter) {
	return async function executeGoal(
		toolCallId: string,
		params: ExecuteGoalParams,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult> {
		const goal = nonEmpty(params?.goal);
		if (!goal) throw new Error("execute_goal.goal must be non-empty.");
		const thresholds = {
			minConfidence: boundedProbability(params.minConfidence, 0.4),
			minMargin: boundedProbability(params.minMargin, 0),
		};
		const runId = randomUUID();
		const startedAt = Date.now();
		let planningTrace: GoalPlanningTrace | undefined;
		let rawTasks = params.tasks;
		if (params.planning?.mode === "automatic") {
			const planned = await automaticGoalPlan(goal, params, adapter, toolCallId, ctx, thresholds, signal);
			planningTrace = planned.trace;
			if (planningTrace.status === "escalated") {
				const completedAt = Date.now();
				const trace: GoalExecutionTrace = {
					tool: "execute_goal",
					runId,
					goal,
					status: "escalated",
					startedAt,
					completedAt,
					durationMs: completedAt - startedAt,
					peakConcurrency: 0,
					tasks: [],
					planning: planningTrace,
				};
				return {
					content: [{ type: "text", text: `Goal escalated during automatic planning in ${trace.durationMs}ms: ${planningTrace.reason}` }],
					details: trace,
				};
			}
			rawTasks = planned.tasks;
		}
		const tasks = validateTasks(rawTasks);
		const maxConcurrency = boundedInteger(params.maxConcurrency, Math.min(8, tasks.length), 1, 16);
		const pending = new Map(tasks.map((task) => [task.id, task]));
		const results = new Map<string, GoalTaskTrace>();
		const active = new Map<string, Promise<GoalTaskTrace>>();
		let peakConcurrency = 0;

		while (pending.size || active.size) {
			let progressed = false;
			for (const [id, task] of [...pending]) {
				if (active.size >= maxConcurrency) break;
				const dependencies = task.dependsOn ?? [];
				if (!dependencies.every((dependency) => results.has(dependency))) continue;
				const failedDependency = dependencies.find((dependency) => results.get(dependency)?.status !== "succeeded");
				pending.delete(id);
				progressed = true;
				if (failedDependency) {
					results.set(id, blockedTrace(runId, goal, task, `Dependency '${failedDependency}' did not succeed.`));
					continue;
				}
				active.set(id, runGoalTask(runId, goal, task, results, adapter, toolCallId, ctx, thresholds, signal));
				peakConcurrency = Math.max(peakConcurrency, active.size);
			}
			if (!active.size) {
				if (pending.size && !progressed) throw new Error("execute_goal scheduler could not make progress.");
				continue;
			}
			const completed = await Promise.race([...active].map(async ([id, promise]) => ({ id, result: await promise })));
			active.delete(completed.id);
			results.set(completed.id, completed.result);
		}

		const completedAt = Date.now();
		const ordered = tasks.map((task) => results.get(task.id)!);
		const succeeded = ordered.filter((task) => task.status === "succeeded").length;
		const cancelledCount = ordered.filter((task) => task.status === "cancelled").length;
		const escalated = ordered.filter((task) => task.status === "escalated").length;
		const failed = ordered.filter((task) => task.status === "failed" || task.status === "blocked").length;
		const status: GoalExecutionTrace["status"] = cancelledCount
			? "cancelled"
			: succeeded === ordered.length
				? "succeeded"
				: succeeded
					? "partial"
					: escalated && !failed ? "escalated" : "failed";
		const trace: GoalExecutionTrace = {
			tool: "execute_goal",
			runId,
			goal,
			status,
			startedAt,
			completedAt,
			durationMs: completedAt - startedAt,
			peakConcurrency,
			tasks: ordered,
			...(planningTrace ? { planning: planningTrace } : {}),
		};
		return {
			content: [{ type: "text", text: `Goal ${status} in ${trace.durationMs}ms: ${succeeded}/${ordered.length} tasks succeeded, ${escalated} escalated, ${failed} failed or blocked; peak concurrency ${peakConcurrency}.` }],
			details: trace,
		};
	};
}
