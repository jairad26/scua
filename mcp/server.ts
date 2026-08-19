import { createInterface } from "node:readline";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	executeAct,
	executeExpandUi,
	executeFind,
	executeInspectUi,
	executeObserve,
	executeReadText,
	executeSearchUi,
	executeWaitFor,
	executeLaunchBrowser,
	executeNavigateBrowser,
	handoffManagedRoot,
	handoffSavedDesktopState,
	releaseManagedRootsForActor,
	shutdownComputerUseSession,
} from "../src/bridge.ts";
import { compactStructuredContent } from "./compact.ts";
import { mcpTools } from "./tool-catalog.ts";
import { currentActor, runAsActor, scuaControlPlane } from "../src/control-plane.ts";
import { scuaErrorEnvelope } from "./errors.ts";
import { executeAdaptiveActionPlan, type PlanErrorClassification } from "../src/action-plan.ts";
import type { ActionPlanNode, ExecutePlanParams } from "../src/contract.ts";

const serverName = "scua";
const serverVersion = "0.2.0";
const instructions = [
	"SCUA is a generic, state-scoped computer-use engine.",
	"Use find_roots, observe_ui, cached search/expand/inspect, then act_ui with refs from the same stateId.",
	"The same tool contract applies to every desktop window and browser-page root; never invent or request app-specific SCUA tools.",
	"Never silently substitute a different application or web version when the selected root cannot satisfy an action.",
	"SCUA execution mode is configurable: background mode preserves attention when possible and safely escalates when required; foreground mode presents every action.",
	"Independent physical resources may progress concurrently; stale writes are rejected by resource epoch.",
	"External orchestrators can multiplex coordinator-issued logical actors through MCP request metadata scuaActorToken and use explicit resource acquire, renew, release, and atomic handoff.",
].join(" ");

type ToolExecutor = (
	toolCallId: string,
	params: any,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: ExtensionContext,
) => Promise<{ content: Array<{ type: string; [key: string]: unknown }>; details?: unknown }>;

const executors: Record<string, ToolExecutor> = {
	find_roots: executeFind as unknown as ToolExecutor,
	observe_ui: executeObserve as unknown as ToolExecutor,
	search_ui: executeSearchUi as unknown as ToolExecutor,
	expand_ui: executeExpandUi as unknown as ToolExecutor,
	inspect_ui: executeInspectUi as unknown as ToolExecutor,
	act_ui: executeAct as unknown as ToolExecutor,
	execute_plan: executePlanTool,
	read_text: executeReadText as unknown as ToolExecutor,
	wait_for: executeWaitFor as unknown as ToolExecutor,
	open_root: (async (toolCallId, params, signal, onUpdate, ctx) => {
		if (typeof params.stateId === "string" && params.stateId.trim()) {
			return await (executeNavigateBrowser as unknown as ToolExecutor)(toolCallId, params, signal, onUpdate, ctx);
		}
		return await (executeLaunchBrowser as unknown as ToolExecutor)(toolCallId, params, signal, onUpdate, ctx);
	}) as ToolExecutor,
};

interface NestedToolResult {
	content: Array<{ type: string; [key: string]: unknown }>;
	details?: Record<string, any>;
}

function successorStateId(result: NestedToolResult): string | undefined {
	const details = result.details;
	const candidate = details?.capture?.stateId ?? details?.stateId;
	return typeof candidate === "string" && candidate ? candidate : undefined;
}

