import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const commands = [];
let connections = 0;
let callFunctionThrows = false;

class FakeWebSocket {
	static OPEN = 1;
	readyState = FakeWebSocket.OPEN;
	onopen;
	onmessage;
	onclose;
	onerror;

	constructor() {
		connections += 1;
		queueMicrotask(() => this.onopen?.());
	}

	send(raw) {
		const message = JSON.parse(raw);
		commands.push(message.method);
		let result = {};
		if (message.method === "Runtime.evaluate") {
			const expression = String(message.params?.expression ?? "");
			const value = expression.includes("elementFromPoint") ? false : expression.includes("__scuaMutationState") ? 0 : expression.includes("innerText") ? "Fixture text" : true;
			result = { result: { value } };
		} else if (message.method === "Accessibility.getFullAXTree") {
			result = { nodes: [{ nodeId: "root", role: { value: "document" }, name: { value: "Fixture" }, childIds: [] }] };
		} else if (message.method === "DOM.resolveNode") {
			result = { object: { objectId: "object-1" } };
		} else if (message.method === "Runtime.callFunctionOn") {
			result = callFunctionThrows ? { exceptionDetails: { text: "fixture exception" } } : { result: { value: true } };
		}
		queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }));
	}

	close() {
		this.readyState = 3;
		this.onclose?.();
	}
}

globalThis.WebSocket = FakeWebSocket;
globalThis.fetch = async () => ({
	ok: true,
	json: async () => [{ id: "target-1", type: "page", title: "Fixture", url: "https://fixture.invalid", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1" }],
});
process.env.PI_COMPUTER_USE_CDP_PORT = "9222";

try {
	const { cdpMutationGenerationForContext, cdpPerformActionForContext, cdpSnapshotForContext, cdpWaitForMutationForContext, disconnectCdp } = await import("../src/cdp.ts");
	const contextId = "browser:target-1";
	const first = await cdpSnapshotForContext(contextId);
	const second = await cdpSnapshotForContext(contextId);
	assert(first && second, "fake CDP snapshot failed");
	assert.equal(connections, 1, "normal context operations opened more than one target connection");
	assert.equal(commands.filter((method) => method === "Accessibility.getFullAXTree").length, 2, "snapshot command accounting is invalid");

	const generation = await cdpMutationGenerationForContext(contextId);
	await cdpWaitForMutationForContext(contextId, generation ?? 0, 50);
	assert.equal(commands.filter((method) => method === "Accessibility.getFullAXTree").length, 2, "mutation wait fetched a full AX tree");

	const delivered = await cdpPerformActionForContext(contextId, "fixture-agent", { action: "click", x: 9_999, y: 9_999 }, undefined);
	assert.equal(delivered, false, "coordinate click with no element incorrectly reported delivery");

	callFunctionThrows = true;
	await assert.rejects(
		() => cdpPerformActionForContext(contextId, "fixture-agent", { action: "press", ref: "@e1" }, 42),
		/CDP page action threw: fixture exception/,
		"Runtime.callFunctionOn exceptionDetails were ignored",
	);
	disconnectCdp();
	console.log("CDP runtime checks passed.");
} finally {
	globalThis.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
}
