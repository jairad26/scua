import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CdpPageSnapshot } from "./cdp.ts";
import type { ImageMode } from "./contract.ts";
import type { WindowNote } from "./note.ts";
import { restoreOutline, serializeOutline, type LookResponse, type Outline, type SerializedOutline } from "./outline.ts";
import { StateStore, type StoredState } from "./runtime.ts";
import { currentActorId } from "./control-plane.ts";

interface StateTargetSnapshot {
	pid: number;
	windowId: number;
	windowRef?: string;
	nativeWindowRef?: string;
}

export interface CurrentTarget {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId: number;
	windowRef?: string;
	nativeWindowRef?: string;
}

export interface CurrentCapture {
	stateId: string;
	width: number;
	height: number;
	scaleFactor: number;
	timestamp: number;
}

export interface OperationState {
	currentTarget?: CurrentTarget;
	currentCapture?: CurrentCapture;
	currentStateTarget?: StateTargetSnapshot;
	currentImageMode?: ImageMode;
	currentLook?: LookResponse;
	currentOutline?: Outline;
	currentNote?: WindowNote;
	resourceKey?: string;
	epoch?: number;
	lastSearchOcrEscalatedLookId?: string;
	browserSnapshot?: CdpPageSnapshot;
	contextId?: string;
}

interface DesktopObservation {
	kind: "desktop";
	actorId: string;
	target: CurrentTarget;
	capture: CurrentCapture;
	look: Omit<LookResponse, "parsedOutline" | "outline">;
	outline: SerializedOutline;
	note?: WindowNote;
	imageMode?: ImageMode;
}

interface BrowserObservation {
	kind: "browser";
	actorId: string;
	snapshot: CdpPageSnapshot;
	outline: SerializedOutline;
}

export type UiObservation = DesktopObservation | BrowserObservation;

export class SavedStates {
	readonly store = new StateStore<UiObservation>(512);
	readonly operations = new AsyncLocalStorage<OperationState>();
	private readonly stateIdsByActor = new Map<string, string[]>();
	// Adaptive plans may keep many independent root snapshots alive while their
	// branches run concurrently. Retain enough per actor to avoid evicting a
	// ready node's immutable input before it reaches the executor.
	private readonly perActorLimit = 64;

	current(): OperationState {
		const state = this.operations.getStore();
		if (!state) throw new Error("Computer-use operation state is unavailable.");
		return state;
	}

	get(stateId: string): StoredState<UiObservation> | undefined {
		const record = this.store.get(stateId);
		return record?.value.actorId === currentActorId() ? record : undefined;
	}

	set(record: StoredState<UiObservation>): void {
		if (record.value.actorId !== currentActorId()) throw new Error("Cannot store UI state for a different SCUA actor.");
		this.setForActor(record);
	}

	/** Mint a recipient-owned immutable desktop snapshot during an atomic lease
	 * handoff. The sender's state remains readable only by the sender and is
	 * still write-fenced by resource ownership. */
	transferLatestDesktop(resourceKey: string, fromActorId: string, toActorId: string): string | undefined {
		const ids = this.stateIdsByActor.get(fromActorId) ?? [];
		const source = ids.slice().reverse()
			.map((stateId) => this.store.get(stateId))
			.find((record) => record?.resourceKey === resourceKey && record.value.kind === "desktop");
		if (!source || source.value.kind !== "desktop") return undefined;
		const stateId = randomUUID();
		const value = structuredClone(source.value);
		value.actorId = toActorId;
		value.capture.stateId = stateId;
		this.setForActor({ ...source, stateId, value });
		return stateId;
	}

	private setForActor(record: StoredState<UiObservation>): void {
		this.store.set(record);
		const ids = this.stateIdsByActor.get(record.value.actorId) ?? [];
		const previous = ids.indexOf(record.stateId);
		if (previous >= 0) ids.splice(previous, 1);
		ids.push(record.stateId);
		while (ids.length > this.perActorLimit) this.store.delete(ids.shift()!);
		this.stateIdsByActor.set(record.value.actorId, ids);
	}

	clear(): void {
		this.store.clear();
		this.stateIdsByActor.clear();
	}

	hydrate(record: StoredState<UiObservation> | undefined): OperationState {
		if (!record) return {};
		if (record.value.kind === "browser") {
			const outline = restoreOutline(record.value.outline);
			return {
				currentCapture: { stateId: record.stateId, width: 0, height: 0, scaleFactor: 1, timestamp: record.value.snapshot.capturedAt },
				currentLook: {
					lookId: record.value.snapshot.snapshotId,
					capturedAt: record.value.snapshot.capturedAt / 1000,
					window: { windowId: 0, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1, isModal: false, role: "document", subrole: "" },
					outline: outline.root,
					timings: {},
					parsedOutline: outline,
				},
				currentOutline: outline,
				resourceKey: record.resourceKey,
				epoch: record.epoch,
				browserSnapshot: record.value.snapshot,
				contextId: record.value.snapshot.contextId,
			};
		}
		const outline = restoreOutline(record.value.outline);
		return {
			currentTarget: { ...record.value.target },
			currentCapture: { ...record.value.capture },
			currentStateTarget: { pid: record.value.target.pid, windowId: record.value.target.windowId, windowRef: record.value.target.windowRef, nativeWindowRef: record.value.target.nativeWindowRef },
			currentImageMode: record.value.imageMode,
			currentLook: { ...record.value.look, outline: outline.root, parsedOutline: outline },
			currentOutline: outline,
			currentNote: record.value.note ? structuredClone(record.value.note) : undefined,
			resourceKey: record.resourceKey,
			epoch: record.epoch,
		};
	}

	saveDesktop(state: OperationState, resourceKey: string, epoch: number): void {
		if (!state.currentTarget || !state.currentCapture || !state.currentLook || !state.currentOutline) return;
		this.set({
			stateId: state.currentCapture.stateId,
			resourceKey,
			epoch,
			value: {
				kind: "desktop",
				actorId: currentActorId(),
				target: { ...state.currentTarget },
				capture: { ...state.currentCapture },
				look: {
					lookId: state.currentLook.lookId,
					capturedAt: state.currentLook.capturedAt,
					window: structuredClone(state.currentLook.window),
					image: state.currentLook.image ? { ...state.currentLook.image } : undefined,
					timings: { ...state.currentLook.timings },
					readText: state.currentLook.readText ? { ...state.currentLook.readText } : undefined,
				},
				outline: serializeOutline(state.currentOutline),
				note: state.currentNote ? structuredClone(state.currentNote) : undefined,
				imageMode: state.currentImageMode,
			},
		});
	}
}
