#!/usr/bin/env node
//
// Usage: `node process-gate.js` (payload = first stdin line) or
// `node process-gate.js --file <path>` (payload file, removed after reading).
// Payload: `{"argv": [cmd, ...args], "cwd": "/abs", "env": {...}}`.
// Exit 125 = missing or invalid payload, 127 = spawn error; otherwise the
// child's exit code, or the child's terminating signal re-raised on the gate.
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";

interface ProcessGatePayload {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

async function readStdinPayload(): Promise<string | undefined> {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	return await new Promise<string | undefined>((resolve, reject) => {
		lines.once("line", (value) => {
			resolve(value);
			lines.close();
		});
		lines.once("close", () => resolve(undefined));
		lines.once("error", reject);
	});
}

async function readFilePayload(path: string): Promise<string> {
	for (;;) {
		try {
			const value = await readFile(path, "utf8");
			await unlink(path).catch(() => undefined);
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

function isProcessGatePayload(value: unknown): value is ProcessGatePayload {
	const payload = value as Partial<Record<keyof ProcessGatePayload, unknown>>;
	return Boolean(
		payload &&
			Array.isArray(payload.argv) &&
			payload.argv.length > 0 &&
			!payload.argv.some(
				(entry: unknown) => typeof entry !== "string" || entry.length === 0,
			) &&
			typeof payload.cwd === "string" &&
			payload.env &&
			typeof payload.env === "object",
	);
}

const raw =
	process.argv[2] === "--file" && typeof process.argv[3] === "string"
		? await readFilePayload(process.argv[3])
		: await readStdinPayload();
if (raw === undefined) process.exit(125);
let parsed: unknown;
try {
	parsed = JSON.parse(raw);
} catch {
	process.exit(125);
}
if (!isProcessGatePayload(parsed)) process.exit(125);
const payload = parsed;
const child = spawn(payload.argv[0]!, payload.argv.slice(1), {
	cwd: payload.cwd,
	env: payload.env,
	stdio: ["ignore", "inherit", "inherit"],
});
child.once("error", (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 127;
});
child.once("exit", (code, signal) => {
	if (signal !== null) {
		try {
			process.kill(process.pid, signal);
		} catch {
			process.exitCode = 1;
		}
		return;
	}
	process.exitCode = code ?? 1;
});
