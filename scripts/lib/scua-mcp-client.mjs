import { spawn } from "node:child_process";
import path from "node:path";

/** Long-lived MCP client for workflows which must preserve SCUA state, leases,
 * subscriptions, and handoffs across many calls. */
export class ScuaMcpClient {
	constructor({ root, actorId = `scua-client-${process.pid}`, env = {}, clientName = "scua-persistent-client" }) {
		this.root = root;
		this.clientName = clientName;
		this.nextId = 1;
		this.buffer = "";
		this.responses = new Map();
		this.waiters = new Map();
		this.stderr = "";
		this.child = spawn(process.execPath, [path.join(root, "mcp/server.ts")], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...env, SCUA_AGENT_ID: actorId },
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.#onData(chunk));
		this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
	}

	#onData(chunk) {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const key = String(message.id);
			this.responses.set(key, message);
			this.waiters.get(key)?.();
		}
	}

	async request(method, params = {}, timeoutMs = 60_000) {
		const id = this.nextId++;
		const key = String(id);
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		if (!this.responses.has(key)) {
			let timer;
			try {
				await Promise.race([
					new Promise((resolve) => this.waiters.set(key, resolve)),
					new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP request ${key} timed out: ${this.stderr}`)), timeoutMs); timer.unref(); }),
				]);
			} finally {
				clearTimeout(timer);
			}
		}
		this.waiters.delete(key);
		const response = this.responses.get(key);
		this.responses.delete(key);
		return response;
	}

	async initialize() {
		const response = await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: this.clientName, version: "1" },
		});
		if (response?.result?.serverInfo?.name !== "scua") throw new Error(`Unexpected MCP server: ${JSON.stringify(response)}`);
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		return this;
	}

	async call(name, args, timeoutMs = 60_000) {
		const response = await this.request("tools/call", { name, arguments: args }, timeoutMs);
		const result = response?.result;
		const message = (result?.content ?? []).map((item) => item?.text ?? "").join("\n");
		if (result?.isError !== false) throw new Error(`${name} failed: ${message || this.stderr}`);
		return { text: message, details: result.structuredContent };
	}

	async close() {
		this.child.stdin.end();
		await Promise.race([
			new Promise((resolve) => this.child.once("exit", resolve)),
			new Promise((resolve) => { const timer = setTimeout(resolve, 2_000); timer.unref(); }),
		]);
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
	}
}

export async function withScuaMcpClient(options, work) {
	const client = await new ScuaMcpClient(options).initialize();
	try {
		return await work(client);
	} finally {
		await client.close();
	}
}
