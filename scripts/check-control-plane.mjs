import assert from "node:assert/strict";
import { scuaErrorEnvelope } from "../mcp/errors.ts";
import { OwnershipError, assertCurrentActorMutation, currentActorId, runAsActor, scuaControlPlane } from "../src/control-plane.ts";
import { SavedStates } from "../src/state.ts";

const actors = Array.from({ length: 50 }, () => scuaControlPlane.createActor({ maxActions: 10 }));
assert.equal(new Set(actors.map((actor) => actor.actorId)).size, 50, "logical actor IDs were not unique");
assert.equal(new Set(actors.map((actor) => actor.actorToken)).size, 50, "logical actor capabilities were not unique");

const [first, second] = actors;
const reconstructedOwnership = scuaErrorEnvelope(new Error("Resource 'cdp:fixture' is owned by actor-recipient."));
assert.deepEqual(
	{ code: reconstructedOwnership.code, resourceKey: reconstructedOwnership.resourceKey, delivery: reconstructedOwnership.delivery, recovery: reconstructedOwnership.recovery },
	{ code: "resource_owned", resourceKey: "cdp:fixture", delivery: "definitely_not_delivered", recovery: "reacquire" },
	"generic wrappers did not preserve resource ownership semantics",
);
let firstClaim;
await runAsActor(first.actorToken, async () => {
	assert.equal(currentActorId(), first.actorId, "request metadata did not select the logical actor");
	firstClaim = scuaControlPlane.acquire(scuaControlPlane.actor(first.actorToken), "fixture:shared", 30_000);
	assertCurrentActorMutation("fixture:shared");
});

await assert.rejects(
	() => runAsActor(second.actorToken, async () => assertCurrentActorMutation("fixture:shared")),
	(error) => error instanceof OwnershipError && error.code === "resource_owned" && error.recovery === "reacquire",
	"conflicting actor did not receive a typed ownership rejection",
);

let recipientClaim;
await runAsActor(first.actorToken, async () => {
	recipientClaim = scuaControlPlane.handoff(scuaControlPlane.actor(first.actorToken), "fixture:shared", firstClaim.leaseId, second.actorId, 30_000);
});
assert.notEqual(recipientClaim.leaseId, firstClaim.leaseId, "handoff reused the previous fencing token");
assert.equal(recipientClaim.generation, firstClaim.generation + 1, "handoff did not advance the ownership generation");

await assert.rejects(
	() => runAsActor(first.actorToken, async () => assertCurrentActorMutation("fixture:shared")),
	(error) => error instanceof OwnershipError && error.code === "resource_owned",
	"previous owner remained authorized after handoff",
);
await runAsActor(second.actorToken, async () => assertCurrentActorMutation("fixture:shared"));

await runAsActor(second.actorToken, async () => {
	await scuaControlPlane.withMutation(scuaControlPlane.actor(second.actorToken), "fixture:shared", async () => {
		assert.throws(
			() => scuaControlPlane.handoff(scuaControlPlane.actor(second.actorToken), "fixture:shared", recipientClaim.leaseId, actors[2].actorId),
			(error) => error instanceof OwnershipError && error.code === "resource_busy",
			"handoff was allowed while a mutation was in flight",
		);
	});
});

const savedStates = new SavedStates();
await runAsActor(first.actorToken, async () => savedStates.set({
	stateId: "state-owned-by-first",
	resourceKey: "fixture:state",
	epoch: 0,
	value: { kind: "browser", actorId: first.actorId, snapshot: {}, outline: {} },
}));
await runAsActor(second.actorToken, async () => {
	assert.equal(savedStates.get("state-owned-by-first"), undefined, "recipient could reuse the previous owner's state without a fresh observation");
});

await runAsActor(first.actorToken, async () => savedStates.set({
	stateId: "desktop-owned-by-first",
	resourceKey: "desktop-app:42",
	epoch: 7,
	value: {
		kind: "desktop",
		actorId: first.actorId,
		target: { appName: "Fixture", pid: 42, windowTitle: "Fixture", windowId: 9 },
		capture: { stateId: "desktop-owned-by-first", width: 1, height: 1, scaleFactor: 1, timestamp: 1 },
		look: { lookId: "look-fixture", capturedAt: 1, window: { windowId: 9, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1, isModal: false, role: "AXWindow", subrole: "" }, timings: {} },
		outline: { lookId: "look-fixture", root: { ref: "@e1", wireRef: "e1", role: "AXWindow", subrole: "", identifier: "", title: "Fixture", description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, children: [] } },
	},
}));
const transferredStateId = savedStates.transferLatestDesktop("desktop-app:42", first.actorId, second.actorId);
assert(transferredStateId && transferredStateId !== "desktop-owned-by-first", "handoff did not mint a fresh recipient state ID");
await runAsActor(second.actorToken, async () => {
	assert(savedStates.get(transferredStateId), "recipient could not read its transferred immutable state");
	assert.equal(savedStates.get("desktop-owned-by-first"), undefined, "recipient gained access to the sender's original state ID");
});

let activeMutations = 0;
let peakMutations = 0;
await Promise.all(actors.map(async (actor, index) => {
	const resourceKey = `fixture:independent:${index}`;
	await runAsActor(actor.actorToken, async () => {
		const session = scuaControlPlane.actor(actor.actorToken);
		scuaControlPlane.acquire(session, resourceKey);
		await scuaControlPlane.withMutation(session, resourceKey, async () => {
			activeMutations += 1;
			peakMutations = Math.max(peakMutations, activeMutations);
			await new Promise((resolve) => setTimeout(resolve, 5));
			activeMutations -= 1;
		});
	});
}));
assert(peakMutations >= 25, `50 independent logical actors did not make concurrent progress (peak ${peakMutations})`);

for (const actor of actors) {
	await runAsActor(actor.actorToken, async () => scuaControlPlane.closeActor(scuaControlPlane.actor(actor.actorToken)));
}

const events = scuaControlPlane.allEvents();
assert(events.some((event) => event.type === "handed_off" && event.resourceKey === "fixture:shared"), "trace omitted handoff event");
assert(events.filter((event) => event.type === "actor_created").length >= 50, "trace omitted actor creation events");

console.log("Control-plane checks passed for 50 logical actors.");
