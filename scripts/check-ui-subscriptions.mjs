#!/usr/bin/env node
import assert from "node:assert/strict";
import { UiSubscriptionError, UiSubscriptionStore } from "../src/ui-subscriptions.ts";

const store = new UiSubscriptionStore();
const created = store.create({
	actorId: "actor-a",
	resourceKey: "fixture:window",
	resourceEpoch: 1,
	leaseId: "lease-a",
	leaseGeneration: 1,
	leaseExpiresAt: Date.now() + 300_000,
	stateId: "state-a",
	source: "native_ax",
	sourceCursor: 7,
	condition: { text: "Complete" },
	conditionSatisfied: false,
});

assert.equal(store.read(created.record.subscriptionId, "actor-a", created.cursor).events.length, 0);
store.append(created.record.subscriptionId, "ui_changed", { notification: "AXValueChanged" }, 2);
const changed = store.read(created.record.subscriptionId, "actor-a", created.cursor);
assert.equal(changed.events.length, 1);
assert.equal(changed.events[0].type, "ui_changed");
assert.equal(changed.events[0].subscriptionId, created.record.subscriptionId);
assert.equal(changed.events[0].actorId, "actor-a");
assert.equal(changed.events[0].resourceKey, "fixture:window");
assert.equal(changed.events[0].resourceEpoch, 2);
assert.equal(changed.events[0].traceId, `${created.record.subscriptionId}:1`);
assert.equal(store.read(created.record.subscriptionId, "actor-a", changed.nextCursor).events.length, 0, "resume cursor replayed consumed events");

await assert.rejects(
	async () => store.waitForEvents(created.record.subscriptionId, "actor-a", changed.nextCursor, 10, AbortSignal.abort()),
	/aborted/i,
);
assert.throws(
	() => store.read(created.record.subscriptionId, "actor-b", created.cursor),
	(error) => error instanceof UiSubscriptionError && error.code === "subscription_owned",
);
assert.throws(
	() => store.read(created.record.subscriptionId, "actor-a", "not-a-cursor"),
	(error) => error instanceof UiSubscriptionError && error.code === "cursor_invalid",
);

for (let index = 0; index < 300; index += 1) store.append(created.record.subscriptionId, "ui_changed", { index });
const overflowed = store.read(created.record.subscriptionId, "actor-a", created.cursor, 128);
assert.equal(overflowed.overflow, true, "bounded buffer did not report cursor overflow");
assert.equal(overflowed.events.length, 128);
assert.equal(overflowed.hasMore, true);

const invalidated = store.invalidateResource("fixture:window", "actor-a", "handed_off", { recipientActorId: "actor-b" });
assert.deepEqual(invalidated, [created.record.subscriptionId]);
let terminal = store.read(created.record.subscriptionId, "actor-a", overflowed.nextCursor, 128);
while (terminal.hasMore) terminal = store.read(created.record.subscriptionId, "actor-a", terminal.nextCursor, 128);
assert.equal(terminal.record.active, false);
assert.equal(terminal.record.terminalReason, "handed_off");
assert(terminal.events.some((event) => event.type === "ownership_lost"), "handoff omitted its terminal ownership event");

const diagnostics = store.diagnostics();
assert.equal(diagnostics.activeSubscriptions, 0);
assert(diagnostics.retainedUiEvents <= 256, "subscription event storage exceeded its bound");

const fifty = Array.from({ length: 50 }, (_, index) => store.create({
	actorId: `actor-${index}`,
	resourceKey: `fixture:${index}`,
	resourceEpoch: 1,
	leaseId: `lease-${index}`,
	leaseGeneration: 1,
	leaseExpiresAt: Date.now() + 300_000,
	stateId: `state-${index}`,
	source: index % 2 === 0 ? "native_ax" : "browser_dom",
	sourceCursor: 0,
}));
await Promise.all(fifty.map(async ({ record, cursor }, index) => {
	store.append(record.subscriptionId, "ui_changed", { index });
	await store.waitForEvents(record.subscriptionId, record.actorId, cursor, 100);
	const read = store.read(record.subscriptionId, record.actorId, cursor);
	assert.equal(read.events[0].details.index, index);
	store.close(record.subscriptionId, record.actorId, "fixture_complete");
}));
assert.equal(store.diagnostics().activeSubscriptions, 0, "50-actor subscription wave leaked active records");

const expired = store.create({
	actorId: "actor-expired",
	resourceKey: "fixture:expired",
	resourceEpoch: 1,
	leaseId: "lease-expired",
	leaseGeneration: 1,
	leaseExpiresAt: Date.now() + 300_000,
	stateId: "state-expired",
	source: "native_ax",
	sourceCursor: 0,
});
store.close(expired.record.subscriptionId, expired.record.actorId, "fixture_complete");
expired.record.lastReadAt = 0;
expired.record.createdAt = 0;
assert.throws(
	() => store.get(expired.record.subscriptionId, expired.record.actorId),
	(error) => error instanceof UiSubscriptionError && error.code === "subscription_unavailable",
	"inactive expiry was not enforced on lookup",
);

console.log("UI subscription store checks passed.");
