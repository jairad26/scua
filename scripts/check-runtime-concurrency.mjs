import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canRetryInForeground, outcomeAfterCheck, outcomeAfterObservedTransition, outcomeAfterObservedValues, prepareAction } from "../src/actions.ts";
import { searchMayEscalateToDesktopOcr, transactionNeedsVerifiedVisualDelivery } from "../src/bridge.ts";
import { graftScopedOutline, nodeByRef, parseLookResponse, revealCandidates, searchOutlineRanked } from "../src/outline.ts";
import { rebindActParams, TargetRebindError } from "../src/rebind.ts";
import { ResourceScheduler, StateStore, StaleResourceStateError } from "../src/runtime.ts";
import { changesBetween, stabilizeRefs } from "../src/view.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(searchMayEscalateToDesktopOcr("browser:fixture"), false, "browser static/empty searches can leak into desktop OCR");
assert.equal(searchMayEscalateToDesktopOcr(undefined), true, "desktop searches lost their scoped OCR recovery path");

const states = new StateStore(2);
const first = states.create("pid:1", 0, { label: "first" });
states.create("pid:2", 0, { label: "second" });
states.create("pid:3", 0, { label: "third" });
assert.equal(states.get(first.stateId), undefined, "bounded state store did not evict oldest state");

const rawLook = (lookId, children) => parseLookResponse({
	lookId,
	capturedAt: Date.now() / 1000,
	window: { windowId: 1, framePoints: { x: 0, y: 0, w: 800, h: 600 }, scaleFactor: 1, isModal: false, role: "AXWindow", subrole: "AXStandardWindow" },
	outline: { ref: "window", role: "AXWindow", children },
	timings: {},
});

const baseLook = rawLook("look-1", [
	{ ref: "toolbar", role: "AXToolbar", title: "Toolbar" },
	{ ref: "editor", role: "AXTextArea", value: "", canSetValue: true, isTextInput: true },
]);
const nextLook = rawLook("look-2", [
	{ ref: "inserted", role: "AXStaticText", value: "Status" },
	{ ref: "toolbar", role: "AXToolbar", title: "Toolbar" },
	{ ref: "editor", role: "AXTextArea", value: "hello", canSetValue: true, isTextInput: true },
]);
nextLook.image = { jpegBase64: "fixture", width: 800, height: 600 };
stabilizeRefs(baseLook.parsedOutline, nextLook.parsedOutline);
assert.equal(nextLook.parsedOutline.wireRefToRef.get("editor"), baseLook.parsedOutline.wireRefToRef.get("editor"), "successor state did not preserve a confidently matched ref");
const successorDiff = changesBetween(baseLook.parsedOutline, nextLook.parsedOutline);
assert.equal(successorDiff.useFullView, false, "small successor change unexpectedly required a full view");
assert(successorDiff.changes.some((change) => change.type === "updated" && change.ref === baseLook.parsedOutline.wireRefToRef.get("editor") && change.fields.value === "hello"), "successor diff omitted the editor value change");
assert(successorDiff.changes.some((change) => change.type === "added" && change.ref === nextLook.parsedOutline.wireRefToRef.get("inserted")), "successor diff omitted the added node");

const regeneratedLook = rawLook("look-3", [
	{ ref: "toolbar-new", role: "AXToolbar", title: "Toolbar" },
	{ ref: "editor-new", role: "AXTextArea", value: "updated", canSetValue: true, isTextInput: true },
]);
stabilizeRefs(baseLook.parsedOutline, regeneratedLook.parsedOutline);
const regeneratedEditor = regeneratedLook.parsedOutline.nodes.find((node) => node.wireRef === "editor-new");
assert.equal(regeneratedEditor?.ref, baseLook.parsedOutline.wireRefToRef.get("editor"), "structurally stable nodes did not retain refs when native refs regenerated");
assert.equal(changesBetween(baseLook.parsedOutline, regeneratedLook.parsedOutline).useFullView, false, "regenerated native refs forced an unnecessary full view");

