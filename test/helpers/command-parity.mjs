// Characterization of the terminal CLI and `/aw` argument handling (refactor D, 2026-11-04): what
// each command line turns into. Pi: the host API call and its request (a recording fake API, no
// effects) or the error shown. CLI: exit code and usage error, and for valid commands the --json
// result in a fresh project. `node test/helpers/command-parity.mjs --write` records the expectation
// (test/fixtures/command-parity/expected.json); the unit test compares against it.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	CLI_CASES,
	CLI_JSON_CASES,
	PI_CASES,
} from "./command-parity-cases.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXPECTED_PATH = join(
	REPO,
	"test",
	"fixtures",
	"command-parity",
	"expected.json",
);

function recordingApi(calls) {
	return new Proxy(
		{},
		{
			get(_, name) {
				if (typeof name !== "string") return undefined;
				if (name === "registerTestExecutorFromEnv")
					return async () => undefined;
				if (name === "helpAction")
					return (topic) => ({ text: `help ${topic}` });
				if (!name.endsWith("Action")) return undefined;
				return async (_ctx, request) => {
					calls.push({
						name,
						request:
							request === undefined
								? null
								: JSON.parse(JSON.stringify(request)),
					});
					return {
						action: name,
						ok: true,
						outcome: "ok",
						text: "ok",
						data: {},
					};
				};
			},
		},
	);
}

export async function characterize() {
	const ext = await import(join(REPO, "dist/hosts/pi/extension.js"));
	const cli = await import(join(REPO, "dist/hosts/cli/index.js"));
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "aw-command-parity-")));
	try {
		mkdirSync(join(cwd, ".agent-workflow"), { recursive: true });
		const env = {
			...process.env,
			AGENT_WORKFLOW_HOME: join(cwd, "home"),
			AGENT_WORKFLOW_DASHBOARD_AUTOSTART: "0",
		};
		const out = { pi: {}, cli: {}, cliJson: {} };
		const calls = [];
		// Reads of the host context (thinking level, model registry): a malformed command should be
		// rejected before any of them (2026-11-04 review of refactor D).
		let hostReads = 0;
		const commands = new Map();
		ext.createAgentWorkflowPiExtension({ api: recordingApi(calls), env })({
			registerCommand: (name, options) => commands.set(name, options),
			registerTool() {},
			on: () => () => undefined,
			getThinkingLevel: () => {
				hostReads += 1;
				return "medium";
			},
		});
		const command = commands.get("aw");
		for (const args of PI_CASES) {
			calls.length = 0;
			hostReads = 0;
			const notes = [];
			const exitCode = process.exitCode;
			await command.handler(args, {
				cwd,
				hasUI: true,
				mode: "rpc",
				model: { provider: "test", id: "test" },
				modelRegistry: {
					getAvailable: () => {
						hostReads += 1;
						return [];
					},
				},
				ui: {
					notify: (message, type) => notes.push({ message, type }),
					confirm: async () => true,
					select: async () => undefined,
				},
			});
			process.exitCode = exitCode;
			out.pi[args] = {
				...(calls.at(-1) ?? { error: notes.at(-1)?.message ?? null }),
				hostRead: hostReads > 0,
			};
		}
		const run = async (argv) => {
			const stdout = [];
			const stderr = [];
			const code = await cli.runAgentWorkflowCli(argv, {
				cwd,
				env,
				stdout: (text) => stdout.push(text),
				stderr: (text) => stderr.push(text),
				isTTY: false,
			});
			return { code, stdout: stdout.join(""), stderr: stderr.join("").trim() };
		};
		for (const argv of CLI_CASES) {
			const { code, stderr } = await run(argv);
			out.cli[argv.join(" ")] = { code, error: stderr };
		}
		for (const argv of CLI_JSON_CASES) {
			const { code, stdout, stderr } = await run(argv);
			let result;
			try {
				const parsed = JSON.parse(stdout);
				result = {
					action: parsed.action,
					ok: parsed.ok,
					outcome: parsed.outcome,
					data: parsed.data,
				};
			} catch {
				result = { stdout, stderr };
			}
			out.cliJson[argv.join(" ")] = { code, ...result };
		}
		return JSON.parse(
			JSON.stringify(out)
				.split(cwd)
				.join("@@PROJECT@@")
				.split(REPO)
				.join("@@REPO@@")
				.replace(
					/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g,
					'"@@TIME@@"',
				),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const actual = await characterize();
	if (process.argv.includes("--write")) {
		mkdirSync(dirname(EXPECTED_PATH), { recursive: true });
		writeFileSync(EXPECTED_PATH, `${JSON.stringify(actual, null, 1)}\n`);
		console.log(`wrote ${EXPECTED_PATH}`);
	} else {
		const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));
		const same = JSON.stringify(actual) === JSON.stringify(expected);
		console.log(same ? "same" : "differs");
		process.exit(same ? 0 : 1);
	}
}
