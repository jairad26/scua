import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoredState<T> {
	stateId: string;
	resourceKey: string;
	epoch: number;
	value: T;
}

export class StaleResourceStateError extends Error {
	readonly resourceKey: string;
	readonly expectedEpoch: number;
	readonly actualEpoch: number;

	constructor(resourceKey: string, expectedEpoch: number, actualEpoch: number) {
		super(`State is stale for ${resourceKey}: expected epoch ${expectedEpoch}, current epoch ${actualEpoch}.`);
		this.name = "StaleResourceStateError";
		this.resourceKey = resourceKey;
		this.expectedEpoch = expectedEpoch;
		this.actualEpoch = actualEpoch;
	}
}

/** Bounded insertion-ordered store for immutable agent-facing observations. */
export class StateStore<T> {
	private readonly records = new Map<string, StoredState<T>>();
	private readonly limit: number;

	constructor(limit = 128) {
		this.limit = limit;
	}

	create(resourceKey: string, epoch: number, value: T): StoredState<T> {
		const record = { stateId: randomUUID(), resourceKey, epoch, value };
		this.set(record);
		return record;
	}

	set(record: StoredState<T>): void {
		this.records.delete(record.stateId);
		this.records.set(record.stateId, record);
		while (this.records.size > this.limit) {
			const oldest = this.records.keys().next().value as string | undefined;
			if (!oldest) break;
			this.records.delete(oldest);
		}
	}

	get(stateId: string): StoredState<T> | undefined {
		return this.records.get(stateId);
	}

	delete(stateId: string): boolean {
		return this.records.delete(stateId);
	}

	clear(): void {
		this.records.clear();
	}

	get size(): number {
		return this.records.size;
	}
}

interface ResourceSchedulerOptions {
	sharedDirectory?: string;
	sessionId?: string;
	lockTimeoutMs?: number;
}

interface LeaseOwner {
	pid: number;
	sessionId: string;
	processToken?: string;
	createdAt: number;
	expiresAt: number;
}

const processTokenByDirectory = new Map<string, string>();

/**
 * Orders live operations per physical resource while allowing unrelated
 * resources to overlap. Cached state queries bypass this scheduler entirely.
 */
export class ResourceScheduler {
	private readonly sharedDirectory: string;
	private readonly sessionId: string;
	private readonly lockTimeoutMs: number;
	private readonly processToken: string;
	private readonly active = new Set<Promise<unknown>>();
	private closed = false;

	constructor(options: ResourceSchedulerOptions = {}) {
		this.sharedDirectory = options.sharedDirectory ?? path.join(os.tmpdir(), "scua-resource-coordinator-v1");
		this.sessionId = options.sessionId ?? `${process.pid}-${randomUUID()}`;
		this.lockTimeoutMs = Math.max(1_000, options.lockTimeoutMs ?? 60_000);
		mkdirSync(this.sharedDirectory, { recursive: true, mode: 0o700 });
		this.processToken = processTokenByDirectory.get(this.sharedDirectory) ?? randomUUID();
		processTokenByDirectory.set(this.sharedDirectory, this.processToken);
		writeFileSync(this.processRegistryPath(process.pid), JSON.stringify({ pid: process.pid, processToken: this.processToken, startedAt: Date.now() - Math.round(process.uptime() * 1_000) }), { mode: 0o600 });
	}

	epoch(resourceKey: string): number {
		return this.readEpochSync(resourceKey);
	}

	async restoreEpoch(resourceKey: string, epoch: number): Promise<void> {
		const wanted = Math.max(0, Math.trunc(epoch));
		if (wanted <= this.readEpochSync(resourceKey)) return;
		await this.withLease(resourceKey, async () => {
			if (wanted > await this.readEpoch(resourceKey)) await this.writeEpoch(resourceKey, wanted);
		});
	}