const describedFields = rawLook("described-fields", [
	{ ref: "title-field", role: "AXTextArea", roleDescription: "page title", placeholder: "Untitled", canSetValue: true, isTextInput: true },
	{ ref: "body-field", role: "AXTextArea", roleDescription: "text entry area", canSetValue: true, isTextInput: true },
]);
assert.equal(searchOutlineRanked(describedFields.parsedOutline, "page title", "textbox", "setValue").matches[0]?.node.wireRef, "title-field", "editable role descriptions did not disambiguate title and body controls");
assert.equal(searchOutlineRanked(describedFields.parsedOutline, "text entry area", "textbox", "setValue").matches[0]?.node.wireRef, "body-field", "editable body semantics were not searchable");

const hiddenControlLook = rawLook("hidden-control", [
	{ ref: "save", role: "AXButton", title: "Save", canPress: true },
	{ ref: "disclosure", role: "AXButton", title: "Add Notes, URL, or Attachments", canPress: true },
]);
assert.equal(revealCandidates(hiddenControlLook.parsedOutline)[0]?.node.wireRef, "disclosure", "hidden controls did not surface a generic pressable disclosure candidate");

const virtualizedBase = rawLook("virtualized-base", [
	{ ref: "virtual-row", role: "AXRow", title: "Jai Radhakrishnan", canPress: true },
]);
const virtualizedFresh = rawLook("virtualized-fresh", [
	{ ref: "virtual-row", role: "AXRow", title: "deployments", canPress: true },
]);
const oldVirtualRef = virtualizedBase.parsedOutline.wireRefToRef.get("virtual-row");
stabilizeRefs(virtualizedBase.parsedOutline, virtualizedFresh.parsedOutline);
assert.notEqual(virtualizedFresh.parsedOutline.wireRefToRef.get("virtual-row"), oldVirtualRef, "a repurposed virtual row retained the prior semantic ref");
assert.throws(
	() => rebindActParams({ stateId: "old", actions: [{ action: "press", ref: oldVirtualRef }] }, virtualizedBase.parsedOutline, virtualizedFresh.parsedOutline, "new"),
	(error) => error instanceof TargetRebindError && error.delivery === "definitely_not_delivered",
	"a repurposed live wire ref rebound to a different semantic row",
);

const editor = nextLook.parsedOutline.nodes.find((node) => node.wireRef === "editor");
assert(editor, "editor fixture was not parsed");
const actionEnv = {
	headless: false,
	image: { width: 800, height: 600 },
	node: (ref) => nodeByRef(nextLook.parsedOutline, ref),
	center: (node) => ({ x: node.rect?.x ?? 0, y: node.rect?.y ?? 0 }),
	validatePoint: () => undefined,
};
const preparedClick = prepareAction({ action: "click", ref: editor.ref }, { currentFocus: false }, actionEnv);
assert.equal(preparedClick.establishesFocus, true, "editable semantic clicks should establish transaction focus");
assert("ref" in preparedClick.target, "text-input clicks should retain semantic grounding so native AX geometry avoids screenshot hydration");
assert.equal(preparedClick.needsForeground, true, "text-input clicks should establish focus through foreground pointer input");
assert.equal(transactionNeedsVerifiedVisualDelivery([{ action: "click", ref: editor.ref }], nextLook, false), true, "prepared coordinate click bypassed the visual postcondition guard");
assert.equal(transactionNeedsVerifiedVisualDelivery([{ action: "click", ref: editor.ref }], { ...nextLook, image: undefined }, false), true, "semantic text-input click incorrectly required screenshot hydration");
const pictureTarget = { ...editor, ref: "@e-picture", wireRef: undefined, isTextInput: false, pictureOnly: true };
const pictureClick = prepareAction({ action: "click", ref: pictureTarget.ref }, { currentFocus: false }, { ...actionEnv, node: () => pictureTarget });
assert.equal(pictureClick.needsForeground, true, "picture-only clicks should use foreground pointer delivery");
const preparedType = prepareAction({ action: "typeText", text: "hello" }, { currentFocus: true }, actionEnv);
assert.equal(preparedType.usesCurrentFocus, true, "focused typing did not preserve click-established focus");
const preparedSelect = prepareAction({ action: "select", ref: editor.ref }, { currentFocus: false }, actionEnv);
assert.equal(preparedSelect.establishesFocus, true, "semantic selection did not establish a focus chain");
assert.equal(preparedSelect.needsForeground, false, "semantic selection incorrectly required pointer delivery");
assert("ref" in preparedSelect.target, "semantic selection lost its immutable element grounding");
const preparedWait = prepareAction({ action: "wait", ms: 100_000 }, { currentFocus: true }, actionEnv);
assert.equal(preparedWait.params.ms, 60_000, "transaction wait did not enforce its public bound");
assert.equal(canRetryInForeground(preparedType, "didnt", false), true, "side-effect-free failed typing should retry in the foreground");
assert.equal(canRetryInForeground(preparedClick, "unknown", false), false, "ambiguous pointer actions must not be replayed");
assert.equal(outcomeAfterCheck("unknown", "verified"), "worked", "newly verified evidence did not prove the request worked");
assert.equal(outcomeAfterCheck("unknown", "preexisting"), "unknown", "preexisting evidence incorrectly proved the request worked");
assert.equal(outcomeAfterCheck("worked", "failed"), "didnt", "failed verification did not override delivery success");
assert.equal(outcomeAfterObservedValues("didnt", [{ action: "setText", ref: "@e1", text: "saved" }], () => "saved"), "worked", "resulting state did not override stale immediate setText evidence");
assert.equal(outcomeAfterObservedValues("didnt", [{ action: "setText", ref: "@e1", text: "saved" }], () => "old"), "didnt", "mismatched resulting value incorrectly proved setText worked");
assert.equal(outcomeAfterObservedTransition("unknown", [{ action: "press", ref: "@e1" }], 1), "worked", "a changed successor did not verify a semantic press");
assert.equal(outcomeAfterObservedTransition("unknown", [{ action: "moveMouse", ref: "@e1" }], 1), "unknown", "visual cursor motion was incorrectly treated as a UI outcome");
assert.equal(outcomeAfterObservedTransition("didnt", [{ action: "press", ref: "@e1" }], 1), "didnt", "implicit successor evidence overrode explicit negative evidence");

