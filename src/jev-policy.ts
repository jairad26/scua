import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TypeSafeClient, choice, type EntryType } from "@typesafe-ai/sdk";
import type { UiAction } from "./contract.ts";

const execFileAsync = promisify(execFile);
const MAX_CHOICE_CRITERIA = 250;
const MAX_QUESTIONS_PER_REQUEST = 16;
const KEYCHAIN_SERVICE = "ai.typesafe.scua";

export interface JevActionCandidate {
	id: string;
	kind: "action" | "done" | "wait" | "escalate";
	description: EntryType;
	action?: UiAction;
}

export interface JevDecisionState {
	goal: string;
	taskId: string;
	objective: string;
	step: number;
	ui: Record<string, unknown>;
	dependencies: Array<Record<string, unknown>>;
	recentActions: Array<Record<string, unknown>>;
}

interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

interface JevSystemOneResult {
	model: string;
	answers: Record<string, JevChoiceAnswer>;
	usage: { input_tokens: number; output_tokens: number };
}

export interface JevPolicyClient {
	systemOne(
		request: { state: EntryType; questions: Record<string, ReturnType<typeof choice>>; model?: string },
		options?: { signal?: AbortSignal; timeout?: number; retry?: Record<string, unknown> },
	): PromiseLike<JevSystemOneResult>;
}

export interface JevDecision {
	candidate: JevActionCandidate;
	confidence: number;
	margin: number;
	probabilities: Record<string, number>;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	latencyMs: number;
	requestCount: number;
	selectionDepth: number;
}

export type JevTaskRole = "inspect" | "transform" | "communicate" | "finalize";

export interface JevPlanningRoot {
	id: string;
	root: string;
	stateId?: string;
	app: string;
	title: string;
	kind: string;
	url?: string;
	semanticFacts?: Array<Record<string, unknown>>;
}

export interface JevPlannedRoot extends JevPlanningRoot {
	role: JevTaskRole;
	wave: number;
	confidence: number;
	margin: number;
	probabilities: Record<string, number>;
}

export interface JevTaskPlanDecision {
	selected: JevPlannedRoot[];
	excluded: Array<{ id: string; app: string; title: string; confidence: number }>;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	latencyMs: number;
}

let cachedApiKey: string | undefined;
let cachedClient: JevPolicyClient | undefined;
let testClientFactory: (() => JevPolicyClient) | undefined;

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function loadApiKey(): Promise<string> {
	if (cachedApiKey) return cachedApiKey;
	const direct = nonEmpty(process.env.TYPESAFE_API_KEY);
	if (direct) {
		cachedApiKey = direct;
		return direct;
	}
	if (process.platform === "darwin") {
		try {
			const account = nonEmpty(process.env.USER) ?? "scua";
			const { stdout } = await execFileAsync("security", ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"], { maxBuffer: 64 * 1024 });
			const keychainValue = nonEmpty(stdout);
			if (keychainValue) {
				cachedApiKey = keychainValue;
				return keychainValue;
			}
		} catch {
			// Missing local entry is expected on first run; AWS is the durable fallback.
		}
	}

	const secretId = nonEmpty(process.env.SCUA_TYPESAFE_SECRET_ID) ?? "TYPESAFE_API_KEY";
	const region = nonEmpty(process.env.SCUA_TYPESAFE_SECRET_REGION);
	const args = ["secretsmanager", "get-secret-value", "--secret-id", secretId, "--query", "SecretString", "--output", "text"];
	if (region) args.push("--region", region);
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("aws", args, { maxBuffer: 1024 * 1024 }));
	} catch (error) {
		throw new Error(`TypeSafe credentials are unavailable. Set TYPESAFE_API_KEY or grant AWS access to secret '${secretId}'.`, { cause: error });
	}
	const secretString = stdout.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(secretString);
	} catch {
		parsed = secretString;
	}
	const apiKey = nonEmpty(parsed) ?? (parsed && typeof parsed === "object" ? nonEmpty((parsed as Record<string, unknown>).TYPESAFE_API_KEY) : undefined);
	if (!apiKey) throw new Error(`AWS secret '${secretId}' must contain a non-empty TYPESAFE_API_KEY value.`);
	cachedApiKey = apiKey;
	return apiKey;
}

