import type { ActParams, UiAction, UiCondition } from "./contract.ts";
import { nodeByRef, outlineNodeLabel, type Outline, type OutlineNode, type OutlineRect } from "./outline.ts";

export interface ReboundReference {
	from: string;
	to: string;
	matchedBy: "wire_ref" | "identifier_role" | "structural_path" | "geometry_tiebreaker";
}

export class TargetRebindError extends Error {
	readonly code = "target_rebind_failed";
	readonly delivery = "definitely_not_delivered";
	readonly recovery = "abort";
	readonly evidence: Record<string, unknown>;

	constructor(message: string, evidence: Record<string, unknown>) {
		super(message);
		this.name = "TargetRebindError";
		this.evidence = evidence;
	}
}

interface TargetFingerprint {
	ref: string;
	wireRef?: string;
	role: string;
	identifier: string;
	label: string;
	editable: boolean;
	structuralPath: string;
	rect?: OutlineRect;
}

function normalized(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function structuralToken(node: OutlineNode): string {
	return [node.role, node.subrole, node.identifier, node.roleDescription, node.placeholder, outlineNodeLabel(node)].map(normalized).join("|");
}

function structuralPath(node: OutlineNode): string {
	const tokens: string[] = [];
	let current: OutlineNode | undefined = node;
	while (current) {
		tokens.unshift(structuralToken(current));
		current = current.parent;
	}
	return tokens.join(">");
}

function fingerprint(ref: string, outline: Outline): TargetFingerprint {
	const node = nodeByRef(outline, ref);
	if (!node) {
		throw new TargetRebindError(`Cannot rebind missing base ref '${ref}'.`, { ref, reason: "base_ref_missing" });
	}
	return {
		ref,
		wireRef: node.wireRef,
		role: normalized(node.role),
		identifier: normalized(node.identifier),
		label: normalized(outlineNodeLabel(node)),
		editable: node.isTextInput || node.canSetValue,
		structuralPath: structuralPath(node),
		rect: node.rect,
	};
}

function unique(candidates: OutlineNode[]): OutlineNode | undefined {
	return candidates.length === 1 ? candidates[0] : undefined;
}

function center(rect: OutlineRect): { x: number; y: number } {
	return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function geometryWinner(candidates: OutlineNode[], rect: OutlineRect | undefined): OutlineNode | undefined {
	if (!rect || candidates.length < 2 || candidates.some((candidate) => !candidate.rect)) return undefined;
	const target = center(rect);
	const ranked = candidates
		.map((candidate) => {
			const candidateCenter = center(candidate.rect!);
			return { candidate, distance: Math.hypot(candidateCenter.x - target.x, candidateCenter.y - target.y) };
		})
		.sort((left, right) => left.distance - right.distance);
	// Geometry is only a tie-breaker among otherwise identical semantic targets.
	// Refuse to guess when two candidates are effectively equidistant.
	if (!ranked[1] || ranked[1].distance - ranked[0].distance <= 1) return undefined;
	return ranked[0].candidate;
}

function matchFingerprint(target: TargetFingerprint, outline: Outline): ReboundReference {
	if (target.wireRef) {
		const node = outline.nodes.find((candidate) => candidate.wireRef === target.wireRef);
		if (node && normalized(node.role) === target.role && (!target.identifier || normalized(node.identifier) === target.identifier) && (target.editable || !target.label || normalized(outlineNodeLabel(node)) === target.label)) {
			return { from: target.ref, to: node.ref, matchedBy: "wire_ref" };
		}
	}

	if (target.identifier) {
		const node = unique(outline.nodes.filter((candidate) => normalized(candidate.role) === target.role && normalized(candidate.identifier) === target.identifier));
		if (node) return { from: target.ref, to: node.ref, matchedBy: "identifier_role" };
	}

	const structural = unique(outline.nodes.filter((candidate) => structuralPath(candidate) === target.structuralPath));
	if (structural) return { from: target.ref, to: structural.ref, matchedBy: "structural_path" };

	const semanticPeers = outline.nodes.filter((candidate) => normalized(candidate.role) === target.role && normalized(outlineNodeLabel(candidate)) === target.label);
	const geometric = geometryWinner(semanticPeers, target.rect);
	if (geometric) return { from: target.ref, to: geometric.ref, matchedBy: "geometry_tiebreaker" };

	throw new TargetRebindError(`Could not uniquely rebind stale target '${target.ref}'.`, {
		ref: target.ref,
		role: target.role,
		identifier: target.identifier || undefined,
		label: target.label || undefined,
		candidateCount: semanticPeers.length,
		reason: semanticPeers.length > 1 ? "ambiguous" : "not_found",
	});
}

function referencedRefs(params: ActParams): string[] {
	const refs = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value === "string" && value.trim()) refs.add(value.trim());
	};
	for (const action of params.actions ?? []) add(action.ref);
	for (const guard of params.guards ?? []) {
		add(guard.ref);
		add(guard.scopeRef);
	}
	add(params.expect?.ref);
	add(params.expect?.scopeRef);
	return [...refs];
}

function mapCondition(condition: UiCondition | undefined, refs: Map<string, string>): UiCondition | undefined {
	if (!condition) return undefined;
	return {
		...condition,
		...(condition.ref ? { ref: refs.get(condition.ref) ?? condition.ref } : {}),
		...(condition.scopeRef ? { scopeRef: refs.get(condition.scopeRef) ?? condition.scopeRef } : {}),
	};
}

/** Rebind every state-owned ref in an action transaction after one fresh observation. */
export function rebindActParams(params: ActParams, base: Outline, refreshed: Outline, stateId: string): { params: ActParams; mappings: ReboundReference[] } {
	const mappings = referencedRefs(params).map((ref) => matchFingerprint(fingerprint(ref, base), refreshed));
	const refs = new Map(mappings.map((mapping) => [mapping.from, mapping.to]));
	return {
		params: {
			...params,
			stateId,
			actions: (params.actions ?? []).map((action): UiAction => action.ref ? { ...action, ref: refs.get(action.ref) ?? action.ref } : { ...action }),
			guards: params.guards?.map((guard) => mapCondition(guard, refs)!),
			expect: mapCondition(params.expect, refs),
		},
		mappings,
	};
}
