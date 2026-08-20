import { randomUUID } from "node:crypto";
import type { UiCondition } from "./contract.ts";

export type UiSubscriptionSource = "native_ax" | "browser_dom";
export type UiSubscriptionEventType = "ui_changed" | "condition_met" | "overflow" | "source_error" | "ownership_lost" | "closed";

export interface UiSubscriptionEvent {
	subscriptionId: string;
	actorId: string;
	sequence: number;
	traceId: string;
	timestamp: number;
	type: UiSubscriptionEventType;
	resourceKey: string;
	resourceEpoch: number;
	details?: Record<string, unknown>;
}

export interface UiSubscriptionRecord {
	subscriptionId: string;
	actorId: string;
	resourceKey: string;
	resourceEpoch: number;
	leaseId: string;
	leaseGeneration: number;
	leaseExpiresAt: number;
	stateId: string;
	source: UiSubscriptionSource;
	sourceCursor: number;
	condition?: UiCondition;
	conditionSatisfied?: boolean;
	label?: string;
	createdAt: number;
	lastReadAt: number;
	active: boolean;
	terminalReason?: string;
	events: UiSubscriptionEvent[];
	nextSequence: number;
	droppedThroughSequence: number;
	cursorSecret: string;
}

export interface UiSubscriptionCreateInput {
	actorId: string;
	resourceKey: string;
	resourceEpoch: number;
	leaseId: string;
	leaseGeneration: number;
	leaseExpiresAt: number;
	stateId: string;
	source: UiSubscriptionSource;
	sourceCursor: number;
	condition?: UiCondition;
	conditionSatisfied?: boolean;
	label?: string;
}

export interface UiSubscriptionReadResult {
	record: UiSubscriptionRecord;
	events: UiSubscriptionEvent[];
	nextCursor: string;
	overflow: boolean;
	hasMore: boolean;
}

export class UiSubscriptionError extends Error {
	readonly code: "subscription_unavailable" | "subscription_owned" | "cursor_invalid";

	constructor(code: UiSubscriptionError["code"], message: string) {
		super(message);
		this.name = "UiSubscriptionError";
		this.code = code;
	}
}

export const MAX_UI_SUBSCRIPTIONS = 512;
export const MAX_UI_EVENTS_PER_SUBSCRIPTION = 256;
export const INACTIVE_UI_SUBSCRIPTION_RETENTION_MS = 5 * 60_000;

function cancelledReadError(): Error & { delivery: "definitely_not_delivered" } {
	const error = new Error("Operation aborted.") as Error & { delivery: "definitely_not_delivered" };
	error.delivery = "definitely_not_delivered";
	return error;
}

/**
 * Request-independent, actor-scoped event storage. A subscription survives
 * individual MCP calls and transport reconnects while the owning SCUA server
 * process and actor session remain alive. Cursors are opaque and bound to one
 * subscription secret, so callers cannot use sequence guesses across actors.
 */
export class UiSubscriptionStore {
	private readonly records = new Map<string, UiSubscriptionRecord>();
	private readonly waiters = new Map<string, Set<() => void>>();

	create(input: UiSubscriptionCreateInput): { record: UiSubscriptionRecord; cursor: string } {
		this.gc();
		if ([...this.records.values()].filter((record) => record.active).length >= MAX_UI_SUBSCRIPTIONS) {
			throw new UiSubscriptionError("subscription_unavailable", `SCUA supports at most ${MAX_UI_SUBSCRIPTIONS} live UI subscriptions.`);
		}
		const subscriptionId = `sub-${randomUUID()}`;
		const record: UiSubscriptionRecord = {
			...input,
			subscriptionId,
			createdAt: Date.now(),
			lastReadAt: Date.now(),
			active: true,
			events: [],
			nextSequence: 1,
			droppedThroughSequence: 0,
			cursorSecret: randomUUID(),
		};
		this.records.set(subscriptionId, record);
		return { record, cursor: this.cursor(record, 0) };
	}

	get(subscriptionId: string, actorId: string): UiSubscriptionRecord {
		this.gc();
		const record = this.records.get(subscriptionId);
		if (!record) throw new UiSubscriptionError("subscription_unavailable", `UI subscription '${subscriptionId}' is unavailable or expired.`);
		if (record.actorId !== actorId) throw new UiSubscriptionError("subscription_owned", `UI subscription '${subscriptionId}' belongs to a different SCUA actor.`);
		return record;
	}

	append(subscriptionId: string, type: UiSubscriptionEventType, details?: Record<string, unknown>, resourceEpoch?: number): UiSubscriptionEvent | undefined {
		const record = this.records.get(subscriptionId);
		if (!record || (!record.active && !["ownership_lost", "closed", "source_error"].includes(type))) return undefined;
		if (resourceEpoch !== undefined) record.resourceEpoch = resourceEpoch;
		const sequence = record.nextSequence++;
		const event: UiSubscriptionEvent = {
			subscriptionId: record.subscriptionId,
			actorId: record.actorId,
			sequence,
			traceId: `${record.subscriptionId}:${sequence}`,
			timestamp: Date.now(),
			type,
			resourceKey: record.resourceKey,
			resourceEpoch: record.resourceEpoch,
			details,
		};
		record.events.push(event);
		while (record.events.length > MAX_UI_EVENTS_PER_SUBSCRIPTION) {
			const dropped = record.events.shift();
			if (dropped) record.droppedThroughSequence = dropped.sequence;
		}
		this.notify(subscriptionId);
		return event;
	}