function failedNodeResult(node: ActionPlanNode, result: NestedToolResult): Error | undefined {
	const execution = result.details?.execution;
	const verification = execution?.verification?.status;
	const outcome = execution?.outcome;
	if (verification === "failed" || outcome === "didnt") {
		const error = new Error(execution?.error?.message ?? `Action-plan node '${node.id}' did not establish its requested outcome.`) as Error & Record<string, unknown>;
		error.code = execution?.error?.code ?? "postcondition_failed";
		error.delivery = "may_have_been_delivered";
		error.resourceKey = result.details?.resource?.key;
		error.evidence = { outcome, verification, nodeId: node.id };
		return error;
	}
	if (outcome === "unknown" && !node.acceptUnknown) {
		const error = new Error(`Action-plan node '${node.id}' completed with an unverified outcome.`) as Error & Record<string, unknown>;
		error.code = "unverified_outcome";
		error.delivery = "may_have_been_delivered";
		error.resourceKey = result.details?.resource?.key;
		error.evidence = { outcome, nodeId: node.id };
		return error;
	}
	return undefined;
}

async function executePlanTool(
	toolCallId: string,
	params: ExecutePlanParams,
	signal: AbortSignal | undefined,
	_onUpdate: undefined,
	ctx: ExtensionContext,
): Promise<NestedToolResult> {
	const trace = await executeAdaptiveActionPlan<NestedToolResult>(params, {
		execute: async (node, stateId, attempt, nodeSignal) => {
			const actor = currentActor();
			const operationId = scuaControlPlane.startOperation(actor, `execute_plan:${node.id}`);
			try {
				const result = await (executeAct as unknown as ToolExecutor)(`${toolCallId}_${node.id}_${attempt}`, {
					stateId,
					actions: node.actions,
					guards: node.guards,
					expect: node.expect,
				}, nodeSignal, undefined, ctx) as NestedToolResult;
				const failure = failedNodeResult(node, result);
				if (failure) throw failure;
				scuaControlPlane.finishOperation(actor, operationId, `execute_plan:${node.id}`, "completed", {
					stateId: successorStateId(result),
					resourceKey: result.details?.resource?.key,
					outcome: result.details?.execution?.outcome,
				});
				return result;
			} catch (error) {
				const envelope = scuaErrorEnvelope(error, Boolean(nodeSignal?.aborted));
				scuaControlPlane.finishOperation(actor, operationId, `execute_plan:${node.id}`, nodeSignal?.aborted ? "cancelled" : "failed", { errorCode: envelope.code, delivery: envelope.delivery });
				throw error;
			}
		},
		refresh: async (node, stateId, _error, nodeSignal) => {
			const refreshed = await (executeObserve as unknown as ToolExecutor)(`${toolCallId}_${node.id}_refresh`, {
				stateId,
				mode: "semantic",
			}, nodeSignal, undefined, ctx) as NestedToolResult;
			const refreshedStateId = successorStateId(refreshed);
			if (!refreshedStateId) throw new Error(`Action-plan node '${node.id}' could not refresh its state.`);
			return refreshedStateId;
		},
		successorStateId,
		classify: (error): PlanErrorClassification => scuaErrorEnvelope(error, Boolean(signal?.aborted)),
	}, signal);
	const nodes = trace.nodes.map(({ result, ...node }) => ({
		...node,
		outcome: result?.details?.execution?.outcome,
		verification: result?.details?.execution?.verification,
		resourceKey: result?.details?.resource?.key,
	}));
	const details = {
		tool: "execute_plan",
		planId: trace.planId,
		status: trace.status,
		startedAt: trace.startedAt,
		completedAt: trace.completedAt,
		durationMs: trace.durationMs,
		peakConcurrency: trace.peakConcurrency,
		nodes,
	};
	const completed = nodes.filter((node) => node.status === "succeeded").length;
	const failed = nodes.filter((node) => node.status === "failed").length;
	const blocked = nodes.filter((node) => node.status === "blocked").length;
	return {
		content: [{ type: "text", text: `Action plan ${trace.planId} ${trace.status} in ${trace.durationMs}ms: ${completed} succeeded, ${failed} failed, ${blocked} blocked; peak concurrency ${trace.peakConcurrency}.` }],
		details,
	};
}

