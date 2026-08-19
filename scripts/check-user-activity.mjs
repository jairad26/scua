import assert from "node:assert/strict";
import { assertUserQuietPeriod, UserActiveError, waitForUserQuietPeriod } from "../src/user-activity.ts";

let reads = 0;
let sleeps = 0;
const immediate = await waitForUserQuietPeriod(async () => {
	reads += 1;
	return { idleForMs: 900, monitoringMode: "listen_only" };
}, { quietPeriodMs: 750, timeoutMs: 5_000, sleep: async () => { sleeps += 1; } });
assert.equal(immediate.idleForMs, 900);
assert.equal(reads, 1, "already-idle user required extra polling");
assert.equal(sleeps, 0, "already-idle user incurred a delay");

let now = 0;
let lastInputAt = 0;
const waited = await waitForUserQuietPeriod(async () => ({ idleForMs: now - lastInputAt, monitoringMode: "listen_only" }), {
	quietPeriodMs: 120,
	timeoutMs: 500,
	pollMs: 50,
	now: () => now,
	sleep: async (ms) => { now += ms; },
});
assert.equal(waited.idleForMs, 120, "quiet-period wait did not require one continuous idle interval");
assert.equal(now, 120, "quiet-period wait overslept its threshold");

now = 0;
lastInputAt = 0;
await assert.rejects(
	() => waitForUserQuietPeriod(async () => {
		lastInputAt = now;
		return { idleForMs: 0, monitoringMode: "listen_only" };
	}, {
		quietPeriodMs: 100,
		timeoutMs: 150,
		pollMs: 50,
		now: () => now,
		sleep: async (ms) => { now += ms; },
	}),
	(error) => error instanceof UserActiveError && error.code === "user_active" && error.delivery === "definitely_not_delivered" && error.recovery === "reacquire",
	"continuous user activity did not yield with a typed definitely-not-delivered result",
);
assert.equal(now, 150, "active-user wait exceeded its time budget");

reads = 0;
await waitForUserQuietPeriod(async () => {
	reads += 1;
	return { idleForMs: 0, monitoringMode: "listen_only" };
}, { quietPeriodMs: 0, timeoutMs: 0 });
assert.equal(reads, 0, "disabled quiet-period policy queried global input state");

await assert.rejects(
	() => assertUserQuietPeriod(async () => ({ idleForMs: 10, monitoringMode: "hid_system_timer" }), 100),
	(error) => error instanceof UserActiveError && error.evidence.monitoringMode === "hid_system_timer",
	"final no-wait recheck did not reject newly active input",
);

console.log("Physical-user quiet-period checks passed.");