const pagedBase = rawLook("paged-base", [{
	ref: "paged-container",
	role: "AXList",
	title: "Large collection",
	truncated: true,
	childCount: 4,
	nextChildIndex: 2,
	children: [
		{ ref: "page-item-0", role: "AXRow", title: "Item 0" },
		{ ref: "page-item-1", role: "AXRow", title: "Item 1" },
	],
}]);
const pagedTarget = pagedBase.parsedOutline.nodes.find((node) => node.wireRef === "paged-container");
assert(pagedTarget, "paged continuation fixture was not parsed");
assert.equal(pagedTarget.childCount, 4, "child count continuation metadata was lost");
assert.equal(pagedTarget.nextChildIndex, 2, "next child continuation offset was lost");
const pagedContinuation = rawLook("paged-continuation", [
	{ ref: "page-item-2", role: "AXRow", title: "Item 2" },
	{ ref: "page-item-3", role: "AXRow", title: "Item 3" },
]);
pagedContinuation.parsedOutline.root.role = "AXList";
pagedContinuation.parsedOutline.root.title = "Large collection";
pagedContinuation.parsedOutline.root.truncated = false;
pagedContinuation.parsedOutline.root.childCount = 4;
pagedContinuation.parsedOutline.root.nextChildIndex = undefined;
graftScopedOutline(pagedBase.parsedOutline, pagedTarget.ref, pagedContinuation.parsedOutline, { append: true });
assert.deepEqual(pagedTarget.children.map((node) => node.title), ["Item 0", "Item 1", "Item 2", "Item 3"], "continued child page did not append in source order");
assert.equal(pagedTarget.truncated, false, "completed continuation remained truncated");
assert.equal(pagedTarget.nextChildIndex, undefined, "completed continuation retained a stale offset");

