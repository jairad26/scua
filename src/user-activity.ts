export interface UserActivitySnapshot {
	idleForMs: number;
	monitoringMode: "listen_only" | "hid_system_timer";
}

export interface UserQuietPeriodOptions {
	quietPeriodMs: number;
	timeoutMs: number;
	pollMs?: number;
	signal?: AbortSignal;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class UserActiveError extends Error {
	readonly code = "user_active";
	readonly delivery = "definitely_not_delivered";
	readonly recovery = "reacquire";
	readonly evidence: Record<string, unknown>;

	constructor(message: string, snapshot?: UserActivitySnapshot) {
		super(message);
		this.name = "UserActiveError";
		this.evidence = snapshot ? { ...snapshot } : {};
	}
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Operation aborted."));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			signal?.removeEventListener("abort", aborted);
			resolve();
		}
		function aborted(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			reject(new Error("Operation aborted."));
		}
		signal?.addEventListener("abort", aborted, { once: true });
	});
}

/** Wait for a continuous physical-user quiet period. The caller supplies the
 * platform status reader so this policy stays deterministic and testable. */
export async function waitForUserQuietPeriod(
	readActivity: () => Promise<UserActivitySnapshot>,
	options: UserQuietPeriodOptions,
): Promise<UserActivitySnapshot> {
	const quietPeriodMs = Math.max(0, Math.trunc(options.quietPeriodMs));
	if (quietPeriodMs === 0) return { idleForMs: Number.POSITIVE_INFINITY, monitoringMode: "hid_system_timer" };
	const timeoutMs = Math.max(0, Math.trunc(options.timeoutMs));
	const pollMs = Math.max(10, Math.min(250, Math.trunc(options.pollMs ?? 50)));
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const deadline = now() + timeoutMs;
	let latest: UserActivitySnapshot | undefined;
	for (;;) {
		if (options.signal?.aborted) throw new Error("Operation aborted.");
		latest = await readActivity();
		if (latest.idleForMs >= quietPeriodMs) return latest;
		const remaining = deadline - now();
		if (remaining <= 0) {
			throw new UserActiveError(`Foreground work yielded because physical user input did not become quiet for ${quietPeriodMs}ms within the ${timeoutMs}ms wait budget.`, latest);
		}
		const untilQuiet = Math.max(1, quietPeriodMs - latest.idleForMs);
		await sleep(Math.min(pollMs, remaining, untilQuiet), options.signal);
	}
}

export async function assertUserQuietPeriod(
	readActivity: () => Promise<UserActivitySnapshot>,
	quietPeriodMs: number,
): Promise<UserActivitySnapshot> {
	if (quietPeriodMs <= 0) return { idleForMs: Number.POSITIVE_INFINITY, monitoringMode: "hid_system_timer" };
	const snapshot = await readActivity();
	if (snapshot.idleForMs < quietPeriodMs) {
		throw new UserActiveError(`Foreground work yielded because physical user input occurred ${Math.round(snapshot.idleForMs)}ms ago.`, snapshot);
	}
	return snapshot;
}
