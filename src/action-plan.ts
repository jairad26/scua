import { randomUUID } from "node:crypto";
import type { ActionPlanNode, ExecutePlanParams } from "./contract.ts";

export type PlanNodeStatus = "pending" | "running" | "succeeded" | "failed" | "blocked";

export interface PlanErrorClassification {
	code: string;
	message: string;
	retryable: boolean;
	delivery: "definitely_not_delivered" | "may_have_been_delivered" | "completed";
	recovery: "reobserve" | "reacquire" | "unsupported" | "abort";
	resourceKey?: string;
	expectedEpoch?: number;
	actualEpoch?: number;
}

export interface PlanAttemptTrace {
	attempt: number;
	stateId: string;
	startedAt: number;
	completedAt: number;
	durationMs: number;
	status: "succeeded" | "failed" | "refreshed";
	error?: PlanErrorClassification;
}

export interface PlanNodeTrace<T> {
	id: string;
	status: PlanNodeStatus;
	dependsOn: string[];
	stateId?: string;
	successorStateId?: string;
	startedAt?: number;
	completedAt?: number;
	durationMs?: number;
	attempts: PlanAttemptTrace[];
	result?: T;
	error?: PlanErrorClassification;
	blockedBy?: string[];
}

export interface ActionPlanTrace<T> {
	planId: string;
	status: "succeeded" | "partially_failed" | "failed";
	startedAt: number;
	completedAt: number;
	durationMs: number;
	peakConcurrency: number;
	nodes: PlanNodeTrace<T>[];
}

export interface ActionPlanAdapter<T> {
	execute(node: ActionPlanNode, stateId: string, attempt: number, signal?: AbortSignal): Promise<T>;
	refresh(node: ActionPlanNode, stateId: string, error: PlanErrorClassification, signal?: AbortSignal): Promise<string>;
	successorStateId(result: T): string | undefined;
	classify(error: unknown): PlanErrorClassification;
	/** Optional scheduling seam for platform-specific user-priority policies.
	 * It runs outside resource leases, so waiting never blocks other branches. */
	beforeAttempt?(node: ActionPlanNode, attempt: number, signal?: AbortSignal): Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_BUDGET_MS = 2_500;
const MAX_PLAN_NODES = 64;

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(Number(value)))) : fallback;
}

function validatePlan(params: ExecutePlanParams): { planId: string; nodes: ActionPlanNode[]; maxConcurrency: number } {
	const nodes = Array.isArray(params.nodes) ? params.nodes : [];
	if (nodes.length === 0) throw new Error("execute_plan.nodes must contain at least one node.");
	if (nodes.length > MAX_PLAN_NODES) throw new Error(`execute_plan supports at most ${MAX_PLAN_NODES} nodes.`);
	const byId = new Map<string, ActionPlanNode>();
	for (const node of nodes) {
		if (!node || typeof node !== "object") throw new Error("Every action-plan node must be an object.");
		const id = typeof node.id === "string" ? node.id.trim() : "";
		if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error(`Invalid action-plan node id '${node.id ?? ""}'.`);
		if (byId.has(id)) throw new Error(`Duplicate action-plan node id '${id}'.`);
		if (!Array.isArray(node.actions) || node.actions.length === 0) throw new Error(`Action-plan node '${id}' has no actions.`);
		if (node.actions.length > 20) throw new Error(`Action-plan node '${id}' exceeds the 20-action transaction limit.`);
		if (!Array.isArray(node.guards) || node.guards.length === 0) throw new Error(`Action-plan node '${id}' requires at least one live commit guard.`);
		const hasState = typeof node.stateId === "string" && node.stateId.trim().length > 0;
		const hasSource = typeof node.stateFrom === "string" && node.stateFrom.trim().length > 0;
		if (hasState === hasSource) throw new Error(`Action-plan node '${id}' requires exactly one of stateId or stateFrom.`);
		byId.set(id, { ...node, id, dependsOn: [...new Set(node.dependsOn ?? [])] });
	}
	for (const node of byId.values()) {
		for (const dependency of node.dependsOn ?? []) {
			if (!byId.has(dependency)) throw new Error(`Action-plan node '${node.id}' depends on missing node '${dependency}'.`);
			if (dependency === node.id) throw new Error(`Action-plan node '${node.id}' cannot depend on itself.`);
		}
		if (node.stateFrom && !(node.dependsOn ?? []).includes(node.stateFrom)) {
			throw new Error(`Action-plan node '${node.id}' must include stateFrom '${node.stateFrom}' in dependsOn.`);
		}
	}

	const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
	const dependants = new Map([...byId.keys()].map((id) => [id, [] as string[]]));
	for (const node of byId.values()) {
		for (const dependency of node.dependsOn ?? []) {
			indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
			dependants.get(dependency)!.push(node.id);
		}
	}
	const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
	let visited = 0;
	while (ready.length) {
		const id = ready.shift()!;
		visited += 1;
		for (const dependant of dependants.get(id) ?? []) {
			const next = (indegree.get(dependant) ?? 1) - 1;
			indegree.set(dependant, next);
			if (next === 0) ready.push(dependant);
		}
	}
	if (visited !== byId.size) throw new Error("Action plan contains a dependency cycle.");

	return {
		planId: typeof params.planId === "string" && params.planId.trim() ? params.planId.trim() : `plan-${randomUUID()}`,
		nodes: [...byId.values()],
		maxConcurrency: boundedInteger(params.maxConcurrency, Math.min(16, nodes.length), 1, 32),
	};
}

