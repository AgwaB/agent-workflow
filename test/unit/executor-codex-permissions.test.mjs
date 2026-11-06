import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexPermissionMismatch } from "../../dist/executors/codex/permissions.js";
import { classifyCodexFailure } from "../../dist/executors/codex/errors.js";
import { createExecutor } from "../../dist/executors/codex/index.js";
import {
	createAuthorityGate,
	defaultApprovalPolicy,
} from "../../dist/sdk/index.js";
import { createStubCli } from "../../dist/sdk/conformance/index.js";

const free = { sandbox: "danger-full-access", approvalPolicy: "never" };
const response = {
	sandbox: { type: "dangerFullAccess" },
	approvalPolicy: "never",
};

test("effective sandbox, approval and optional profile must match for every requested mode", () => {
	for (const [sandbox, type, id] of [
		["danger-full-access", "dangerFullAccess", ":danger-full-access"],
		["workspace-write", "workspaceWrite", ":workspace"],
		["read-only", "readOnly", ":read-only"],
	]) {
		const requested = {
			sandbox,
			approvalPolicy: sandbox === "danger-full-access" ? "never" : "on-request",
		};
		const actual = {
			sandbox: { type },
			approvalPolicy: requested.approvalPolicy,
		};
		for (const activePermissionProfile of [
			undefined,
			null,
			{ id },
			{ id, extends: null },
		])
			assert.equal(
				codexPermissionMismatch(requested, {
					...actual,
					activePermissionProfile,
				}),
				undefined,
			);
		for (const patch of [
			{ sandbox: { type: "externalSandbox" } },
			{ sandbox: undefined },
			{ approvalPolicy: undefined },
			{ approvalPolicy: "untrusted" },
			{ activePermissionProfile: { id: "managed", extends: id } },
			{ activePermissionProfile: { id, extends: "managed" } },
			{ activePermissionProfile: {} },
		])
			assert.match(
				codexPermissionMismatch(requested, { ...actual, ...patch }),
				/requirements\.toml or managed configuration/,
			);
	}
	const message = codexPermissionMismatch(free, {
		...response,
		approvalPolicy: "on-request",
	});
	assert.match(
		message,
		/requested sandbox=danger-full-access, approvalPolicy=never/,
	);
	assert.match(
		message,
		/effective sandbox=dangerFullAccess, approvalPolicy=on-request/,
	);
});

async function run(
	t,
	{
		resume = false,
		effective = response,
		stderr = [],
		readOnly = false,
		mcpServers = [],
	} = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "aw-effective-"));
	// The stub app-server can still be finishing its writes when the test ends (CI macOS/Node 26:
	// ENOTEMPTY); retry like the shared test cleanup.
	t.after(() =>
		rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	);
	const warning = {
		method: "configWarning",
		params: {
			summary: "Configured value disallowed by requirements",
			details: "falling back to required value",
		},
	};
	const wait = (match, steps) => ({
		awaitStdin: { branches: [{ match, steps }], otherwise: [{ exit: 70 }] },
	});
	const cli = await createStubCli({
		dir,
		scripts: [
			{
				steps: [
					wait('"method":"initialize"', [{ stdout: { id: 1, result: {} } }]),
					wait('"method":"initialized"', []),
					wait('"method":"config/read"', [
						{ stdout: { id: 2, result: { config: {} } } },
					]),
					wait(`"method":"thread/${resume ? "resume" : "start"}"`, [
						{ stdout: warning },
						{
							stdout: {
								id: 3,
								result: { thread: { id: "thread-test" }, ...effective },
							},
						},
					]),
					wait('"method":"mcpServerStatus/list"', [
						{ stdout: { id: 4, result: { data: [] } } },
					]),
					wait('"method":"turn/start"', [
						{ stdout: { id: 5, result: { turn: { id: "turn-test" } } } },
						...stderr.map((text) => ({ stderr: text })),
						{ sleepMs: 100 },
						{
							stdout: {
								method: "turn/completed",
								params: { turn: { id: "turn-test", status: "completed" } },
							},
						},
					]),
				],
			},
		],
	});
	const executor = createExecutor({
		codexPath: cli.path,
		stateDir: join(dir, "state"),
	});
	const key = "effective-check";
	const gate = createAuthorityGate({ attemptKey: key });
	const ref = await executor.submit({
		attemptKey: key,
		authority: gate.authority,
		cwd: dir,
		prompt: "p",
		tools: ["bash"],
		readOnly,
		permissionMode: "free",
		mcpServers,
		deadlineMs: Date.now() + 5000,
		env: { TEST_SECRET: "hidden-secret-value" },
		isolation: { inherit: false },
		approvalPolicy: defaultApprovalPolicy(),
		artifactsDir: join(dir, "artifacts"),
		...(resume ? { resumeSessionId: "thread-test" } : {}),
	});
	const events = [];
	for await (const event of executor.observe(ref)) events.push(event);
	return {
		events,
		stdin: (await cli.invocations())[0].stdin,
		transcript: await readFile(
			join(dir, "artifacts", "codex-app-server.jsonl"),
			"utf8",
		),
	};
}