function actorToken(params: Record<string, unknown>): string | undefined {
	const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
		? params._meta as Record<string, unknown>
		: undefined;
	return typeof meta?.scuaActorToken === "string" && meta.scuaActorToken.trim() ? meta.scuaActorToken.trim() : undefined;
}

async function executeControlTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	const actor = currentActor();
	const action = typeof args.action === "string" ? args.action : "";
	if (name === "actor_session") {
		if (action === "create") {
			const created = scuaControlPlane.createActor({
				maxActions: Number.isFinite(args.maxActions) ? Number(args.maxActions) : undefined,
				ttlMs: Number.isFinite(args.ttlMs) ? Number(args.ttlMs) : undefined,
			});
			return { content: [{ type: "text", text: `Created logical SCUA actor ${created.actorId}. Send actorToken as MCP request metadata scuaActorToken.` }], details: { tool: name, action, ...created } };
		}
		if (action === "status") {
			const status = scuaControlPlane.status(actor);
			return { content: [{ type: "text", text: `SCUA actor ${actor.actorId} status returned.` }], details: { tool: name, action, ...status } };
		}
		if (action === "close") {
			scuaControlPlane.closeActor(actor);
			releaseManagedRootsForActor(actor.actorId);
			return { content: [{ type: "text", text: `Closed SCUA actor ${actor.actorId} and released its claims.` }], details: { tool: name, action, actorId: actor.actorId, closed: true } };
		}
		throw new Error("actor_session.action must be create, status, or close.");
	}
	const resourceKey = typeof args.resourceKey === "string" ? args.resourceKey.trim() : "";
	if (!resourceKey) throw new Error("claim_resource.resourceKey is required.");
	const ttlMs = Number.isFinite(args.ttlMs) ? Number(args.ttlMs) : undefined;
	const leaseId = typeof args.leaseId === "string" ? args.leaseId : "";
	let claim: any;
	if (action === "acquire") claim = scuaControlPlane.acquire(actor, resourceKey, ttlMs);
	else if (action === "renew") claim = scuaControlPlane.renew(actor, resourceKey, leaseId, ttlMs);
	else if (action === "release") scuaControlPlane.release(actor, resourceKey, leaseId);
	else if (action === "handoff") {
		const fromActorId = actor.actorId;
		claim = scuaControlPlane.handoff(actor, resourceKey, leaseId, typeof args.recipientActorId === "string" ? args.recipientActorId : "", ttlMs);
		handoffManagedRoot(resourceKey, claim.actorId);
		claim.stateId = handoffSavedDesktopState(resourceKey, fromActorId, claim.actorId);
	}
	else throw new Error("claim_resource.action must be acquire, renew, release, or handoff.");
	const details = { tool: name, action, actorId: actor.actorId, resourceKey, ...(claim ?? { released: true }) };
	return { content: [{ type: "text", text: `${action} completed for ${resourceKey}.` }], details };
}

const context = {
	cwd: process.env.SCUA_CWD?.trim() || process.cwd(),
	hasUI: false,
	ui: {
		select: async () => undefined,
		notify: () => undefined,
	},
	sessionManager: {
		getBranch: () => [],
	},
} as unknown as ExtensionContext;

const inflight = new Map<string, { controller: AbortController; actorId?: string }>();

function requestKey(id: unknown): string {
	return typeof id === "string" ? id : JSON.stringify(id);
}

function write(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id: unknown, result: unknown): void {
	write({ jsonrpc: "2.0", id, result });
}

