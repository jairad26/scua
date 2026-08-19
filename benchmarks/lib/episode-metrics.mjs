function structuredResult(item) {
	return item?.result?.structured_content ?? item?.result?.structuredContent;
}

function walk(value, visit) {
	if (!value || typeof value !== "object") return;
	visit(value);
	if (Array.isArray(value)) {
		for (const child of value) walk(child, visit);
		return;
	}
	for (const child of Object.values(value)) walk(child, visit);
}

export function summarizeCodexEvents(events, timings = new Map()) {
	const tools = [];
	const unauthorizedTools = [];
	const outcomes = { worked: 0, didnt: 0, unknown: 0 };
	const verification = { verified: 0, preexisting: 0, failed: 0 };
	const delivery = {};
	let finalMessage = "";
	let usage = {};
	let peakConcurrency = 0;
	let staleErrors = 0;
	let foregroundEscalations = 0;
	let lastMutation;
	const mutations = [];

	for (const event of events) {
		if (event.type === "turn.completed") usage = event.usage ?? {};
		if (event.type !== "item.completed") continue;
		const item = event.item ?? {};
		if (item.type === "agent_message") finalMessage = item.text ?? finalMessage;
		if (item.type === "mcp_tool_call") {
			const tool = { server: item.server, name: item.tool, status: item.status, durationMs: timings.get(item.id) };
			tools.push(tool);
			if (item.server !== "scua") unauthorizedTools.push(`${item.server ?? "unknown"}:${item.tool ?? "unknown"}`);
			const result = structuredResult(item);
			if (item.server === "scua" && ["act_ui", "execute_plan"].includes(item.tool)) {
				const planOutcome = item.tool === "execute_plan"
					? result?.status === "succeeded" ? "worked" : result?.status === "failed" ? "didnt" : "unknown"
					: undefined;
				lastMutation = {
					tool: item.tool,
					outcome: result?.execution?.outcome ?? planOutcome,
					verification: result?.execution?.verification?.status,
					status: result?.status,
					errorCode: result?.execution?.error?.code ?? result?.error?.code,
				};
				mutations.push(lastMutation);
			}
			let foundStaleError = false;
			walk(result, (record) => {
				const outcome = record?.execution?.outcome;
				if (outcome in outcomes) outcomes[outcome] += 1;
				const status = record?.execution?.verification?.status;
				if (status in verification) verification[status] += 1;
				const method = record?.execution?.delivery ?? (record?.strategy ? record?.delivery : undefined);
				if (typeof method === "string") delivery[method] = (delivery[method] ?? 0) + 1;
				if (record?.execution?.escalatedToForeground === true || record?.escalatedToForeground === true) foregroundEscalations += 1;
				if (Number.isFinite(record?.peakConcurrency)) peakConcurrency = Math.max(peakConcurrency, Number(record.peakConcurrency));
				const errorCode = record?.error?.code ?? record?.code;
				if (["stale_state", "stale_reference", "guard_failed"].includes(errorCode)) foundStaleError = true;
			});
			if (foundStaleError) staleErrors += 1;
			continue;
		}
		if (!["reasoning", "plan", "agent_message"].includes(item.type)) unauthorizedTools.push(item.type ?? "unknown_item");
	}

	const claim = /SCUA_BENCHMARK_RESULT\s+(\{[^\n]+\})/.exec(finalMessage);
	let agentClaim;
	try { agentClaim = claim ? JSON.parse(claim[1]) : undefined; } catch { agentClaim = undefined; }
	let unresolvedMutationFailure = false;
	for (const mutation of mutations) {
		const failed = mutation.outcome === "didnt"
			|| mutation.verification === "failed"
			|| Boolean(mutation.errorCode)
			|| ["failed", "partially_failed", "cancelled"].includes(mutation.status);
		const conclusivelySucceeded = mutation.outcome === "worked"
			&& mutation.verification !== "failed"
			&& mutation.verification !== "preexisting"
			&& !mutation.errorCode
			&& !["failed", "partially_failed", "cancelled"].includes(mutation.status);
		if (failed) unresolvedMutationFailure = true;
		else if (conclusivelySucceeded) unresolvedMutationFailure = false;
	}
	const finalMutationConclusive = !lastMutation || (
		lastMutation.outcome === "worked"
		&& lastMutation.verification !== "failed"
		&& lastMutation.verification !== "preexisting"
		&& !lastMutation.errorCode
		&& !["failed", "partially_failed", "cancelled"].includes(lastMutation.status)
	);
	const claimConsistent = agentClaim?.status !== "success" || (!unresolvedMutationFailure && finalMutationConclusive);
	return {
		integrityPassed: unauthorizedTools.length === 0,
		unauthorizedTools,
		toolCalls: tools.length,
		scuaToolCalls: tools.filter((tool) => tool.server === "scua").length,
		tools,
		outcomes,
		verification,
		delivery,
		foregroundEscalations,
		staleErrors,
		peakConcurrency,
		usage,
		finalMessage,
		agentClaim,
		lastMutation,
		mutations,
		claimConsistent,
	};
}

export function aggregateEpisodes(episodes) {
	const completed = episodes.filter((episode) => episode.evaluation?.passed).length;
	const integrityPassed = episodes.filter((episode) => episode.agent?.metrics?.integrityPassed).length;
	const claimConsistent = episodes.filter((episode) => episode.agent?.metrics?.claimConsistent !== false).length;
	const qualifiedPassed = episodes.filter((episode) => episode.evaluation?.passed && episode.agent?.metrics?.integrityPassed).length;
	const durationMs = episodes.reduce((sum, episode) => sum + (episode.durationMs ?? 0), 0);
	const scuaToolCalls = episodes.reduce((sum, episode) => sum + (episode.agent?.metrics?.scuaToolCalls ?? 0), 0);
	const inputTokens = episodes.reduce((sum, episode) => sum + (episode.agent?.metrics?.usage?.input_tokens ?? 0), 0);
	const outputTokens = episodes.reduce((sum, episode) => sum + (episode.agent?.metrics?.usage?.output_tokens ?? 0), 0);
	const focusChanges = episodes.reduce((sum, episode) => sum + (episode.activity?.focusChanges ?? 0), 0);
	const maximumCursorDistance = episodes.reduce((maximum, episode) => Math.max(maximum, episode.activity?.maximumCursorDistance ?? 0), 0);
	const physicalCursorMovedEpisodes = episodes.filter((episode) => (episode.activity?.maximumCursorDistance ?? 0) > 2).length;
	const foregroundEscalations = episodes.reduce((sum, episode) => sum + (episode.agent?.metrics?.foregroundEscalations ?? 0), 0);
	const staleErrors = episodes.reduce((sum, episode) => sum + (episode.agent?.metrics?.staleErrors ?? 0), 0);
	return {
		tasks: episodes.length,
		passed: completed,
		successRate: episodes.length ? completed / episodes.length : 0,
		qualifiedPassed,
		qualifiedSuccessRate: episodes.length ? qualifiedPassed / episodes.length : 0,
		integrityPassed,
		integrityRate: episodes.length ? integrityPassed / episodes.length : 0,
		claimConsistent,
		claimConsistencyRate: episodes.length ? claimConsistent / episodes.length : 0,
		durationMs,
		meanDurationMs: episodes.length ? durationMs / episodes.length : 0,
		scuaToolCalls,
		meanScuaToolCalls: episodes.length ? scuaToolCalls / episodes.length : 0,
		inputTokens,
		outputTokens,
		focusChanges,
		maximumCursorDistance,
		physicalCursorMovedEpisodes,
		foregroundEscalations,
		staleErrors,
	};
}
