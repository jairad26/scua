import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type RecoveryAction = "reobserve" | "reacquire" | "unsupported" | "abort";

export class OwnershipError extends Error {
	readonly code: "ownership_required" | "resource_owned" | "resource_busy" | "lease_invalid" | "actor_invalid" | "budget_exhausted";
	readonly resourceKey?: string;
	readonly actorId?: string;
	readonly retryable: boolean;
	readonly recovery: RecoveryAction;

	constructor(code: OwnershipError["code"], message: string, options: { resourceKey?: string; actorId?: string; retryable?: boolean; recovery?: RecoveryAction } = {}) {
		super(message);
		this.name = "OwnershipError";
		this.code = code;
		this.resourceKey = options.resourceKey;
		this.actorId = options.actorId;
		this.retryable = options.retryable ?? false;
		this.recovery = options.recovery ?? "abort";
	}
}

interface ActorSession {
	actorId: string;
	token: string;
	createdAt: number;
	lastSeenAt: number;
	closedAt?: number;
	maxActions?: number;
	actionsUsed: number;
	deadlineAt?: number;
}

interface ResourceClaim {
	resourceKey: string;
	actorId: string;
	leaseId: string;
	generation: number;
	acquiredAt: number;
	expiresAt: number;
}

export interface ControlPlaneEvent {
	eventId: string;
	timestamp: number;
	type: "actor_created" | "actor_closed" | "acquired" | "renewed" | "released" | "handed_off" | "operation_started" | "operation_completed" | "operation_failed" | "operation_cancelled";
	actorId: string;
	resourceKey?: string;
	operationId?: string;
	tool?: string;
	details?: Record<string, unknown>;
}

const DEFAULT_ACTOR_ID = "default";
const MAX_ACTORS = 128;
const MAX_EVENTS = 4_096;
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 5 * 60_000;

class ControlPlane {
	private readonly actorsByToken = new Map<string, ActorSession>();
	private readonly actorsById = new Map<string, ActorSession>();
	private readonly claims = new Map<string, ResourceClaim>();
	private readonly activeMutations = new Map<string, number>();
	private readonly events: ControlPlaneEvent[] = [];
	readonly defaultActor: ActorSession;

	constructor() {
		const now = Date.now();
		this.defaultActor = { actorId: DEFAULT_ACTOR_ID, token: randomUUID(), createdAt: now, lastSeenAt: now, actionsUsed: 0 };
		this.actorsByToken.set(this.defaultActor.token, this.defaultActor);
		this.actorsById.set(this.defaultActor.actorId, this.defaultActor);
	}

	actor(token?: string): ActorSession {
		const actor = token ? this.actorsByToken.get(token) : this.defaultActor;
		if (!actor || actor.closedAt) throw new OwnershipError("actor_invalid", "The SCUA actor session is invalid or closed.", { recovery: "abort" });
		actor.lastSeenAt = Date.now();
		return actor;
	}

	createActor(options: { maxActions?: number; ttlMs?: number } = {}): { actorId: string; actorToken: string; createdAt: number; deadlineAt?: number; maxActions?: number } {
		this.gc();
		if ([...this.actorsById.values()].filter((actor) => !actor.closedAt).length >= MAX_ACTORS) {
			throw new OwnershipError("budget_exhausted", `SCUA supports at most ${MAX_ACTORS} live logical actors.`, { recovery: "abort" });
		}
		const now = Date.now();
		const actorId = `actor-${randomUUID()}`;
		const token = randomUUID();
		const maxActions = options.maxActions === undefined ? undefined : Math.max(1, Math.min(100_000, Math.trunc(options.maxActions)));
		const ttlMs = options.ttlMs === undefined ? undefined : Math.max(1_000, Math.min(24 * 60 * 60_000, Math.trunc(options.ttlMs)));
		const actor: ActorSession = { actorId, token, createdAt: now, lastSeenAt: now, actionsUsed: 0, maxActions, deadlineAt: ttlMs ? now + ttlMs : undefined };
		this.actorsByToken.set(token, actor);
		this.actorsById.set(actorId, actor);
		this.emit("actor_created", actorId, { details: { maxActions, deadlineAt: actor.deadlineAt } });
		return { actorId, actorToken: token, createdAt: now, deadlineAt: actor.deadlineAt, maxActions };
	}

	closeActor(actor: ActorSession): void {
		if (actor.actorId === DEFAULT_ACTOR_ID) throw new OwnershipError("actor_invalid", "The default SCUA actor cannot be closed.");
		actor.closedAt = Date.now();
		for (const [key, claim] of this.claims) {
			if (claim.actorId === actor.actorId && (this.activeMutations.get(key) ?? 0) === 0) this.claims.delete(key);
		}
		this.emit("actor_closed", actor.actorId);
	}

