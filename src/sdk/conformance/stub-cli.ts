/**
 * Stub CLI for offline adapter conformance (prior-art §3 #10: faux provider / `qa_mock`).
 * Writes an executable Node script that replays scripted stdout/stderr/exit behaviour in whatever
 * wire format the adapter parses (stream-json lines, JSON-RPC, …) and records every invocation —
 * argv, cwd, env keys (never values), stdin lines, signals, exit code — so a harness can count
 * effects and inspect argv without a real CLI or model call.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../json.js";
import type { LaunchRecord } from "./types.js";

export type StubCliStep =
	/** Write one line to stdout. Non-string values are JSON-encoded on one line. */
	| { readonly stdout: JsonValue }
	| { readonly stderr: string }
	| { readonly sleepMs: number }
	/** Exit now with this code. */
	| { readonly exit: number }
	/** Block until killed (cancel tests). */
	| { readonly hang: true }
	/**
	 * Wait for a stdin line and branch on the first `match` substring it contains
	 * (e.g. an approval answer); `otherwise` runs on timeout or stdin end.
	 */
	| {
			readonly awaitStdin: {
				readonly branches: readonly {
					readonly match: string;
					readonly steps: readonly StubCliStep[];
				}[];
				readonly otherwise?: readonly StubCliStep[];
				readonly timeoutMs?: number;
			};
	  };

export interface StubCliScript {
	readonly name: string;
	/** Script applies when argv contains every listed string. Omit to match any argv. */
	readonly when?: { readonly argvIncludes?: readonly string[] };
	/** Whether this invocation is an effect (launch). Default true; false for `--version` probes. */
	readonly effect?: boolean;
	readonly steps: readonly StubCliStep[];
	/** Exit code when steps run out. Default 0. */
	readonly exitCode?: number;
}

export interface StubCliOptions {
	/** Directory for the executable, its config and log. */
	readonly dir: string;
	/** Executable file name. Default `stub-cli`. */
	readonly name?: string;
	/** First matching script wins. */
	readonly scripts: readonly StubCliScript[];
}

export interface StubInvocation {
	readonly pid: number;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly envKeys: readonly string[];
	/** Name of the matched script, or null when none matched (exit 2). */
	readonly script: string | null;
	readonly effect: boolean;
	readonly startedAt: number;
	readonly stdin: readonly string[];
	readonly signals: readonly string[];
	readonly exitCode: number | null;
}

export interface StubCli {
	/** Executable path to configure the adapter with (instead of the real CLI binary). */
	readonly path: string;
	readonly configPath: string;
	readonly logPath: string;
	/** Replace the scripts (takes effect for the next invocation). */
	setScripts(scripts: readonly StubCliScript[]): Promise<void>;
	invocations(): Promise<StubInvocation[]>;
	/** Effect invocations as launch records, optionally filtered (e.g. by an attempt marker in argv). */
	launches(
		filter?: (invocation: StubInvocation) => boolean,
	): Promise<LaunchRecord[]>;
	effectCount(
		filter?: (invocation: StubInvocation) => boolean,
	): Promise<number>;
	/** Truncate the invocation log. */
	reset(): Promise<void>;
}

const STUB_SOURCE = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const base = process.argv[1].replace(/\.mjs$/, "");
const config = JSON.parse(readFileSync(base + ".config.json", "utf8"));
const logPath = base + ".log.jsonl";
const argv = process.argv.slice(2);
const log = (entry) => appendFileSync(logPath, JSON.stringify({ ...entry, pid: process.pid }) + "\n");
const script = config.scripts.find((candidate) => (candidate.when?.argvIncludes ?? []).every((part) => argv.includes(part))) ?? null;
log({ type: "start", argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), script: script?.name ?? null, effect: script ? script.effect !== false : false, startedAt: Date.now() });
process.on("exit", (code) => log({ type: "exit", code }));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(signal, () => {
		log({ type: "signal", signal });
		process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
	});
}