function errorResponse(id: unknown, code: number, message: string): void {
	write({ jsonrpc: "2.0", id, error: { code, message } });
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function callTool(id: unknown, params: Record<string, unknown>): Promise<void> {
	const name = typeof params.name === "string" ? params.name : "";
	const executor = executors[name];
	const isControlTool = name === "actor_session" || name === "claim_resource";
	if (!executor && !isControlTool) {
		response(id, {
			content: [{ type: "text", text: `Unknown SCUA tool: ${name || "(missing)"}` }],
			isError: true,
		});
		return;
	}

	const controller = new AbortController();
	const key = requestKey(id);
	inflight.set(key, { controller });
	try {
		await runAsActor(actorToken(params), async () => {
			const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
				? params.arguments as Record<string, unknown>
				: {};
			const actor = currentActor();
			const request = inflight.get(key);
			if (request) request.actorId = actor.actorId;
			const operationId = scuaControlPlane.startOperation(actor, name);
			try {
				const result = isControlTool
					? await executeControlTool(name, args)
					: await executor!(`mcp_${key}`, args, controller.signal, undefined, context);
				if (name === "actor_session" && args.action === "close") {
					for (const [otherKey, other] of inflight) {
						if (otherKey !== key && other.actorId === actor.actorId) other.controller.abort();
					}
				}
				const resultDetails = result.details && typeof result.details === "object" ? result.details as Record<string, any> : undefined;
				scuaControlPlane.finishOperation(actor, operationId, name, "completed", {
					resourceKey: resultDetails?.resource?.key ?? resultDetails?.resourceKey,
					epoch: resultDetails?.resource?.epoch,
					stateId: resultDetails?.stateId ?? resultDetails?.capture?.stateId,
					outcome: resultDetails?.execution?.outcome,
				});
				response(id, {
					content: result.content,
					...(result.details ? { structuredContent: compactStructuredContent({ ...result.details as Record<string, unknown>, operationId, requestActorId: actor.actorId }) } : {}),
					isError: false,
				});
			} catch (error) {
				const envelope = scuaErrorEnvelope(error, controller.signal.aborted);
				scuaControlPlane.finishOperation(actor, operationId, name, controller.signal.aborted ? "cancelled" : "failed", { errorCode: envelope.code, delivery: envelope.delivery });
				response(id, { content: [{ type: "text", text: envelope.message }], structuredContent: { error: envelope, operationId }, isError: true });
			}
		});
	} catch (error) {
		const envelope = scuaErrorEnvelope(error, controller.signal.aborted);
		response(id, {
			content: [{ type: "text", text: envelope.message }],
			structuredContent: { error: envelope },
			isError: true,
		});
	} finally {
		inflight.delete(key);
	}
}

async function handle(message: Record<string, unknown>): Promise<void> {
	const method = typeof message.method === "string" ? message.method : "";
	const id = message.id;
	const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
		? message.params as Record<string, unknown>
		: {};

	switch (method) {
		case "initialize":
			response(id, {
				protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: serverName, version: serverVersion },
				instructions,
			});
			return;
		case "notifications/initialized":
			return;
		case "notifications/cancelled": {
			const requestId = params.requestId;
			if (requestId !== undefined) inflight.get(requestKey(requestId))?.controller.abort();
			return;
		}
		case "ping":
			response(id, {});
			return;
		case "tools/list":
			response(id, { tools: mcpTools });
			return;
		case "tools/call":
			await callTool(id, params);
			return;
		default:
			if (id !== undefined) errorResponse(id, -32601, `Method not found: ${method}`);
	}
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	if (!line.trim()) return;
	try {
		const message = JSON.parse(line) as Record<string, unknown>;
		void handle(message).catch((error) => {
			if (message.id !== undefined) errorResponse(message.id, -32603, errorText(error));
		});
	} catch (error) {
		process.stderr.write(`SCUA MCP input error: ${errorText(error)}\n`);
	}
});

let closing = false;
async function close(): Promise<void> {
	if (closing) return;
	closing = true;
	for (const request of inflight.values()) request.controller.abort();
	await shutdownComputerUseSession().catch(() => undefined);
}

lines.on("close", () => { void close(); });
process.on("SIGINT", () => { void close().finally(() => process.exit(130)); });
process.on("SIGTERM", () => { void close().finally(() => process.exit(0)); });