	read(subscriptionId: string, actorId: string, encodedCursor: string, maxEvents = 64): UiSubscriptionReadResult {
		const record = this.get(subscriptionId, actorId);
		const sequence = this.parseCursor(record, encodedCursor);
		const boundedMaxEvents = Math.max(1, Math.min(128, Math.trunc(maxEvents)));
		const overflow = sequence < record.droppedThroughSequence;
		const firstSequence = overflow ? record.droppedThroughSequence : sequence;
		const retained = record.events.filter((event) => event.sequence > firstSequence);
		const overflowEvent: UiSubscriptionEvent[] = overflow ? [{
			subscriptionId: record.subscriptionId,
			actorId: record.actorId,
			sequence: record.droppedThroughSequence,
			traceId: `${record.subscriptionId}:overflow:${record.droppedThroughSequence}`,
			timestamp: Date.now(),
			type: "overflow",
			resourceKey: record.resourceKey,
			resourceEpoch: record.resourceEpoch,
			details: { droppedThroughSequence: record.droppedThroughSequence, recovery: "authoritative_refresh" },
		}] : [];
		const retainedLimit = Math.max(0, boundedMaxEvents - overflowEvent.length);
		const events = [...overflowEvent, ...retained.slice(0, retainedLimit)];
		const lastSequence = events.at(-1)?.sequence ?? firstSequence;
		record.lastReadAt = Date.now();
		return {
			record,
			events,
			nextCursor: this.cursor(record, lastSequence),
			overflow,
			hasMore: retained.length > retainedLimit,
		};
	}

	async waitForEvents(subscriptionId: string, actorId: string, encodedCursor: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const record = this.get(subscriptionId, actorId);
		const sequence = this.parseCursor(record, encodedCursor);
		if (record.events.some((event) => event.sequence > sequence) || sequence < record.droppedThroughSequence || !record.active || timeoutMs <= 0) return;
		if (signal?.aborted) throw cancelledReadError();
		await new Promise<void>((resolve, reject) => {
			const waiters = this.waiters.get(subscriptionId) ?? new Set<() => void>();
			let timer: NodeJS.Timeout | undefined;
			const finish = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				waiters.delete(finish);
				if (waiters.size === 0) this.waiters.delete(subscriptionId);
				resolve();
			};
			const onAbort = () => {
				if (timer) clearTimeout(timer);
				waiters.delete(finish);
				if (waiters.size === 0) this.waiters.delete(subscriptionId);
				reject(cancelledReadError());
			};
			waiters.add(finish);
			this.waiters.set(subscriptionId, waiters);
			timer = setTimeout(finish, Math.max(0, Math.min(60_000, Math.trunc(timeoutMs))));
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	close(subscriptionId: string, actorId: string, reason = "unsubscribed"): UiSubscriptionRecord {
		const record = this.get(subscriptionId, actorId);
		if (record.active) {
			record.active = false;
			record.terminalReason = reason;
			this.append(subscriptionId, "closed", { reason });
		}
		this.notify(subscriptionId);
		return record;
	}

	invalidateResource(resourceKey: string, actorId: string, reason: string, details?: Record<string, unknown>): string[] {
		const invalidated: string[] = [];
		for (const record of this.records.values()) {
			if (!record.active || record.resourceKey !== resourceKey || record.actorId !== actorId) continue;
			record.active = false;
			record.terminalReason = reason;
			this.append(record.subscriptionId, "ownership_lost", { reason, ...details });
			this.notify(record.subscriptionId);
			invalidated.push(record.subscriptionId);
		}
		return invalidated;
	}

	closeActor(actorId: string, reason = "actor_closed"): string[] {
		const closed: string[] = [];
		for (const record of this.records.values()) {
			if (!record.active || record.actorId !== actorId) continue;
			record.active = false;
			record.terminalReason = reason;
			this.append(record.subscriptionId, "closed", { reason });
			this.notify(record.subscriptionId);
			closed.push(record.subscriptionId);
		}
		return closed;
	}

	closeAll(reason = "session_shutdown"): string[] {
		const closed: string[] = [];
		for (const record of this.records.values()) {
			if (!record.active) continue;
			record.active = false;
			record.terminalReason = reason;
			this.append(record.subscriptionId, "closed", { reason });
			this.notify(record.subscriptionId);
			closed.push(record.subscriptionId);
		}
		return closed;
	}

	diagnostics(): { subscriptions: number; activeSubscriptions: number; retainedUiEvents: number } {
		this.gc();
		const records = [...this.records.values()];
		return {
			subscriptions: records.length,
			activeSubscriptions: records.filter((record) => record.active).length,
			retainedUiEvents: records.reduce((sum, record) => sum + record.events.length, 0),
		};
	}

	private cursor(record: UiSubscriptionRecord, sequence: number): string {
		return Buffer.from(JSON.stringify({ s: record.subscriptionId, q: sequence, k: record.cursorSecret }), "utf8").toString("base64url");
	}

	private parseCursor(record: UiSubscriptionRecord, encoded: string): number {
		try {
			const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { s?: unknown; q?: unknown; k?: unknown };
			if (parsed.s !== record.subscriptionId || parsed.k !== record.cursorSecret || !Number.isSafeInteger(parsed.q) || Number(parsed.q) < 0) throw new Error("invalid");
			return Number(parsed.q);
		} catch {
			throw new UiSubscriptionError("cursor_invalid", "The UI event cursor is invalid or belongs to another subscription.");
		}
	}

	private notify(subscriptionId: string): void {
		for (const waiter of [...(this.waiters.get(subscriptionId) ?? [])]) waiter();
	}

	private gc(): void {
		const now = Date.now();
		for (const [subscriptionId, record] of this.records) {
			if (record.active || now - Math.max(record.lastReadAt, record.createdAt) < INACTIVE_UI_SUBSCRIPTION_RETENTION_MS) continue;
			this.records.delete(subscriptionId);
			this.waiters.delete(subscriptionId);
		}
	}
}