const stdinLines = [];
const stdinWaiters = [];
let stdinClosed = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	log({ type: "stdin", line });
	const waiter = stdinWaiters.shift();
	if (waiter) waiter(line); else stdinLines.push(line);
});
lines.on("close", () => {
	stdinClosed = true;
	for (const waiter of stdinWaiters.splice(0)) waiter(null);
});
const nextStdin = (timeoutMs) => new Promise((resolve) => {
	if (stdinLines.length > 0) return resolve(stdinLines.shift());
	if (stdinClosed) return resolve(null);
	const timer = timeoutMs ? setTimeout(() => { const at = stdinWaiters.indexOf(done); if (at >= 0) stdinWaiters.splice(at, 1); resolve(null); }, timeoutMs) : undefined;
	const done = (line) => { if (timer) clearTimeout(timer); resolve(line); };
	stdinWaiters.push(done);
});
const write = (stream, value) => new Promise((resolve) => stream.write((typeof value === "string" ? value : JSON.stringify(value)) + "\n", resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(steps) {
	for (const step of steps) {
		if ("stdout" in step) await write(process.stdout, step.stdout);
		else if ("stderr" in step) await write(process.stderr, step.stderr);
		else if ("sleepMs" in step) await sleep(step.sleepMs);
		else if ("exit" in step) process.exit(step.exit);
		else if ("hang" in step) await new Promise(() => setInterval(() => {}, 1 << 30));
		else if ("awaitStdin" in step) {
			const line = await nextStdin(step.awaitStdin.timeoutMs);
			const branch = line === null ? undefined : step.awaitStdin.branches.find((candidate) => line.includes(candidate.match));
			await run(branch ? branch.steps : (step.awaitStdin.otherwise ?? []));
		}
	}
}

if (script === null) {
	process.stderr.write("stub-cli: no script matches argv " + JSON.stringify(argv) + "\n");
	process.exit(2);
}
await run(script.steps);
process.exit(script.exitCode ?? 0);
`;

interface RawEntry {
	readonly type: "start" | "exit" | "signal" | "stdin";
	readonly pid: number;
	readonly [key: string]: unknown;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Write a stub CLI executable into `options.dir`. */
export async function createStubCli(options: StubCliOptions): Promise<StubCli> {
	const path = join(options.dir, options.name ?? "stub-cli");
	const configPath = `${path}.config.json`;
	const logPath = `${path}.log.jsonl`;
	// POSIX sh launcher + ESM body: `exec` keeps one pid, so signals reach the stub directly.
	await writeFile(`${path}.mjs`, STUB_SOURCE);
	await writeFile(
		path,
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(`${path}.mjs`)} "$@"\n`,
	);
	await chmod(path, 0o755);
	const setScripts = (scripts: readonly StubCliScript[]) =>
		writeFile(configPath, JSON.stringify({ scripts }));
	await setScripts(options.scripts);
	await writeFile(logPath, "");

	const invocations = async (): Promise<StubInvocation[]> => {
		let text: string;
		try {
			text = await readFile(logPath, "utf8");
		} catch {
			return [];
		}
		const byPid = new Map<number, StubInvocation>();
		const order: number[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			let entry: RawEntry;
			try {
				entry = JSON.parse(line) as RawEntry;
			} catch {
				continue; // a line being written concurrently
			}
			if (entry.type === "start") {
				order.push(entry.pid);
				byPid.set(entry.pid, {
					pid: entry.pid,
					argv: (entry.argv as string[]) ?? [],
					cwd: String(entry.cwd ?? ""),
					envKeys: (entry.envKeys as string[]) ?? [],
					script: (entry.script as string | null) ?? null,
					effect: entry.effect === true,
					startedAt: Number(entry.startedAt ?? 0),
					stdin: [],
					signals: [],
					exitCode: null,
				});
				continue;
			}
			const current = byPid.get(entry.pid);
			if (current === undefined) continue;
			if (entry.type === "stdin")
				byPid.set(entry.pid, {
					...current,
					stdin: [...current.stdin, String(entry.line)],
				});
			else if (entry.type === "signal")
				byPid.set(entry.pid, {
					...current,
					signals: [...current.signals, String(entry.signal)],
				});
			else if (entry.type === "exit")
				byPid.set(entry.pid, {
					...current,
					exitCode: typeof entry.code === "number" ? entry.code : null,
				});
		}
		return order.flatMap((pid) => {
			const invocation = byPid.get(pid);
			return invocation === undefined ? [] : [invocation];
		});
	};
	const effects = async (filter?: (invocation: StubInvocation) => boolean) =>
		(await invocations()).filter(
			(invocation) =>
				invocation.effect && (filter === undefined || filter(invocation)),
		);
	return {
		path,
		configPath,
		logPath,
		setScripts,
		invocations,
		async launches(filter) {
			return (await effects(filter)).map((invocation) => ({
				argv: invocation.argv,
				envKeys: invocation.envKeys,
				cwd: invocation.cwd,
			}));
		},
		effectCount: async (filter) => (await effects(filter)).length,
		reset: () => writeFile(logPath, ""),
	};
}
