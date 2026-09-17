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
				instruction: "Choose the single action-target pair that most safely advances the task from the exact current UI state. Choose done only when the objective is already satisfied; choose escalate when no listed action is defensible.",
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