	acquire(actor: ActorSession, resourceKey: string, ttlMs = DEFAULT_TTL_MS): ResourceClaim {
		this.validateActorBudget(actor, false);
		const now = Date.now();
		const existing = this.liveClaim(resourceKey, now);
		if (existing && existing.actorId !== actor.actorId) {
			throw new OwnershipError("resource_owned", `Resource '${resourceKey}' is owned by ${existing.actorId}.`, { resourceKey, actorId: actor.actorId, retryable: true, recovery: "reacquire" });
		}
		const claim: ResourceClaim = existing ?? { resourceKey, actorId: actor.actorId, leaseId: randomUUID(), generation: 1, acquiredAt: now, expiresAt: now };
		claim.expiresAt = now + this.ttl(ttlMs);
		this.claims.set(resourceKey, claim);
		this.emit(existing ? "renewed" : "acquired", actor.actorId, { resourceKey, details: { leaseId: claim.leaseId, generation: claim.generation, expiresAt: claim.expiresAt } });
		return { ...claim };
	}

	renew(actor: ActorSession, resourceKey: string, leaseId: string, ttlMs = DEFAULT_TTL_MS): ResourceClaim {
		const claim = this.requireClaim(actor, resourceKey, leaseId);
		claim.expiresAt = Date.now() + this.ttl(ttlMs);
		this.emit("renewed", actor.actorId, { resourceKey, details: { leaseId, generation: claim.generation, expiresAt: claim.expiresAt } });
		return { ...claim };
	}

	release(actor: ActorSession, resourceKey: string, leaseId: string): void {
		this.requireClaim(actor, resourceKey, leaseId);
		this.assertNotInFlight(resourceKey, actor.actorId);
		this.claims.delete(resourceKey);
		this.emit("released", actor.actorId, { resourceKey, details: { leaseId } });
	}

	handoff(actor: ActorSession, resourceKey: string, leaseId: string, recipientActorId: string, ttlMs = DEFAULT_TTL_MS): ResourceClaim {
		const previous = this.requireClaim(actor, resourceKey, leaseId);
		this.assertNotInFlight(resourceKey, actor.actorId);
		const recipient = this.actorsById.get(recipientActorId);
		if (!recipient || recipient.closedAt) throw new OwnershipError("actor_invalid", `Recipient actor '${recipientActorId}' is invalid or closed.`);
		const claim: ResourceClaim = {
			resourceKey,
			actorId: recipient.actorId,
			leaseId: randomUUID(),
			generation: previous.generation + 1,
			acquiredAt: Date.now(),
			expiresAt: Date.now() + this.ttl(ttlMs),
		};
		this.claims.set(resourceKey, claim);
		this.emit("handed_off", actor.actorId, { resourceKey, details: { fromActorId: actor.actorId, toActorId: recipient.actorId, generation: claim.generation } });
		return { ...claim };
	}

	assertMutation(actor: ActorSession, resourceKey: string): void {
		this.validateActorBudget(actor, true);
		const claim = this.liveClaim(resourceKey);
		if (!claim) {
			if (actor.actorId === DEFAULT_ACTOR_ID) {
				this.acquire(actor, resourceKey);
				return;
			}
			throw new OwnershipError("ownership_required", `Actor ${actor.actorId} must acquire '${resourceKey}' before mutation.`, { resourceKey, actorId: actor.actorId, retryable: true, recovery: "reacquire" });
		}
		if (claim.actorId !== actor.actorId) throw new OwnershipError("resource_owned", `Resource '${resourceKey}' is owned by ${claim.actorId}.`, { resourceKey, actorId: actor.actorId, retryable: true, recovery: "reacquire" });
	}

	async withMutation<T>(actor: ActorSession, resourceKey: string, work: () => Promise<T>): Promise<T> {
		this.assertMutation(actor, resourceKey);
		this.activeMutations.set(resourceKey, (this.activeMutations.get(resourceKey) ?? 0) + 1);
		try {
			return await work();
		} finally {
			const remaining = (this.activeMutations.get(resourceKey) ?? 1) - 1;
			if (remaining <= 0) {
				this.activeMutations.delete(resourceKey);
				const claim = this.claims.get(resourceKey);
				const owner = claim ? this.actorsById.get(claim.actorId) : undefined;
				if (claim && (!owner || owner.closedAt || (owner.deadlineAt && owner.deadlineAt <= Date.now()))) this.claims.delete(resourceKey);
			}
			else this.activeMutations.set(resourceKey, remaining);
		}
	}

	claimNewResource(actor: ActorSession, resourceKey: string): ResourceClaim {
		return this.acquire(actor, resourceKey);
	}

	startOperation(actor: ActorSession, tool: string): string {
		const operationId = randomUUID();
		this.emit("operation_started", actor.actorId, { operationId, tool });
		return operationId;
	}

	finishOperation(actor: ActorSession, operationId: string, tool: string, status: "completed" | "failed" | "cancelled", details?: Record<string, unknown>): void {
		this.emit(status === "completed" ? "operation_completed" : status === "cancelled" ? "operation_cancelled" : "operation_failed", actor.actorId, { operationId, tool, details });
	}

