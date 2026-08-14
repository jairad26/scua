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
	shutdownComputerUseSession,
} from "../src/bridge.ts";
import { mcpTools } from "./tool-catalog.ts";

const serverName = "scua";
const serverVersion = "0.1.0";
const instructions = [
	"SCUA is a generic, state-scoped computer-use engine.",
	"Use find_roots, observe_ui, cached search/expand/inspect, then act_ui with refs from the same stateId.",
	"The same tool contract applies to every desktop window and browser-page root; never invent or request app-specific SCUA tools.",
	"Never silently substitute a different application or web version when the selected root cannot satisfy an action.",
	"SCUA defaults to background delivery with visual agent cursors and forbids foreground fallback, physical-cursor takeover, and global keyboard takeover.",
	"Independent physical resources may progress concurrently; stale writes are rejected by resource epoch.",
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
	read_text: executeReadText as unknown as ToolExecutor,
	wait_for: executeWaitFor as unknown as ToolExecutor,
};

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

const inflight = new Map<string, AbortController>();

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
	if (!executor) {
		response(id, {
			content: [{ type: "text", text: `Unknown SCUA tool: ${name || "(missing)"}` }],
			isError: true,
		});
		return;
	}

	const controller = new AbortController();
	const key = requestKey(id);
	inflight.set(key, controller);
	try {
		const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
			? params.arguments as Record<string, unknown>
			: {};
		const result = await executor(`mcp_${key}`, args, controller.signal, undefined, context);
		response(id, {
			content: result.content,
			...(result.details ? { structuredContent: result.details } : {}),
			isError: false,
		});
	} catch (error) {
		response(id, {
			content: [{ type: "text", text: errorText(error) }],
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
			if (requestId !== undefined) inflight.get(requestKey(requestId))?.abort();
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
	for (const controller of inflight.values()) controller.abort();
	await shutdownComputerUseSession().catch(() => undefined);
}

lines.on("close", () => { void close(); });
process.on("SIGINT", () => { void close().finally(() => process.exit(130)); });
process.on("SIGTERM", () => { void close().finally(() => process.exit(0)); });