async function defaultClient(): Promise<JevPolicyClient> {
	if (testClientFactory) return testClientFactory();
	if (!cachedClient) {
		cachedClient = new TypeSafeClient({
			apiKey: await loadApiKey(),
			defaultModel: nonEmpty(process.env.TYPESAFE_DEFAULT_MODEL) ?? "jev-latest",
			logLevel: "off",
			timeout: Math.max(500, Math.min(30_000, Number(process.env.SCUA_JEV_TIMEOUT_MS ?? 5_000))),
			retry: { maxRetries: Math.max(0, Math.min(3, Number(process.env.SCUA_JEV_MAX_RETRIES ?? 1))) },
		}) as JevPolicyClient;
	}
	return cachedClient;
}

export function setJevClientFactoryForTests(factory?: () => JevPolicyClient): void {
	testClientFactory = factory;
	cachedClient = undefined;
}

function criteriaFor(candidates: JevActionCandidate[]): Record<string, EntryType> {
	return Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.description]));
}

function decisionMargin(probabilities: Record<string, number>): number {
	const values = Object.values(probabilities).filter(Number.isFinite).sort((a, b) => b - a);
	return Math.max(0, (values[0] ?? 0) - (values[1] ?? 0));
}

function planningCriteria(maxWaves: number): Record<string, EntryType> {
	const criteria: Record<string, EntryType> = {
		exclude: {
			meaning: "Do not create a worker for this root.",
			when: "The root is irrelevant, redundant, unsafe, or the overall goal does not explicitly require work in this application.",
		},
	};
	const roles: Array<[JevTaskRole, string]> = [
		["inspect", "Read or extract facts without changing application content."],
		["transform", "Calculate, create, edit, or otherwise transform content in this application."],
		["communicate", "Deliver or share a result only when the overall goal explicitly requests communication."],
		["finalize", "Verify or consolidate work produced by earlier waves."],
	];
	for (let wave = 0; wave < maxWaves; wave += 1) {
		for (const [role, meaning] of roles) {
			criteria[`wave_${wave}_${role}`] = {
				meaning,
				wave,
				dependency: wave === 0
					? "This contribution can begin immediately and independently."
					: `This contribution requires the relevant results of wave ${wave - 1} before it can begin.`,
			};
		}
	}
	return criteria;
}

/** Allocate already-discovered roots into a small dependency graph. This is a
 * typed scheduling judgment, not unconstrained task generation: code owns the
 * candidate roots, roles, waves, validation, and side effects. */
export async function planGoalTaskGraph(
	goal: string,
	roots: JevPlanningRoot[],
	options: { maxWaves: number; maxTasks?: number; signal?: AbortSignal; client?: JevPolicyClient },
): Promise<JevTaskPlanDecision> {
	if (!roots.length) throw new Error("Automatic goal planning requires at least one observable root.");
	if (roots.length > MAX_QUESTIONS_PER_REQUEST) throw new Error(`Automatic goal planning supports at most ${MAX_QUESTIONS_PER_REQUEST} candidate roots.`);
	const maxWaves = Math.max(1, Math.min(4, Math.trunc(options.maxWaves)));
	const maxTasks = Math.max(1, Math.min(16, Math.trunc(options.maxTasks ?? roots.length)));
	const client = options.client ?? await defaultClient();
	const criteria = planningCriteria(maxWaves);
	const questions: Record<string, ReturnType<typeof choice>> = {};
	for (const root of roots) {
		questions[`root_${root.id}`] = choice({
			instruction: `Decide whether root ${root.id} should receive one of at most ${maxTasks} workers for the overall goal, and if so assign its earliest safe execution wave and bounded role. Prefer the smallest sufficient set of roots. Do not select an application merely because it is open. Wave 0 is immediately parallel; each later wave waits for every selected worker in the previous wave. Choose communicate only when the goal explicitly asks to send or publish something. Choose exclude when this root cannot materially advance the goal from its supplied state.`,
		}, criteria);
	}
	const startedAt = performance.now();
	const response = await client.systemOne({
		state: { goal, roots } as unknown as EntryType,
		questions,
	}, { signal: options.signal });
	const selected: JevPlannedRoot[] = [];
	const excluded: JevTaskPlanDecision["excluded"] = [];
	for (const root of roots) {
		const answer = response.answers[`root_${root.id}`];
		if (!answer || typeof answer.choice !== "string") throw new Error(`TypeSafe omitted the planning answer for root '${root.id}'.`);
		if (answer.choice === "exclude") {
			excluded.push({ id: root.id, app: root.app, title: root.title, confidence: answer.confidence });
			continue;
		}
		const match = /^wave_(\d+)_(inspect|transform|communicate|finalize)$/.exec(answer.choice);
		if (!match) throw new Error(`TypeSafe returned unsupported planning choice '${answer.choice}'.`);
		selected.push({
			...root,
			wave: Number(match[1]),
			role: match[2] as JevTaskRole,
			confidence: answer.confidence,
			margin: decisionMargin(answer.probabilities),
			probabilities: answer.probabilities,
		});
	}
	return {
		selected,
		excluded,
		model: response.model,
		usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
		latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
	};
}

