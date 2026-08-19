#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadComputerUseConfig } from "../src/config.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "scua-config-test-"));
const previousMode = process.env.PI_COMPUTER_USE_EXECUTION_MODE;

try {
	mkdirSync(path.join(directory, ".pi"));
	writeFileSync(path.join(directory, ".pi", "computer-use.json"), JSON.stringify({ execution_mode: "foreground" }));
	delete process.env.PI_COMPUTER_USE_EXECUTION_MODE;
	assert.equal(loadComputerUseConfig(directory).config.execution_mode, "foreground", "project execution mode was not loaded");

	process.env.PI_COMPUTER_USE_EXECUTION_MODE = "background";
	const overridden = loadComputerUseConfig(directory);
	assert.equal(overridden.config.execution_mode, "background", "environment execution mode did not override project config");
	assert.equal(overridden.env.execution_mode, "background", "active config did not report its execution-mode override");

	process.env.PI_COMPUTER_USE_EXECUTION_MODE = "foreground";
	assert.equal(loadComputerUseConfig(directory).config.execution_mode, "foreground", "foreground environment mode was rejected");

	console.log("Execution-mode configuration checks passed.");
} finally {
	if (previousMode === undefined) delete process.env.PI_COMPUTER_USE_EXECUTION_MODE;
	else process.env.PI_COMPUTER_USE_EXECUTION_MODE = previousMode;
	rmSync(directory, { recursive: true, force: true });
}
