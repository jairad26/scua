import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecuteGoalParams, GoalTask, UiAction, UiCondition } from "./contract.ts";
import { runAsVisualAgent } from "./control-plane.ts";
import { outlineNodeLabel, restoreOutline, type Outline, type OutlineNode, type SerializedOutline } from "./outline.ts";
import { selectGoalAction, type JevActionCandidate, type JevDecision, type JevDecisionState } from "./jev-policy.ts";

interface ToolResult {
	content: Array<{ type: string; [key: string]: unknown }>;
	details?: Record<string, any>;
}

export interface GoalExecutorAdapter {
	observe(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult>;
	act(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult>;
	decide?(state: JevDecisionState, candidates: JevActionCandidate[], signal?: AbortSignal): Promise<JevDecision>;
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
	requestCount: number;
	selectionDepth: number;
	usage: JevDecision["usage"];
	action?: Record<string, unknown>;
	outcome?: string;
	verification?: string;
	successorStateId?: string;
}

function traceAction(action: UiAction | undefined): Record<string, unknown> | undefined {
	if (!action) return undefined;
	const { text, ...safe } = action;
	return text === undefined ? safe : { ...safe, text: "<redacted>", textLength: text.length };
}

export interface GoalExecutionTrace {
	tool: "execute_goal";
	runId: string;
	goal: string;
	status: "succeeded" | "partial" | "failed" | "cancelled";
	startedAt: number;
	completedAt: number;
	durationMs: number;
	peakConcurrency: number;
	tasks: GoalTaskTrace[];
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

export function buildGoalCandidates(outline: Outline, task: GoalTask): JevActionCandidate[] {
	const candidates: JevActionCandidate[] = [];
	let actionIndex = 0;
	const add = (action: UiAction, description: Record<string, unknown>) => {
		candidates.push({ id: `a${actionIndex++}`, kind: "action", action, description: description as JevActionCandidate["description"] });
	};
	for (const node of outline.nodes) {
		if (!node.ref) continue;
		if (node.canPress) add({ action: "press", ref: node.ref }, candidateDescription(node, "press"));
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
	candidates.push(
		{ id: "done", kind: "done", description: { operation: "done", meaning: "The task objective is already satisfied in the current UI state. Do not choose merely because progress was made." } },
		{ id: "wait", kind: "wait", action: { action: "wait", ms: 250 }, description: { operation: "wait", meaning: "The UI is visibly loading or a short delay is the correct next step." } },
		{ id: "escalate", kind: "escalate", description: { operation: "escalate", meaning: "No listed action-target pair is safe or sufficient; request higher-level reasoning without causing a side effect." } },
	);
	return candidates;
}

function normalized(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase().replace(/\s+/g, " ").trim() : "";
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
		if (condition.role !== undefined && normalized(node.role) !== normalized(condition.role)) return false;
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
	};
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
		let observation = await adapter.observe(`${toolCallId}_${task.id}_observe`, initialParams, signal, ctx);
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
			const decision = adapter.decide
				? await adapter.decide(policyState, candidates, signal)
				: await selectGoalAction(policyState, candidates, { signal });
			const stepTrace: GoalStepTrace = {
				step,
				stateId,
				candidateCount: candidates.length,
				choice: decision.candidate.id,
				kind: decision.candidate.kind,
				confidence: decision.confidence,
				margin: decision.margin,
				model: decision.model,
				jevLatencyMs: decision.latencyMs,
				requestCount: decision.requestCount,
				selectionDepth: decision.selectionDepth,
				usage: decision.usage,
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
			const actionResult = await runAsVisualAgent(visualAgentId, async () => await adapter.act(
				`${toolCallId}_${task.id}_${step}`,
				{ stateId, actions: [decision.candidate.action] },
				signal,
				ctx,
			));
			const execution = actionResult.details?.execution;
			stepTrace.outcome = execution?.outcome;
			stepTrace.verification = execution?.verification?.status;
			const successorStateId = stateIdFrom(actionResult);
			stepTrace.successorStateId = successorStateId;
			recentActions.push({ choice: stepTrace.choice, kind: stepTrace.kind, outcome: stepTrace.outcome, verification: stepTrace.verification });
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
		const tasks = validateTasks(params.tasks);
		const maxConcurrency = boundedInteger(params.maxConcurrency, Math.min(8, tasks.length), 1, 16);
		const thresholds = {
			minConfidence: boundedProbability(params.minConfidence, 0.6),
			minMargin: boundedProbability(params.minMargin, 0.12),
		};
		const runId = randomUUID();
		const startedAt = Date.now();
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
		const status: GoalExecutionTrace["status"] = cancelledCount ? "cancelled" : succeeded === ordered.length ? "succeeded" : succeeded ? "partial" : "failed";
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
		};
		const escalated = ordered.filter((task) => task.status === "escalated").length;
		const failed = ordered.filter((task) => task.status === "failed" || task.status === "blocked").length;
		return {
			content: [{ type: "text", text: `Goal ${status} in ${trace.durationMs}ms: ${succeeded}/${ordered.length} tasks succeeded, ${escalated} escalated, ${failed} failed or blocked; peak concurrency ${peakConcurrency}.` }],
			details: trace,
		};
	};
}