	status(actor: ActorSession): Record<string, unknown> {
		this.gc();
		return {
			actorId: actor.actorId,
			createdAt: actor.createdAt,
			deadlineAt: actor.deadlineAt,
			maxActions: actor.maxActions,
			actionsUsed: actor.actionsUsed,
			claims: [...this.claims.values()].filter((claim) => claim.actorId === actor.actorId).map((claim) => ({ ...claim })),
			recentEvents: this.events.filter((event) => event.actorId === actor.actorId).slice(-100),
			coordinator: this.diagnostics(),
		};
	}

	diagnostics(): Record<string, number> {
		this.gc();
		return {
			liveActors: [...this.actorsById.values()].filter((candidate) => !candidate.closedAt).length,
			claims: this.claims.size,
			activeMutations: [...this.activeMutations.values()].reduce((sum, count) => sum + count, 0),
			retainedEvents: this.events.length,
		};
	}

	allEvents(): ControlPlaneEvent[] {
		return this.events.slice();
	}

	private validateActorBudget(actor: ActorSession, consume: boolean): void {
		if (actor.deadlineAt && Date.now() >= actor.deadlineAt) throw new OwnershipError("budget_exhausted", `Actor ${actor.actorId} exceeded its time budget.`, { actorId: actor.actorId, recovery: "abort" });
		if (actor.maxActions !== undefined && actor.actionsUsed >= actor.maxActions) throw new OwnershipError("budget_exhausted", `Actor ${actor.actorId} exhausted its action budget.`, { actorId: actor.actorId, recovery: "abort" });
		if (consume) actor.actionsUsed += 1;
	}

	private liveClaim(resourceKey: string, now = Date.now()): ResourceClaim | undefined {
		const claim = this.claims.get(resourceKey);
		const owner = claim ? this.actorsById.get(claim.actorId) : undefined;
		const ownerUnavailable = Boolean(claim && (!owner || owner.closedAt || (owner.deadlineAt && owner.deadlineAt <= now)));
		if (claim && (claim.expiresAt <= now || ownerUnavailable) && (this.activeMutations.get(resourceKey) ?? 0) === 0) {
			this.claims.delete(resourceKey);
			return undefined;
		}
		return claim;
	}

	private requireClaim(actor: ActorSession, resourceKey: string, leaseId: string): ResourceClaim {
		const claim = this.liveClaim(resourceKey);
		if (!claim || claim.actorId !== actor.actorId || claim.leaseId !== leaseId) {
			throw new OwnershipError("lease_invalid", `Lease '${leaseId}' does not authorize ${actor.actorId} for '${resourceKey}'.`, { resourceKey, actorId: actor.actorId, retryable: true, recovery: "reacquire" });
		}
		return claim;
	}

	private assertNotInFlight(resourceKey: string, actorId: string): void {
		if ((this.activeMutations.get(resourceKey) ?? 0) > 0) {
			throw new OwnershipError("resource_busy", `Resource '${resourceKey}' has an in-flight mutation and cannot be released or handed off yet.`, { resourceKey, actorId, retryable: true, recovery: "reacquire" });
		}
	}

	private ttl(value: number): number {
		return Math.max(1_000, Math.min(MAX_TTL_MS, Math.trunc(value)));
	}

	private emit(type: ControlPlaneEvent["type"], actorId: string, fields: Partial<ControlPlaneEvent> = {}): void {
		this.events.push({ eventId: randomUUID(), timestamp: Date.now(), type, actorId, ...fields });
		while (this.events.length > MAX_EVENTS) this.events.shift();
	}

	private gc(): void {
		const now = Date.now();
		for (const key of this.claims.keys()) this.liveClaim(key, now);
		for (const [id, actor] of this.actorsById) {
			if (id === DEFAULT_ACTOR_ID || !actor.closedAt || now - actor.closedAt < 60_000) continue;
			this.actorsById.delete(id);
			this.actorsByToken.delete(actor.token);
		}
	}
}

export const scuaControlPlane = new ControlPlane();
const actorContext = new AsyncLocalStorage<ActorSession>();

export function currentActor(): ActorSession {
	return actorContext.getStore() ?? scuaControlPlane.defaultActor;
}

export function currentActorId(): string {
	return currentActor().actorId;
}

export async function runAsActor<T>(token: string | undefined, work: () => Promise<T>): Promise<T> {
	const actor = scuaControlPlane.actor(token);
	return await actorContext.run(actor, work);
}

export function assertCurrentActorMutation(resourceKey: string): void {
	scuaControlPlane.assertMutation(currentActor(), resourceKey);
}

export async function withCurrentActorMutation<T>(resourceKey: string, work: () => Promise<T>): Promise<T> {
	return await scuaControlPlane.withMutation(currentActor(), resourceKey, work);
}

export function claimCurrentActorResource(resourceKey: string): ResourceClaim {
	return scuaControlPlane.claimNewResource(currentActor(), resourceKey);
}