const rebindBase = rawLook("rebind-base", [
	{ ref: "old-search", role: "AXTextField", title: "Search", identifier: "search-input", rect: { x: 100, y: 50, w: 300, h: 30 } },
]);
const rebindFresh = rawLook("rebind-fresh", [
	{ ref: "new-search", role: "AXTextField", title: "Search", identifier: "search-input", rect: { x: 110, y: 50, w: 300, h: 30 } },
]);
const oldSearch = rebindBase.parsedOutline.nodes.find((node) => node.wireRef === "old-search");
const newSearch = rebindFresh.parsedOutline.nodes.find((node) => node.wireRef === "new-search");
assert(oldSearch && newSearch, "rebind fixture was not parsed");
const rebound = rebindActParams({
	stateId: "stale-state",
	actions: [{ action: "setText", ref: oldSearch.ref, text: "Anirudh" }],
	guards: [{ kind: "exists", ref: oldSearch.ref, scopeRef: oldSearch.ref }],
	expect: { kind: "value", ref: oldSearch.ref, value: "Anirudh" },
}, rebindBase.parsedOutline, rebindFresh.parsedOutline, "fresh-state");
assert.equal(rebound.params.stateId, "fresh-state", "stale recovery retained the stale state id");
assert.equal(rebound.params.actions[0].ref, newSearch.ref, "stale action ref was not rebound");
assert.equal(rebound.params.guards[0].ref, newSearch.ref, "stale guard ref was not rebound");
assert.equal(rebound.params.guards[0].scopeRef, newSearch.ref, "stale guard scope was not rebound");
assert.equal(rebound.params.expect.ref, newSearch.ref, "stale expectation ref was not rebound");
assert.equal(rebound.mappings[0].matchedBy, "identifier_role", "stable identifier was not preferred for rebinding");

const geometryBase = rawLook("geometry-base", [
	{ ref: "old-row", role: "AXButton", title: "Play", rect: { x: 50, y: 50, w: 20, h: 20 } },
]);
const geometryFresh = rawLook("geometry-fresh", [
	{ ref: "row-near", role: "AXButton", title: "Play", rect: { x: 52, y: 50, w: 20, h: 20 } },
	{ ref: "row-far", role: "AXButton", title: "Play", rect: { x: 500, y: 50, w: 20, h: 20 } },
]);
const oldRow = geometryBase.parsedOutline.nodes.find((node) => node.wireRef === "old-row");
const nearRow = geometryFresh.parsedOutline.nodes.find((node) => node.wireRef === "row-near");
assert(oldRow && nearRow, "geometry rebind fixture was not parsed");
const geometryRebound = rebindActParams({ stateId: "old", actions: [{ action: "press", ref: oldRow.ref }] }, geometryBase.parsedOutline, geometryFresh.parsedOutline, "new");
assert.equal(geometryRebound.params.actions[0].ref, nearRow.ref, "geometry tie-breaker selected the wrong semantic peer");
assert.equal(geometryRebound.mappings[0].matchedBy, "geometry_tiebreaker", "ambiguous semantic peers did not use geometry only as a tie-breaker");

const ambiguousFresh = rawLook("ambiguous-fresh", [
	{ ref: "row-a", role: "AXButton", title: "Play", rect: { x: 40, y: 50, w: 20, h: 20 } },
	{ ref: "row-b", role: "AXButton", title: "Play", rect: { x: 60, y: 50, w: 20, h: 20 } },
]);
assert.throws(
	() => rebindActParams({ stateId: "old", actions: [{ action: "press", ref: oldRow.ref }] }, geometryBase.parsedOutline, ambiguousFresh.parsedOutline, "new"),
	(error) => error instanceof TargetRebindError && error.delivery === "definitely_not_delivered",
	"ambiguous stale target was guessed instead of failing closed",
);

const schedulerDirectory = mkdtempSync(path.join(os.tmpdir(), "scua-runtime-test-"));
const scheduler = new ResourceScheduler({ sharedDirectory: schedulerDirectory, sessionId: "scheduler-a" });
const peerScheduler = new ResourceScheduler({ sharedDirectory: schedulerDirectory, sessionId: "scheduler-b" });
let active = 0;
let peak = 0;
const work = async () => {
	active += 1;
	peak = Math.max(peak, active);
	await sleep(25);
	active -= 1;
};
await Promise.all([
	scheduler.read("pid:1", work),
	scheduler.read("pid:2", work),
]);
assert.equal(peak, 2, "different resources did not overlap");

active = 0;
peak = 0;
await Promise.all([
	scheduler.read("pid:3", work),
	peerScheduler.read("pid:3", work),
]);
assert.equal(peak, 1, "same-resource operations overlapped across scheduler processes");

active = 0;
peak = 0;
await Promise.all([
	scheduler.writeWithClaims("desktop-window:7:a", 0, ["desktop-app:7"], async () => await work()),
	peerScheduler.writeWithClaims("desktop-window:7:b", 0, ["desktop-app:7"], async () => await work()),
]);
assert.equal(peak, 1, "different windows in one app bypassed the application-scoped mutation claim");

