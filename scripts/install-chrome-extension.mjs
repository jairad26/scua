#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionId = "egjfcbdojhobbplnelgcidgckooemjij";
const appSupport = path.join(os.homedir(), "Library", "Application Support");
const installRoot = path.join(appSupport, "SCUA");
const extensionDestination = path.join(installRoot, "ChromeExtension");
const hostDestination = path.join(installRoot, "bin", "chrome-native-host.mjs");
const launcherDestination = path.join(installRoot, "bin", "chrome-native-host");
const chromeHosts = path.join(appSupport, "Google", "Chrome", "NativeMessagingHosts");
const hostManifestDestination = path.join(chromeHosts, "com.jairad26.scua.json");

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function install() {
	await fs.mkdir(installRoot, { recursive: true, mode: 0o700 });
	const staging = `${extensionDestination}.staging-${process.pid}-${Date.now()}`;
	await fs.cp(path.join(root, "chrome-extension"), staging, { recursive: true });
	await fs.rm(extensionDestination, { recursive: true, force: true });
	await fs.rename(staging, extensionDestination);

	await fs.mkdir(path.dirname(hostDestination), { recursive: true, mode: 0o700 });
	await fs.copyFile(path.join(root, "scripts", "chrome-native-host.mjs"), hostDestination);
	await fs.chmod(hostDestination, 0o700);
	const launcher = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hostDestination)} "$@"\n`;
	await fs.writeFile(launcherDestination, launcher, { mode: 0o700 });
	await fs.chmod(launcherDestination, 0o700);

	await fs.mkdir(chromeHosts, { recursive: true });
	const hostManifest = {
		name: "com.jairad26.scua",
		description: "SCUA Chrome workspace bridge",
		path: launcherDestination,
		type: "stdio",
		allowed_origins: [`chrome-extension://${extensionId}/`],
	};
	await fs.writeFile(hostManifestDestination, `${JSON.stringify(hostManifest, null, 2)}\n`, { mode: 0o600 });
	await fs.chmod(hostManifestDestination, 0o600);

	console.log(JSON.stringify({ extensionId, extensionPath: extensionDestination, nativeHostManifest: hostManifestDestination }, null, 2));
	console.log("One-time Chrome step: open chrome://extensions, enable Developer mode, choose Load unpacked, and select the extensionPath above.");
	if (process.argv.includes("--open")) {
		const child = spawn("/usr/bin/open", ["-a", "Google Chrome", "chrome://extensions"], { detached: true, stdio: "ignore" });
		child.unref();
	}
}

await install();
