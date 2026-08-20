import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ChromeWorkspaceTab {
	tabId: number;
	targetId: string;
	groupId: number;
	windowId: number;
	workspaceId: string;
	workspaceName: string;
	reusedWindow?: boolean;
	active: boolean;
	title: string;
	url: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const PRECONNECT_RETRY_DELAYS_MS = [50, 150, 350, 750];
const CHROME_WORKSPACE_ID = process.env.SCUA_CHROME_WORKSPACE_ID?.trim() || `scua-${randomUUID()}`;
const CHROME_WORKSPACE_NAME = process.env.SCUA_CHROME_WORKSPACE_NAME?.trim() || "SCUA";

export function chromeExtensionSocketPath(): string {
	return process.env.SCUA_CHROME_BRIDGE_SOCKET?.trim()
		|| path.join(os.homedir(), "Library", "Application Support", "SCUA", "chrome-bridge.sock");
}

function retryablePreconnectError(error: unknown): boolean {
	const candidate = error as NodeJS.ErrnoException & { requestSent?: boolean };
	return candidate.requestSent !== true && (candidate.code === "ECONNREFUSED" || candidate.code === "ENOENT");
}

async function chromeExtensionRequestOnce<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
	const id = randomUUID();
	const socket = net.createConnection(chromeExtensionSocketPath());
	return await new Promise<T>((resolve, reject) => {
		let buffer = "";
		let settled = false;
		let requestSent = false;
		const finish = (error?: Error, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) {
				(error as Error & { requestSent?: boolean }).requestSent = requestSent;
				reject(error);
			}
			else resolve(value as T);
		};
		const timer = setTimeout(() => finish(new Error(`SCUA Chrome extension request '${method}' timed out after ${timeoutMs}ms.`)), timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			requestSent = true;
			socket.write(`${JSON.stringify({ type: "request", id, method, params })}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let response: { id?: string; result?: T; error?: { message?: string } };
				try { response = JSON.parse(line); } catch { continue; }
				if (response.id !== id) continue;
				if (response.error) finish(new Error(`SCUA Chrome extension: ${response.error.message ?? "unknown error"}`));
				else finish(undefined, response.result);
			}
		});
		socket.on("error", (error) => finish(error));
		socket.on("close", () => {
			if (!settled) finish(new Error("SCUA Chrome extension bridge disconnected before replying."));
		});
	});
}

export async function chromeExtensionRequest<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await chromeExtensionRequestOnce<T>(method, params, timeoutMs);
		} catch (error) {
			const delayMs = PRECONNECT_RETRY_DELAYS_MS[attempt];
			if (delayMs === undefined || !retryablePreconnectError(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

export async function chromeExtensionAvailable(timeoutMs = 250): Promise<boolean> {
	try {
		const result = await chromeExtensionRequest<{ ready?: boolean }>("bridge.ping", {}, timeoutMs);
		return result.ready === true;
	} catch {
		return false;
	}
}

export async function chromeExtensionEnsureTab(url: string): Promise<ChromeWorkspaceTab> {
	return await chromeExtensionRequest<ChromeWorkspaceTab>("workspace.ensureTab", {
		url,
		workspaceId: CHROME_WORKSPACE_ID,
		workspaceName: CHROME_WORKSPACE_NAME,
	}, 10_000);
}

export async function chromeExtensionListTabs(): Promise<ChromeWorkspaceTab[]> {
	return await chromeExtensionRequest<ChromeWorkspaceTab[]>("workspace.listTabs", {
		workspaceId: CHROME_WORKSPACE_ID,
		workspaceName: CHROME_WORKSPACE_NAME,
	}, 2_000);
}

export async function chromeExtensionCloseWorkspace(): Promise<number> {
	const result = await chromeExtensionRequest<{ closed: number }>("workspace.close", {
		workspaceId: CHROME_WORKSPACE_ID,
		workspaceName: CHROME_WORKSPACE_NAME,
	}, 10_000);
	return result.closed;
}

export async function chromeExtensionCdpCommand(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
	return await chromeExtensionRequest("cdp.command", { workspaceId: CHROME_WORKSPACE_ID, tabId, method, params });
}