active = 0;
peak = 0;
await Promise.all([
	scheduler.read("desktop-window:7:a", async () => await work()),
	peerScheduler.read("desktop-window:7:b", async () => await work()),
]);
assert.equal(peak, 2, "window-local reads in one application were unnecessarily serialized");

active = 0;
peak = 0;
await Promise.all([
	scheduler.writeWithClaims("desktop-window:8:a", 0, ["desktop-app:8"], async () => await work()),
	peerScheduler.writeWithClaims("desktop-window:9:a", 0, ["desktop-app:9"], async () => await work()),
]);
assert.equal(peak, 2, "application-scoped claims serialized independent applications");

await scheduler.write("pid:4", 0, async () => undefined);
await assert.rejects(
	() => peerScheduler.readAt("pid:4", 0, async () => undefined),
	(error) => error instanceof StaleResourceStateError,
);
await assert.rejects(
	() => scheduler.write("pid:4", 0, async () => undefined),
	(error) => error instanceof StaleResourceStateError,
);

let guardedWorkRan = false;
await assert.rejects(
	() => scheduler.writeGuarded("pid:guarded", 0, [], async () => {
		throw new Error("guard rejected");
	}, async () => {
		guardedWorkRan = true;
	}),
	/guard rejected/,
);
assert.equal(guardedWorkRan, false, "guarded mutation dispatched after its guard failed");
assert.equal(scheduler.epoch("pid:guarded"), 0, "failed commit guard advanced the resource epoch");
await scheduler.writeGuarded("pid:guarded", 0, [], async () => undefined, async () => {
	guardedWorkRan = true;
});
assert.equal(guardedWorkRan, true, "satisfied commit guard did not dispatch");
assert.equal(scheduler.epoch("pid:guarded"), 1, "successful guarded mutation did not advance the epoch");

const liveOwnerKey = "pid:live-owner";
const liveOwnerDigest = createHash("sha256").update(liveOwnerKey).digest("hex");
const liveOwnerLock = path.join(schedulerDirectory, `${liveOwnerDigest}.lock`);
mkdirSync(liveOwnerLock, { mode: 0o700 });
writeFileSync(path.join(liveOwnerLock, "owner.json"), JSON.stringify({ pid: process.pid, sessionId: "still-live", createdAt: 0, expiresAt: 0 }));
const impatientScheduler = new ResourceScheduler({ sharedDirectory: schedulerDirectory, sessionId: "impatient", lockTimeoutMs: 1_000 });
await assert.rejects(
	() => impatientScheduler.read(liveOwnerKey, async () => undefined),
	/Timed out waiting for SCUA resource lease/,
	"an expired lease owned by a live process was stolen",
);
await impatientScheduler.close();
rmSync(liveOwnerLock, { recursive: true, force: true });

const reusedPidKey = "pid:reused-owner";
const reusedPidDigest = createHash("sha256").update(reusedPidKey).digest("hex");
const reusedPidLock = path.join(schedulerDirectory, `${reusedPidDigest}.lock`);
mkdirSync(reusedPidLock, { mode: 0o700 });
writeFileSync(path.join(reusedPidLock, "owner.json"), JSON.stringify({ pid: process.pid, sessionId: "old-process", processToken: "obsolete-process-start", createdAt: 0, expiresAt: 0 }));
await scheduler.read(reusedPidKey, async () => undefined);
assert.equal(existsSync(reusedPidLock), false, "PID reuse fencing did not reclaim an obsolete process token");

const abandonedOwnerKey = "pid:abandoned-owner";
const abandonedOwnerDigest = createHash("sha256").update(abandonedOwnerKey).digest("hex");
const abandonedOwnerLock = path.join(schedulerDirectory, `${abandonedOwnerDigest}.lock`);
mkdirSync(abandonedOwnerLock, { mode: 0o700 });
writeFileSync(path.join(abandonedOwnerLock, "owner.json"), JSON.stringify({ pid: 999_999_999, sessionId: "dead", token: "dead-token", createdAt: 0, expiresAt: 0 }));
active = 0;
peak = 0;
await Promise.all([
	scheduler.read(abandonedOwnerKey, work),
	peerScheduler.read(abandonedOwnerKey, work),
]);
assert.equal(peak, 1, "two waiters overlapped while reclaiming the same abandoned lease");

await scheduler.close();
await peerScheduler.close();
rmSync(schedulerDirectory, { recursive: true, force: true });
console.log("Runtime concurrency checks passed.");
