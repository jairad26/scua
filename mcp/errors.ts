import { OwnershipError, currentActorId, type RecoveryAction } from "../src/control-plane.ts";
import { StaleResourceStateError } from "../src/runtime.ts";

export interface ScuaErrorEnvelope {
	code: string;
	message: string;
	actorId: string;
	resourceKey?: string;
	expectedEpoch?: number;
	actualEpoch?: number;
	retryable: boolean;
	delivery: "definitely_not_delivered" | "may_have_been_delivered" | "completed";
	recovery: RecoveryAction;
	evidence?: Record<string, unknown>;
}

export function scuaErrorEnvelope(error: unknown, cancelled = false): ScuaErrorEnvelope {
	const message = error instanceof Error ? error.message : String(error);
	const enriched = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
	if (cancelled || /\babort(?:ed|ion)?\b/i.test(message)) {
		const delivery = enriched?.delivery === "definitely_not_delivered" || enriched?.delivery === "may_have_been_delivered"
			? enriched.delivery
			: "may_have_been_delivered";
		return {
			code: "cancelled",
			message,
			actorId: currentActorId(),
			resourceKey: typeof enriched?.resourceKey === "string" ? enriched.resourceKey : undefined,
			retryable: delivery === "definitely_not_delivered",
			delivery,
			recovery: delivery === "definitely_not_delivered" ? "reobserve" : "abort",
			evidence: enriched?.evidence && typeof enriched.evidence === "object" ? enriched.evidence as Record<string, unknown> : undefined,
		};
	}
	if (typeof enriched?.code === "string" && (enriched.delivery === "definitely_not_delivered" || enriched.delivery === "may_have_been_delivered")) {
		const declaredRecovery = enriched.recovery;
		return {
			code: enriched.code,
			message,
			actorId: currentActorId(),
			resourceKey: typeof enriched.resourceKey === "string" ? enriched.resourceKey : undefined,
			retryable: enriched.delivery === "definitely_not_delivered",
			delivery: enriched.delivery,
			recovery: declaredRecovery === "reobserve" || declaredRecovery === "reacquire" || declaredRecovery === "unsupported" || declaredRecovery === "abort"
				? declaredRecovery
				: enriched.delivery === "definitely_not_delivered" ? "reobserve" : "abort",
			evidence: enriched.evidence && typeof enriched.evidence === "object" ? enriched.evidence as Record<string, unknown> : undefined,
		};
	}
	if (enriched?.code === "user_active") {
		return { code: "user_active", message, actorId: currentActorId(), retryable: true, delivery: "definitely_not_delivered", recovery: "reacquire" };
	}
	if (error instanceof StaleResourceStateError) {
		return { code: "stale_state", message, actorId: currentActorId(), resourceKey: error.resourceKey, expectedEpoch: error.expectedEpoch, actualEpoch: error.actualEpoch, retryable: true, delivery: "definitely_not_delivered", recovery: "reobserve" };
	}
	if (error instanceof OwnershipError) {
		return { code: error.code, message, actorId: error.actorId ?? currentActorId(), resourceKey: error.resourceKey, retryable: error.retryable, delivery: "definitely_not_delivered", recovery: error.recovery };
	}
	if (typeof enriched?.code === "string") {
		const definitelyNotDelivered = new Set(["foreground_required", "stale_look", "stale_ref", "invalid_args", "coordinate_unavailable", "coordinate_unavailable_for_root", "occluded_target", "root_not_found", "element_ref_invalid", "subscription_unavailable", "subscription_owned", "cursor_invalid", "event_source_unavailable"]);
		const unsupported = enriched.code === "foreground_required" || enriched.code === "coordinate_unavailable_for_root";
		return {
			code: enriched.code,
			message,
			actorId: currentActorId(),
			resourceKey: typeof enriched.resourceKey === "string" ? enriched.resourceKey : undefined,
			retryable: definitelyNotDelivered.has(enriched.code) && !unsupported,
			delivery: definitelyNotDelivered.has(enriched.code) ? "definitely_not_delivered" : "may_have_been_delivered",
			recovery: unsupported ? "unsupported" : definitelyNotDelivered.has(enriched.code) ? "reobserve" : "abort",
		};
	}
	if (/target root changed after observation/i.test(message)) {
		return { code: "target_changed", message, actorId: currentActorId(), retryable: true, delivery: "definitely_not_delivered", recovery: "reobserve" };
	}
	if (/unavailable or was evicted|observe (?:the root|again)|state .* unavailable/i.test(message)) {
		return { code: "state_unavailable", message, actorId: currentActorId(), retryable: true, delivery: "definitely_not_delivered", recovery: "reobserve" };
	}
	if (/timed out waiting for SCUA resource lease/i.test(message)) {
		return { code: "resource_busy", message, actorId: currentActorId(), retryable: true, delivery: "definitely_not_delivered", recovery: "reacquire" };
	}
	const genericOwnership = message.match(/^Resource '([^']+)' is owned by\b/i);
	if (genericOwnership || /Browser root is owned by a different SCUA actor/i.test(message)) {
		return {
			code: "resource_owned",
			message,
			actorId: currentActorId(),
			resourceKey: genericOwnership?.[1],
			retryable: true,
			delivery: "definitely_not_delivered",
			recovery: "reacquire",
		};
	}
	if (/foreground|required|unsupported|cannot.*background|does not support/i.test(message)) {
		return { code: "unsupported_background", message, actorId: currentActorId(), retryable: false, delivery: "definitely_not_delivered", recovery: "unsupported" };
	}
	return { code: "operation_failed", message, actorId: currentActorId(), retryable: false, delivery: "may_have_been_delivered", recovery: "abort" };
}
