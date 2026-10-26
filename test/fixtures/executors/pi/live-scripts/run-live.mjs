#!/usr/bin/env node
// WP6 live-call driver (manual; never run by the unit suite). Runs ONE Pi attempt through the
// adapter with the caller's real environment (Pi owns its login, D1) in a fresh
// /tmp/aw-live-pi-* directory and stores the raw stream + normalized events under
// /tmp/aw-live-pi-rec/<label>/ for scrubbing into test/fixtures/executors/pi/transcripts/.
//
//   node run-live.mjs '<json scenario>'
//
// Scenario: { label, prompt, model, effort?, tools?, readOnly?, systemPrompt?, inherit?,
//   sessionId?, resumeSessionId?, stateDir?, files?: {name: text}, artifact?: {rawChars},
//   cancelAfterMs?, piCommand?, config? }
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const { createExecutor } = await import(
	join(root, "dist/executors/pi/index.js")
);
const { createAuthorityGate, defaultApprovalPolicy, validateEventSequence } =
	await import(join(root, "dist/sdk/index.js"));
const { artifactMcpServerSpecWithOutputLimit } = await import(
	join(root, "dist/mcp/artifact-server/index.js")
);

const scenario = JSON.parse(process.argv[2]);
const label = scenario.label;
const base = mkdtempSync(`/tmp/aw-live-pi-${label}-`);
const cwd = scenario.cwd ?? join(base, "cwd");
const artifactsDir = join(base, "attempt");
const stateDir = scenario.stateDir ?? join(base, "state");
mkdirSync(cwd, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });
for (const [name, text] of Object.entries(scenario.files ?? {}))
	writeFileSync(join(cwd, name), text);

// argv logger: records the exact argv the adapter used (argv never carries secrets).
const argvLog = join(base, "argv.jsonl");
const wrapper = join(base, "pi-argv-logger.mjs");
writeFileSync(
	wrapper,
	`#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nappendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconst child = spawn(${JSON.stringify(scenario.piCommand ?? "pi")}, process.argv.slice(2), { stdio: "inherit" });\nfor (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => child.kill(s));\nchild.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 143 : 1)));\n`,
);
chmodSync(wrapper, 0o755);

const mcpServers = [];
if (scenario.artifact !== undefined) {
	const { createRunFixture } = await import(
		join(root, "test/fixtures/mcp/helpers.mjs")
	);
	const fixture = await createRunFixture();
	const line = "artifact line for the WP6 delivery-bound measurement\n";
	await writeFile(
		join(fixture.producerDir, "raw.txt"),
		line
			.repeat(Math.ceil(scenario.artifact.rawChars / line.length))
			.slice(0, scenario.artifact.rawChars),
	);
	mcpServers.push(
		artifactMcpServerSpecWithOutputLimit(
			fixture.config,
			scenario.artifact.limit ?? 20480,
		),
	);
}

const executor = createExecutor({
	piCommand: wrapper,
	stateDir,
	...(scenario.config ?? {}),
});
const attemptKey = `wp6-live-${label}-${Date.now()}`;
const gate = createAuthorityGate({ attemptKey });
const started = Date.now();
const ref = await executor.submit({
	attemptKey,
	authority: gate.authority,
	cwd,
	prompt: scenario.prompt,
	...(scenario.systemPrompt ? { systemPrompt: scenario.systemPrompt } : {}),
	...(scenario.model ? { model: scenario.model } : {}),
	...(scenario.effort ? { effort: scenario.effort } : {}),
	tools: scenario.tools ?? [],
	readOnly: scenario.readOnly ?? true,
	mcpServers,
	...(scenario.sessionId ? { sessionId: scenario.sessionId } : {}),
	...(scenario.resumeSessionId
		? { resumeSessionId: scenario.resumeSessionId }
		: {}),
	deadlineMs: Date.now() + 300_000,
	env: {},
	isolation: { inherit: scenario.inherit === true },
	approvalPolicy: defaultApprovalPolicy(),
	artifactsDir,
});
if (scenario.cancelAfterMs !== undefined)
	setTimeout(
		() =>
			executor
				.cancel(ref, "owned")
				.then((result) => console.error(`cancel → ${result}`)),
		scenario.cancelAfterMs,
	);
const events = [];
for await (const event of executor.observe(ref)) events.push(event);
const durationMs = Date.now() - started;
const usage = events.filter((event) => event.type === "usage");
const terminal = events.at(-1);
const out = join("/tmp/aw-live-pi-rec", label);
mkdirSync(out, { recursive: true });
cpSync(artifactsDir, out, { recursive: true });
writeFileSync(join(out, "events.json"), `${JSON.stringify(events, null, 1)}\n`);
let argv = [];
try {
	argv = execFileSync("cat", [argvLog], { encoding: "utf8" })
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
} catch {}
const summary = {
	label,
	model: scenario.model ?? null,
	durationMs,
	argv: argv.find((entry) => entry.includes("--mode")) ?? null,
	probeArgv: argv.filter((entry) => !entry.includes("--mode")),
	terminal:
		terminal?.type === "completed"
			? { type: "completed", finalText: terminal.finalText.slice(0, 300) }
			: terminal,
	usage: {
		input: usage.reduce((sum, event) => sum + (event.input ?? 0), 0),
		output: usage.reduce((sum, event) => sum + (event.output ?? 0), 0),
		cached: usage.reduce((sum, event) => sum + (event.cached ?? 0), 0),
		cost: usage.some((event) => event.cost !== null)
			? usage.reduce((sum, event) => sum + (event.cost ?? 0), 0)
			: null,
		sources: [...new Set(usage.map((event) => event.source))],
	},
	toolCalls: events
		.filter((event) => event.type === "tool_call" && event.status !== "running")
		.map((event) => ({
			name: event.name,
			kind: event.kind,
			status: event.status,
			outputChars:
				typeof event.output === "string" ? event.output.length : undefined,
		})),
	sequenceProblems: validateEventSequence(events),
	reconcile: await executor.reconcile(attemptKey),
	base,
};
writeFileSync(
	join(out, "summary.json"),
	`${JSON.stringify(summary, null, 1)}\n`,
);
console.log(JSON.stringify(summary, null, 1));
