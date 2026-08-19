import assert from "node:assert/strict";
import { HelperCommandError, HelperTransportError, MacosHelperClient } from "../src/platform/macos/helper.ts";

const singleflight = new MacosHelperClient();
let singleflightReady = false;
let singleflightLaunches = 0;
singleflight.launchDaemon = async () => {
	singleflightLaunches += 1;
	singleflightReady = true;
};
singleflight.daemonCommand = async (command) => {
	assert.equal(command, "diagnostics");
	if (!singleflightReady) throw new HelperTransportError("not ready", { code: "ENOENT", phase: "not_connected" });
	return {};
};
const readyResults = await Promise.all(Array.from({ length: 50 }, () => singleflight.ensureDaemon()));
assert(readyResults.every(Boolean), "singleflight daemon startup did not satisfy every waiter");
assert.equal(singleflightLaunches, 1, "concurrent helper calls launched more than one daemon");

const semantic = new MacosHelperClient();
let semanticDiagnostics = 0;
let semanticLaunches = 0;
semantic.launchDaemon = async () => { semanticLaunches += 1; };
semantic.daemonCommand = async (command) => {
	if (command === "diagnostics") {
		semanticDiagnostics += 1;
		return {};
	}
	if (command === "semantic-failure") throw new HelperCommandError("bad ref", "stale_ref");
	return { ok: true };
};
await assert.rejects(() => semantic.command("semantic-failure"), (error) => error instanceof HelperCommandError);
await semantic.command("success");
assert.equal(semanticDiagnostics, 1, "semantic command error incorrectly invalidated the healthy daemon");
assert.equal(semanticLaunches, 0, "semantic command error incorrectly relaunched the daemon");

const presend = new MacosHelperClient();
let presendAttempts = 0;
presend.daemonCommand = async (command) => {
	if (command === "diagnostics") return {};
	presendAttempts += 1;
	if (presendAttempts === 1) throw new HelperTransportError("connection race", { code: "ECONNREFUSED", phase: "not_connected" });
	return { retried: true };
};
const retried = await presend.command("safe-command");
assert.deepEqual(retried, { retried: true }, "pre-send helper race was not retried");
assert.equal(presendAttempts, 2, "pre-send helper race did not use exactly one retry");

const postsend = new MacosHelperClient();
let postsendAttempts = 0;
postsend.daemonCommand = async (command) => {
	if (command === "diagnostics") return {};
	postsendAttempts += 1;
	throw new HelperTransportError("ambiguous delivery", { code: "ECONNRESET", phase: "sent" });
};
await assert.rejects(() => postsend.command("unsafe-to-replay"), (error) => error instanceof HelperTransportError && error.phase === "sent");
assert.equal(postsendAttempts, 1, "post-send helper failure was unsafely replayed");

console.log("Helper transport checks passed.");