function batches<T>(values: T[], size: number): T[][] {
	const output: T[][] = [];
	for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
	return output;
}

function candidateGroups(candidates: JevActionCandidate[]): JevActionCandidate[][] {
	if (candidates.length <= MAX_CHOICE_CRITERIA) return [candidates];
	const terminal = candidates.filter((candidate) => candidate.kind !== "action");
	const actions = candidates.filter((candidate) => candidate.kind === "action");
	const actionGroupSize = MAX_CHOICE_CRITERIA - terminal.length;
	if (actionGroupSize < 1) throw new Error("Jev candidate set contains too many terminal choices.");
	return batches(actions, actionGroupSize).map((group) => [...group, ...terminal]);
}

interface SelectionAccumulator {
	model: string;
	inputTokens: number;
	outputTokens: number;
	requestCount: number;
	lastAnswer?: JevChoiceAnswer;
}

async function chooseRound(
	client: JevPolicyClient,
	state: JevDecisionState,
	candidates: JevActionCandidate[],
	accumulator: SelectionAccumulator,
	signal?: AbortSignal,
): Promise<JevActionCandidate[]> {
	const groups = candidateGroups(candidates);
	const winners: JevActionCandidate[] = [];
	for (const groupBatch of batches(groups, MAX_QUESTIONS_PER_REQUEST)) {
		const questions: Record<string, ReturnType<typeof choice>> = {};
		for (let index = 0; index < groupBatch.length; index += 1) {
			const group = groupBatch[index];
			questions[`selection_${index}`] = choice({
				instruction: "Choose the single action-target pair that most safely advances the task from the exact current UI state. Follow the ordered recent action summaries. Do not repeat a successful setup action unless the current semantic facts prove it was undone. Choose done only when the objective is already satisfied; choose escalate when no listed action is defensible.",
			}, criteriaFor(group));
		}
		const response = await client.systemOne({ state: state as unknown as EntryType, questions }, { signal });
		accumulator.model = response.model;
		accumulator.inputTokens += response.usage.input_tokens;
		accumulator.outputTokens += response.usage.output_tokens;
		accumulator.requestCount += 1;
		for (let index = 0; index < groupBatch.length; index += 1) {
			const answer = response.answers[`selection_${index}`];
			const winner = groupBatch[index].find((candidate) => candidate.id === answer?.choice);
			if (!winner) throw new Error("TypeSafe returned a choice that was not present in the submitted candidate set.");
			winners.push(winner);
			accumulator.lastAnswer = answer;
		}
	}
	return [...new Map(winners.map((candidate) => [candidate.id, candidate])).values()];
}

/** Select a complete action-target pair. Large UI surfaces are reduced through
 * a loss-aware tournament instead of truncating elements from the observation. */
export async function selectGoalAction(
	state: JevDecisionState,
	candidates: JevActionCandidate[],
	options: { signal?: AbortSignal; client?: JevPolicyClient } = {},
): Promise<JevDecision> {
	if (candidates.length < 2) throw new Error("Jev requires at least two complete action candidates.");
	const ids = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate.id || ids.has(candidate.id)) throw new Error(`Jev candidate IDs must be unique and non-empty; received '${candidate.id}'.`);
		ids.add(candidate.id);
	}
	const client = options.client ?? await defaultClient();
	const startedAt = performance.now();
	const accumulator: SelectionAccumulator = { model: "unknown", inputTokens: 0, outputTokens: 0, requestCount: 0 };
	let remaining = candidates;
	let depth = 0;
	while (remaining.length > MAX_CHOICE_CRITERIA) {
		remaining = await chooseRound(client, state, remaining, accumulator, options.signal);
		depth += 1;
	}
	const finalists = remaining.length === 1 ? remaining : await chooseRound(client, state, remaining, accumulator, options.signal);
	const candidate = finalists[0];
	const answer = accumulator.lastAnswer;
	if (!candidate || !answer) throw new Error("TypeSafe did not return a final action choice.");
	return {
		candidate,
		confidence: answer.confidence,
		margin: decisionMargin(answer.probabilities),
		probabilities: answer.probabilities,
		model: accumulator.model,
		usage: { inputTokens: accumulator.inputTokens, outputTokens: accumulator.outputTokens },
		latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
		requestCount: accumulator.requestCount,
		selectionDepth: depth + 1,
	};
}
