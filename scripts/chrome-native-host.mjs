#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const runtimeDir = process.env.SCUA_CHROME_RUNTIME_DIR?.trim()
	|| path.join(os.homedir(), "Library", "Application Support", "SCUA");
const socketPath = path.join(runtimeDir, "chrome-bridge.sock");
const lockPath = path.join(runtimeDir, "chrome-bridge.lock");
const clients = new Map();
let stdinBuffer = Buffer.alloc(0);
let lockFd;

fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
for (let attempt = 0; attempt < 2; attempt += 1) {
	try {
		lockFd = fs.openSync(lockPath, "wx", 0o600);
		fs.writeFileSync(lockFd, `${process.pid}\n`);
		break;
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		let ownerPid = Number.NaN;
		for (let readAttempt = 0; readAttempt < 3 && !Number.isInteger(ownerPid); readAttempt += 1) {
			try { ownerPid = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10); } catch {}
			if (!Number.isInteger(ownerPid)) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		let ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0;
		if (ownerAlive) {
			try { process.kill(ownerPid, 0); } catch { ownerAlive = false; }
		}
		if (ownerAlive) process.exit(3);
		try { fs.unlinkSync(lockPath); } catch {}
	}
}
if (lockFd === undefined) throw new Error("SCUA Chrome native host could not acquire its relay lock.");
try { fs.unlinkSync(socketPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }

function writeNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > 1024 * 1024) throw new Error("Native message exceeds Chrome's 1 MiB limit.");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function handleNative(message) {
  if (!message || message.type !== "response" || typeof message.clientId !== "string") return;
  const client = clients.get(message.clientId);
  if (!client || client.destroyed) return;
  client.write(`${JSON.stringify(message)}\n`);
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const length = stdinBuffer.readUInt32LE(0);
    if (length > 1024 * 1024) process.exit(2);
    if (stdinBuffer.length < 4 + length) return;
    const body = stdinBuffer.subarray(4, 4 + length);
    stdinBuffer = stdinBuffer.subarray(4 + length);
    try { handleNative(JSON.parse(body.toString("utf8"))); } catch {}
  }
});

const server = net.createServer((socket) => {
  const clientId = randomUUID();
  clients.set(clientId, socket);
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        if (request?.type !== "request" || typeof request.id !== "string" || typeof request.method !== "string") throw new Error("invalid request");
        writeNative({ ...request, clientId });
      } catch {
        socket.write(`${JSON.stringify({ type: "response", id: "invalid", error: { message: "Invalid SCUA Chrome bridge request." } })}\n`);
      }
    }
  });
  const cleanup = () => clients.delete(clientId);
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));

function close() {
  for (const client of clients.values()) client.destroy();
  server.close(() => {
    try { fs.unlinkSync(socketPath); } catch {}
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
    process.exit(0);
  });
}

process.stdin.on("end", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
