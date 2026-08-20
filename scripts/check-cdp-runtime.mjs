import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const commands = [];
let connections = 0;
let callFunctionThrows = false;
let cursorEvaluateThrows = false;
let navigationMarker = null;
let navigationPolls = 0;

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
			if (cursorEvaluateThrows && expression.includes("scua-agent-cursor-")) result = { exceptionDetails: { text: "cursor fixture exception" } };
			else if (expression.includes("globalThis.__scuaNavigationMarker =")) {
				const match = expression.match(/globalThis\.__scuaNavigationMarker = ("[^"]+")/);
				navigationMarker = match ? JSON.parse(match[1]) : "fixture-marker";
				result = { result: { value: true } };
			} else if (expression.includes("marker: globalThis.__scuaNavigationMarker")) {
				navigationPolls += 1;
				result = { result: { value: { state: "complete", marker: navigationMarker } } };
			}
			else {
				const value = expression.includes("elementFromPoint") ? false : expression.includes("__scuaMutationState") ? 0 : expression.includes("innerText") ? "Fixture text" : true;
				result = { result: { value } };
			}
		} else if (message.method === "Page.navigate") {
			result = { loaderId: "fixture-loader" };
			setTimeout(() => { navigationMarker = null; }, 25);
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
	const { CdpTab, cdpMutationGenerationForContext, cdpPerformActionDetailedForContext, cdpPerformActionForContext, cdpSnapshotForContext, cdpWaitForMutationForContext, disconnectCdp } = await import("../src/cdp.ts");
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

	cursorEvaluateThrows = true;
	const cursorFailure = await cdpPerformActionDetailedForContext(contextId, "fixture-agent", { action: "moveMouse", x: 20, y: 20 }, undefined);
	assert.equal(cursorFailure?.worked, true, "visual cursor failure incorrectly blocked the browser action lane");
	assert.equal(cursorFailure?.cursor.overlayPresented, false, "cursor injection failure was reported as visually acknowledged");
	assert.match(cursorFailure?.cursor.overlayError ?? "", /cursor fixture exception/, "cursor injection error was not surfaced as evidence");
	cursorEvaluateThrows = false;

	callFunctionThrows = true;
	await assert.rejects(
		() => cdpPerformActionForContext(contextId, "fixture-agent", { action: "press", ref: "@e1" }, 42),
		/CDP page action threw: fixture exception/,
		"Runtime.callFunctionOn exceptionDetails were ignored",
	);
	const navigationTab = await CdpTab.connect("ws://127.0.0.1:9222/devtools/page/navigation", "navigation", "Navigation fixture");
	await navigationTab.navigate("https://fixture.invalid/next");
	assert(navigationPolls > 1, "eventless navigation accepted the old document's readyState");
	navigationTab.close();
	disconnectCdp();
	console.log("CDP runtime checks passed.");
} finally {
	globalThis.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
}