function canRefresh(node: ActionPlanNode, error: PlanErrorClassification, attempt: number, startedAt: number): boolean {
	const maxAttempts = boundedInteger(node.retry?.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 3);
	const budgetMs = boundedInteger(node.retry?.budgetMs, DEFAULT_RETRY_BUDGET_MS, 0, 10_000);
	return (node.conflictPolicy ?? "refresh") === "refresh"
		&& attempt < maxAttempts
		&& Date.now() - startedAt < budgetMs
		&& error.retryable
		&& error.delivery === "definitely_not_delivered"
		&& error.recovery === "reobserve";
}

export async function executeAdaptiveActionPlan<T>(
	params: ExecutePlanParams,
	adapter: ActionPlanAdapter<T>,
	signal?: AbortSignal,
): Promise<ActionPlanTrace<T>> {
	const validated = validatePlan(params);
	const startedAt = Date.now();
	const nodesById = new Map(validated.nodes.map((node) => [node.id, node]));
	const traces = new Map<string, PlanNodeTrace<T>>(validated.nodes.map((node) => [node.id, {
		id: node.id,
		status: "pending",
		dependsOn: node.dependsOn ?? [],
		attempts: [],
	}]));
	const running = new Map<string, Promise<void>>();
	let active = 0;
	let peakConcurrency = 0;

	const runNode = async (node: ActionPlanNode, trace: PlanNodeTrace<T>): Promise<void> => {
		trace.status = "running";
		trace.startedAt = Date.now();
		active += 1;
		peakConcurrency = Math.max(peakConcurrency, active);
		let stateId = node.stateId?.trim();
		if (!stateId && node.stateFrom) stateId = traces.get(node.stateFrom)?.successorStateId;
		if (!stateId) {
			trace.status = "failed";
			trace.error = { code: "state_unavailable", message: `Node '${node.id}' could not resolve its input state.`, retryable: false, delivery: "definitely_not_delivered", recovery: "abort" };
			active -= 1;
			trace.completedAt = Date.now();
			trace.durationMs = trace.completedAt - trace.startedAt;
			return;
		}
		trace.stateId = stateId;
		const retryStartedAt = Date.now();
		let attempt = 0;
		try {
			for (;;) {
				attempt += 1;
				if (signal?.aborted) throw new Error("Action plan was aborted.");
				await adapter.beforeAttempt?.(node, attempt, signal);
				const attemptStartedAt = Date.now();
				try {
					const result = await adapter.execute(node, stateId, attempt, signal);
					const successorStateId = adapter.successorStateId(result);
					if (!successorStateId) throw new Error(`Node '${node.id}' completed without a successor state.`);
					const completedAt = Date.now();
					trace.attempts.push({ attempt, stateId, startedAt: attemptStartedAt, completedAt, durationMs: completedAt - attemptStartedAt, status: "succeeded" });
					trace.result = result;
					trace.successorStateId = successorStateId;
					trace.status = "succeeded";
					return;
				} catch (error) {
					const classified = adapter.classify(error);
					const completedAt = Date.now();
					const attemptTrace: PlanAttemptTrace = { attempt, stateId, startedAt: attemptStartedAt, completedAt, durationMs: completedAt - attemptStartedAt, status: "failed", error: classified };
					trace.attempts.push(attemptTrace);
					if (!canRefresh(node, classified, attempt, retryStartedAt)) {
						trace.status = "failed";
						trace.error = classified;
						return;
					}
					try {
						stateId = await adapter.refresh(node, stateId, classified, signal);
						trace.stateId = stateId;
						attemptTrace.status = "refreshed";
					} catch (refreshError) {
						trace.status = "failed";
						trace.error = adapter.classify(refreshError);
						return;
					}
				}
			}
		} finally {
			active -= 1;
			trace.completedAt = Date.now();
			trace.durationMs = trace.completedAt - trace.startedAt!;
		}
	};

	while ([...traces.values()].some((trace) => trace.status === "pending" || trace.status === "running")) {
		let progressed = false;
		for (const node of validated.nodes) {
			if (running.size >= validated.maxConcurrency) break;
			const trace = traces.get(node.id)!;
			if (trace.status !== "pending") continue;
			const dependencies = (node.dependsOn ?? []).map((id) => traces.get(id)!);
			if (dependencies.some((dependency) => dependency.status === "pending" || dependency.status === "running")) continue;
			const blockedBy = dependencies.filter((dependency) => dependency.status !== "succeeded").map((dependency) => dependency.id);
			if (blockedBy.length) {
				trace.status = "blocked";
				trace.blockedBy = blockedBy;
				trace.completedAt = Date.now();
				progressed = true;
				continue;
			}
			const task = runNode(nodesById.get(node.id)!, trace).finally(() => running.delete(node.id));
			running.set(node.id, task);
			progressed = true;
		}
		if (running.size) await Promise.race(running.values());
		else if (!progressed) throw new Error("Action-plan scheduler reached an invalid dependency state.");
	}
	await Promise.all(running.values());
	const completedAt = Date.now();
	const nodeTraces = validated.nodes.map((node) => traces.get(node.id)!);
	const succeeded = nodeTraces.filter((node) => node.status === "succeeded").length;
	return {
		planId: validated.planId,
		status: succeeded === nodeTraces.length ? "succeeded" : succeeded === 0 ? "failed" : "partially_failed",
		startedAt,
		completedAt,
		durationMs: completedAt - startedAt,
		peakConcurrency,
		nodes: nodeTraces,
	};
}
