#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadComputerUseConfig } from "../src/config.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "scua-config-test-"));
const previousMode = process.env.PI_COMPUTER_USE_EXECUTION_MODE;
const previousQuietPeriod = process.env.PI_COMPUTER_USE_USER_QUIET_PERIOD_MS;
const previousActivityTimeout = process.env.PI_COMPUTER_USE_USER_ACTIVITY_TIMEOUT_MS;

try {
	mkdirSync(path.join(directory, ".pi"));
	writeFileSync(path.join(directory, ".pi", "computer-use.json"), JSON.stringify({ execution_mode: "foreground", user_quiet_period_ms: 900, user_activity_timeout_ms: 7_500 }));
	delete process.env.PI_COMPUTER_USE_EXECUTION_MODE;
	delete process.env.PI_COMPUTER_USE_USER_QUIET_PERIOD_MS;
	delete process.env.PI_COMPUTER_USE_USER_ACTIVITY_TIMEOUT_MS;
	const project = loadComputerUseConfig(directory).config;
	assert.equal(project.execution_mode, "foreground", "project execution mode was not loaded");
	assert.equal(project.user_quiet_period_ms, 900, "project user quiet period was not loaded");
	assert.equal(project.user_activity_timeout_ms, 7_500, "project user activity timeout was not loaded");

	process.env.PI_COMPUTER_USE_EXECUTION_MODE = "background";
	const overridden = loadComputerUseConfig(directory);
	assert.equal(overridden.config.execution_mode, "background", "environment execution mode did not override project config");
	assert.equal(overridden.env.execution_mode, "background", "active config did not report its execution-mode override");

	process.env.PI_COMPUTER_USE_EXECUTION_MODE = "foreground";
	assert.equal(loadComputerUseConfig(directory).config.execution_mode, "foreground", "foreground environment mode was rejected");

	process.env.PI_COMPUTER_USE_USER_QUIET_PERIOD_MS = "1200";
	process.env.PI_COMPUTER_USE_USER_ACTIVITY_TIMEOUT_MS = "8000";
	const userPriority = loadComputerUseConfig(directory);
	assert.equal(userPriority.config.user_quiet_period_ms, 1_200, "user quiet-period environment override was rejected");
	assert.equal(userPriority.config.user_activity_timeout_ms, 8_000, "user activity-timeout environment override was rejected");
	assert.equal(userPriority.env.user_quiet_period_ms, 1_200, "active config omitted user quiet-period override");

	console.log("Execution-mode configuration checks passed.");
} finally {
	if (previousMode === undefined) delete process.env.PI_COMPUTER_USE_EXECUTION_MODE;
	else process.env.PI_COMPUTER_USE_EXECUTION_MODE = previousMode;
	if (previousQuietPeriod === undefined) delete process.env.PI_COMPUTER_USE_USER_QUIET_PERIOD_MS;
	else process.env.PI_COMPUTER_USE_USER_QUIET_PERIOD_MS = previousQuietPeriod;
	if (previousActivityTimeout === undefined) delete process.env.PI_COMPUTER_USE_USER_ACTIVITY_TIMEOUT_MS;
	else process.env.PI_COMPUTER_USE_USER_ACTIVITY_TIMEOUT_MS = previousActivityTimeout;
	rmSync(directory, { recursive: true, force: true });
}