for (const resume of [false, true])
	test(`thread/${resume ? "resume" : "start"} fallback fails config before any turn and retains startup warnings`, async (t) => {
		const { events, stdin, transcript } = await run(t, {
			resume,
			effective: {
				sandbox: { type: "readOnly" },
				approvalPolicy: "on-request",
				activePermissionProfile: { id: ":read-only" },
			},
		});
		assert.deepEqual(
			events.map((event) => event.type),
			["started", "failed"],
		);
		assert.equal(events.at(-1).class, "config");
		assert.match(events.at(-1).message, /no turn was started/);
		assert.equal(
			stdin.some((line) => line.includes('"method":"turn/start"')),
			false,
		);
		assert.equal(
			stdin.some((line) => line.includes('"method":"mcpServerStatus/list"')),
			false,
		);
		assert.match(transcript, /configWarning/);
		assert.match(transcript, /falling back to required value/);
	});

test("matching permissions start a turn; stderr denials are emitted and redacted without failing completion", async (t) => {
	const reason =
		"`touch hidden-secret-value` rejected: policy forbids commands starting with `touch`";
	const stderr = [
		`\x1b[31mERROR\x1b[0m codex_core::tools::router: error=exec_command failed: CreateProcess { message: ${JSON.stringify(`Rejected(${JSON.stringify(reason)})`)} }`,
		"ERROR unrelated",
	];
	const { events, transcript, stdin } = await run(t, { stderr });
	assert.equal(events.at(-1).type, "completed");
	assert.equal(
		stdin.some((line) => line.includes('"method":"turn/start"')),
		true,
	);
	const denied = events.filter((event) => event.type === "tool_call");
	assert.equal(denied.length, 1);
	assert.equal(denied[0].status, "denied");
	assert.equal(JSON.stringify(events).includes("hidden-secret-value"), false);
	assert.equal(transcript.includes("hidden-secret-value"), false);
	assert.match(denied[0].output, /redacted/);
	assert.match(transcript, /exec_command failed/);
});

test("provider requirements refusals classify as config rather than unknown or retryable", () => {
	for (const message of [
		'`approval_policy = "never"` cannot be used because requirements do not allow `sandbox_mode = "danger-full-access"`',
		"Configured value for sandbox_mode is disallowed by requirements",
	])
		assert.equal(classifyCodexFailure({ message }), "config");
});

test("free readOnly starts Codex danger-full-access/never and accepts foreign MCP", async (t) => {
	const { events, stdin } = await run(t, {
		readOnly: true,
		mcpServers: [{ name: "other", command: "node", args: [] }],
	});
	assert.equal(events.at(-1).type, "completed");
	const start = stdin
		.map((line) => JSON.parse(line))
		.find((message) => message.method === "thread/start");
	assert.equal(start.params.sandbox, "danger-full-access");
	assert.equal(start.params.approvalPolicy, "never");
	assert.equal(start.params.config["mcp_servers.other.enabled"], true);
});
