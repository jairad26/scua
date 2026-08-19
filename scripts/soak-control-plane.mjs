#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { runAsActor, scuaControlPlane } from "../src/control-plane.ts";

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index < 0) return fallback;
	const value = Number(process.argv[index + 1]);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number.`);
	return value;
}

const actorCount = Math.max(1, Math.min(100, Math.trunc(option("--actors", 50))));
const durationMs = Math.trunc(option("--duration-ms", option("--duration-minutes", 60) * 60_000));
const sampleEveryMs = Math.max(100, Math.trunc(option("--sample-ms", 1_000)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fileDescriptors = async () => (await readdir("/dev/fd")).length;

const actors = Array.from({ length: actorCount }, () => scuaControlPlane.createActor({ maxActions: 100_000, ttlMs: durationMs + 60_000 }));
for (const [index, actor] of actors.entries()) {
	await runAsActor(actor.actorToken, async () => scuaControlPlane.acquire(scuaControlPlane.actor(actor.actorToken), `soak:independent:${index}`, durationMs + 60_000));
}

const startedAt = Date.now();
const baselineHeap = process.memoryUsage().heapUsed;
const baselineFds = await fileDescriptors();
let maximumHeap = baselineHeap;
let maximumFds = baselineFds;
let rounds = 0;
let operations = 0;
let peakConcurrency = 0;

while (Date.now() - startedAt < durationMs) {
	let active = 0;
	await Promise.all(actors.map(async (actor, index) => {
		await runAsActor(actor.actorToken, async () => {
			const session = scuaControlPlane.actor(actor.actorToken);
			scuaControlPlane.acquire(session, `soak:independent:${index}`, 300_000);
			const operationId = scuaControlPlane.startOperation(session, "soak_mutation");
			await scuaControlPlane.withMutation(session, `soak:independent:${index}`, async () => {
				active += 1;
				peakConcurrency = Math.max(peakConcurrency, active);
				await sleep(2);
				active -= 1;
			});
			scuaControlPlane.finishOperation(session, operationId, "soak_mutation", "completed");
			operations += 1;
		});
	}));
	rounds += 1;
	if (rounds % Math.max(1, Math.floor(sampleEveryMs / 5)) === 0) {
		maximumHeap = Math.max(maximumHeap, process.memoryUsage().heapUsed);
		maximumFds = Math.max(maximumFds, await fileDescriptors());
	}
	await sleep(50);
}

for (const actor of actors) {
	await runAsActor(actor.actorToken, async () => scuaControlPlane.closeActor(scuaControlPlane.actor(actor.actorToken)));
}

const heapGrowthBytes = maximumHeap - baselineHeap;
const fdGrowth = maximumFds - baselineFds;
const eventsRetained = scuaControlPlane.allEvents().length;
assert(peakConcurrency >= Math.min(25, actorCount), `actors did not make concurrent progress (peak ${peakConcurrency})`);
assert(eventsRetained <= 4_096, `bounded event trace retained ${eventsRetained} events`);
assert(heapGrowthBytes < 256 * 1024 * 1024, `heap grew by ${heapGrowthBytes} bytes`);
assert(fdGrowth < 64, `file descriptors grew by ${fdGrowth}`);

console.log(JSON.stringify({
	pass: true,
	actorCount,
	durationMs: Date.now() - startedAt,
	rounds,
	operations,
	peakConcurrency,
	heapGrowthBytes,
	fdGrowth,
	eventsRetained,
}, null, 2));