	async read<T>(resourceKey: string, work: (epoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.track(this.withLease(resourceKey, async () => {
			const epoch = await this.readEpoch(resourceKey);
			return { value: await work(epoch), epoch };
		}));
	}

	async readAt<T>(resourceKey: string, expectedEpoch: number, work: (epoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.track(this.withLease(resourceKey, async () => {
			const epoch = await this.readEpoch(resourceKey);
			if (epoch !== expectedEpoch) throw new StaleResourceStateError(resourceKey, expectedEpoch, epoch);
			return { value: await work(epoch), epoch };
		}));
	}

	async write<T>(resourceKey: string, baseEpoch: number, work: (nextEpoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.writeWithClaims(resourceKey, baseEpoch, [], work);
	}

	/**
	 * Mutate one epoch-bearing resource while holding additional hierarchical
	 * claims. Canonical ordering prevents app/window claim deadlocks.
	 */
	async writeWithClaims<T>(resourceKey: string, baseEpoch: number, claims: string[], work: (nextEpoch: number) => Promise<T>): Promise<{ value: T; epoch: number }> {
		return await this.writeGuarded(resourceKey, baseEpoch, claims, undefined, work);
	}

	/**
	 * Validate live commit guards while every relevant lease is held, then
	 * advance the epoch and dispatch. A rejected guard leaves the epoch intact,
	 * proving that the attempted mutation was never admitted.
	 */
	async writeGuarded<T>(
		resourceKey: string,
		baseEpoch: number,
		claims: string[],
		guard: (() => Promise<void>) | undefined,
		work: (nextEpoch: number) => Promise<T>,
	): Promise<{ value: T; epoch: number }> {
		return await this.track(this.withLeases([resourceKey, ...claims], async () => {
			const epoch = await this.readEpoch(resourceKey);
			if (epoch !== baseEpoch) throw new StaleResourceStateError(resourceKey, baseEpoch, epoch);
			await guard?.();
			const nextEpoch = epoch + 1;
			// Invalidate the base state before dispatch. If native execution becomes
			// uncertain or throws after a partial effect, later writes still fail safe.
			await this.writeEpoch(resourceKey, nextEpoch);
			return { value: await work(nextEpoch), epoch: nextEpoch };
		}));
	}

	async drain(): Promise<void> {
		await Promise.all([...this.active].map((operation) => operation.catch(() => undefined)));
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.drain();
		await this.gcMetadata().catch(() => undefined);
	}

	/** Remove abandoned coordinator metadata without touching live locks. */
	async gcMetadata(olderThanMs = 24 * 60 * 60_000): Promise<number> {
		let removed = 0;
		const now = Date.now();
		for (const entry of await readdir(this.sharedDirectory, { withFileTypes: true }).catch(() => [])) {
			const file = path.join(this.sharedDirectory, entry.name);
			if (entry.isDirectory() && entry.name.endsWith(".lock")) {
				if (await this.removeStaleLease(file, path.join(file, "owner.json"))) removed += 1;
				continue;
			}
			if (!entry.isFile()) continue;
			const age = await stat(file).then((value) => now - value.mtimeMs).catch(() => 0);
			if (age < olderThanMs) continue;
			if (/^process-\d+\.json$/.test(entry.name)) {
				const pid = Number(entry.name.slice("process-".length, -".json".length));
				let alive = true;
				try { process.kill(pid, 0); } catch { alive = false; }
				if (!alive) { await rm(file, { force: true }); removed += 1; }
				continue;
			}
			if (!entry.name.endsWith(".epoch") && !entry.name.endsWith(".tmp")) continue;
			const digest = entry.name.split(".")[0];
			if (existsSync(path.join(this.sharedDirectory, `${digest}.lock`))) continue;
			await rm(file, { force: true });
			removed += 1;
		}
		return removed;
	}

	private paths(resourceKey: string): { epoch: string; lock: string; owner: string } {
		const digest = createHash("sha256").update(resourceKey).digest("hex");
		const base = path.join(this.sharedDirectory, digest);
		return { epoch: `${base}.epoch`, lock: `${base}.lock`, owner: path.join(`${base}.lock`, "owner.json") };
	}

	private processRegistryPath(pid: number): string {
		return path.join(this.sharedDirectory, `process-${pid}.json`);
	}

	private async track<T>(operation: Promise<T>): Promise<T> {
		this.active.add(operation);
		try {
			return await operation;
		} finally {
			this.active.delete(operation);
		}
	}

	private async withLease<T>(resourceKey: string, work: () => Promise<T>): Promise<T> {
		if (this.closed) throw new Error("Computer-use session is shutting down.");
		const paths = this.paths(resourceKey);
		const deadline = Date.now() + this.lockTimeoutMs;
		for (;;) {
			try {
				await mkdir(paths.lock, { mode: 0o700 });
				const now = Date.now();
				const owner: LeaseOwner = { pid: process.pid, sessionId: this.sessionId, processToken: this.processToken, createdAt: now, expiresAt: now + this.lockTimeoutMs * 2 };
				try {
					await writeFile(paths.owner, JSON.stringify(owner), { mode: 0o600 });
				} catch (error) {
					await rm(paths.lock, { recursive: true, force: true }).catch(() => undefined);
					throw error;
				}
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (await this.removeStaleLease(paths.lock, paths.owner)) continue;
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for SCUA resource lease '${resourceKey}'.`);
				await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
			}
		}
		try {
			return await work();
		} finally {
			await this.releaseLease(paths.lock, paths.owner);
		}
	}

	private async withLeases<T>(resourceKeys: string[], work: () => Promise<T>): Promise<T> {
		const ordered = [...new Set(resourceKeys)].sort();
		const acquire = async (index: number): Promise<T> => {
			if (index >= ordered.length) return await work();
			return await this.withLease(ordered[index], async () => await acquire(index + 1));
		};
		return await acquire(0);
	}

	private async removeStaleLease(lockPath: string, ownerPath: string): Promise<boolean> {
		let owner: LeaseOwner | undefined;
		try { owner = JSON.parse(await readFile(ownerPath, "utf8")) as LeaseOwner; } catch { /* creator may still be writing */ }
		if (!owner) {
			const age = await stat(lockPath).then((entry) => Date.now() - entry.mtimeMs).catch(() => 0);
			if (age < 1_000) return false;
			return await this.quarantineStaleLease(lockPath);
		}
		let alive = true;
		try { process.kill(owner.pid, 0); } catch { alive = false; }
		if (alive && owner.processToken) {
			const registered = await readFile(this.processRegistryPath(owner.pid), "utf8").then((value) => JSON.parse(value) as { processToken?: string }).catch(() => undefined);
			if (!registered || registered.processToken !== owner.processToken) alive = false;
		}
		// A live owner must retain exclusion even if an operation exceeds the
		// expected duration. Expiry is diagnostic; process death is authoritative.
		if (alive) return false;
		return await this.quarantineStaleLease(lockPath);
	}

	private async quarantineStaleLease(lockPath: string): Promise<boolean> {
		const quarantine = `${lockPath}.stale.${this.sessionId}.${randomUUID()}`;
		try {
			// Atomic rename prevents a second waiter from deleting a replacement
			// lock created after the stale owner was observed.
			await rename(lockPath, quarantine);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
		return true;
	}

	private async releaseLease(lockPath: string, ownerPath: string): Promise<void> {
		let owner: LeaseOwner | undefined;
		try { owner = JSON.parse(await readFile(ownerPath, "utf8")) as LeaseOwner; } catch { return; }
		if (owner.sessionId !== this.sessionId || owner.pid !== process.pid) return;
		await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
	}

	private readEpochSync(resourceKey: string): number {
		const file = this.paths(resourceKey).epoch;
		if (!existsSync(file)) return 0;
		try {
			const parsed = Number(readFileSync(file, "utf8"));
			return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
		} catch { return 0; }
	}

	private async readEpoch(resourceKey: string): Promise<number> {
		try {
			const parsed = Number(await readFile(this.paths(resourceKey).epoch, "utf8"));
			return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
		} catch { return 0; }
	}

	private async writeEpoch(resourceKey: string, epoch: number): Promise<void> {
		const target = this.paths(resourceKey).epoch;
		const temporary = `${target}.${this.sessionId}.tmp`;
		await writeFile(temporary, String(epoch), { mode: 0o600 });
		await rename(temporary, target);
	}
}
