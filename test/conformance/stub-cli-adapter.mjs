// Example process adapter + conformance harness built on the kit's stub CLI.
// It shows how a real adapter (WP6–WP8) plugs into `runConformance`: the adapter spawns a CLI
// binary, the harness points it at a stub CLI scripted per scenario and counts launches from the
// stub's invocation log. The "wire format" here is one normalized ExecEvent per stdout line; real
// adapters script their CLI's own format (stream-json, JSON-RPC, …) instead.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
	EXECUTOR_CONTRACT_VERSION,
	SdkError,
	classifyFailure,
	level,
	noneCapabilities,
	requireReleased,
	validateExecEvent,
	validateSubmitRequest,
} from "../../dist/sdk/index.js";
import { createStubCli } from "../../dist/sdk/conformance/index.js";

const ERROR_RULES = [
	{ class: "rate_limit", match: "429" },
	{ class: "auth", match: "not logged in" },
	{ class: "config", match: "unknown model" },
	{ class: "permanent", match: "context too long" },
	{ class: "transient", match: "connection reset" },
];

const CAPABILITIES = {
	...noneCapabilities(),
	mcpInjection: level("native"),
	partialStream: level("native"),
	usage: { ...level("native"), detail: "tokens" },
	toolTelemetry: level("native"),
	cancel: { ...level("native"), detail: "kill" },
};

/** Durable-state stand-in shared across "restarts". */
export function createAdapterStore() {
	return { attempts: new Map() };
}

export function createStubCliExecutor({ cliPath, store }) {
	const inflight = new Map();
	const runs = new Map(); // in-process view; store.attempts holds what survives a restart

	const emit = (run, event) => {
		if (run.done) return;
		run.log.push(event);
		if (event.type === "completed" || event.type === "failed") run.done = true;
		for (const wake of run.waiters.splice(0)) wake();
	};

	async function launch(req) {
		const known = store.attempts.get(req.attemptKey);
		if (known?.ref) return known.ref;
		if (known?.state === "consumed")
			throw new SdkError(
				"AUTHORITY_ALREADY_CONSUMED",
				`attempt ${req.attemptKey} consumed without launch evidence`,
			);
		if (known?.state === "revoked")
			throw new SdkError(
				"AUTHORITY_REVOKED",
				`attempt ${req.attemptKey} was revoked`,
			);
		const decision = await req.authority.consume(); // immediately before the first effect (R#1)
		if (decision.kind === "revoked")
			store.attempts.set(req.attemptKey, { state: "revoked" });
		requireReleased(decision);
		store.attempts.set(req.attemptKey, { state: "consumed" });
		// MCP servers go to a 0600 config file; their env (secrets) never touches argv.
		const mcpConfig = join(req.cwd, `.mcp-${req.attemptKey}.json`);
		await writeFile(mcpConfig, JSON.stringify({ mcpServers: req.mcpServers }), {
			mode: 0o600,
		});
		const child = spawn(
			cliPath,
			["run", "--attempt", req.attemptKey, "--mcp-config", mcpConfig],
			{
				cwd: req.cwd,
				env: { ...process.env, ...req.env },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const ref = {
			executorId: "stub-cli",
			attemptKey: req.attemptKey,
			handle: `pid:${child.pid}`,
		};
		const run = {
			ref,
			log: [],
			done: false,
			waiters: [],
			child,
			cancelled: false,
			pending: new Set(),
			answered: new Set(),
		};
		runs.set(req.attemptKey, run);
		store.attempts.set(req.attemptKey, { state: "spawned", ref, run });
		child.stdin.on("error", () => {}); // late answers after exit must not crash the adapter
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		createInterface({ input: child.stdout }).on("line", (line) => {
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (validateExecEvent(event).length > 0) return;
			if (event.type === "approval_request") {
				run.pending.add(event.requestId);
				// Fail closed (D2): unanswered approvals are denied when the policy timeout expires.
				const timer = setTimeout(
					() => answer(run, event.requestId, "deny"),
					req.approvalPolicy.timeoutMs,
				);
				timer.unref();
			}
			emit(run, event);
		});
		child.on("close", (code) => {
			if (run.cancelled)
				emit(run, {
					type: "failed",
					class: "cancelled",
					message: "cancelled by request",
					raw: null,
				});
			const message = stderr.trim() || `exit ${code}`;
			emit(run, {
				type: "failed",
				class: classifyFailure({ message, exitCode: code }, ERROR_RULES),
				message,
				raw: { stderr, exitCode: code },
			});
		});
		return ref;
	}

	const answer = (run, requestId, decision) => {
		if (run.answered.has(requestId)) return "too_late";
		if (!run.pending.has(requestId)) return "unknown_request";
		run.pending.delete(requestId);
		run.answered.add(requestId);
		run.child.stdin.write(`${JSON.stringify({ requestId, decision })}\n`);
		return "accepted";
	};

	const findRun = (ref) => {
		const run = store.attempts.get(ref.attemptKey)?.run;
		if (run === undefined || run.ref.handle !== ref.handle)
			throw new SdkError(
				"UNKNOWN_EXEC_REF",
				`unknown exec ref ${ref.attemptKey}/${ref.handle}`,
			);
		return run;
	};

	return {
		id: "stub-cli",
		version: "0.1.0",
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		async probe() {
			const output = await new Promise((resolve) => {
				const child = spawn(cliPath, ["--version"], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let text = "";
				child.stdout.on("data", (chunk) => {
					text += chunk;
				});
				child.on("close", () => resolve(text.trim()));
				child.on("error", () => resolve(""));
			});
			return {
				installed: output !== "",
				cliVersion: output || null,
				auth: "unknown",
				mcpOutputLimitChars: null,
			};
		},
		capabilities: () => CAPABILITIES,
		async submit(req) {
			const problems = validateSubmitRequest(req);
			if (problems.length > 0)
				throw new SdkError("INVALID_REQUEST", problems.join("; "));
			const pending = inflight.get(req.attemptKey);
			if (pending) return pending;
			const launching = launch(req);
			inflight.set(req.attemptKey, launching);
			try {
				return await launching;
			} finally {
				inflight.delete(req.attemptKey);
			}
		},
		async *observe(ref) {
			const run = findRun(ref);
			let index = 0;
			for (;;) {
				while (index < run.log.length) yield run.log[index++];
				if (run.done) return;
				await new Promise((resolve) => run.waiters.push(resolve));
			}
		},
		async cancel(ref) {
			const run = store.attempts.get(ref.attemptKey)?.run;
			if (run === undefined) return "no_active";
			if (run.done) return "too_late";
			run.cancelled = true;
			run.child.kill("SIGTERM");
			return "cancelled";
		},
		async reconcile(attemptKey) {
			const attempt = store.attempts.get(attemptKey);
			if (attempt === undefined || attempt.state === "revoked")
				return { absent: true };
			if (attempt.ref) return { found: attempt.ref };
			return { unknown: true, reason: "consumed without launch evidence" };
		},
		async respond(ref, requestId, decision) {
			return answer(findRun(ref), requestId, decision);
		},
	};
}

const line = (event) => ({ stdout: event });
const started = line({ type: "started", sessionId: null });
const fail = (stderr, exit) => [started, { stderr }, { exit }];

/** Stub CLI scripts per scenario, in this adapter's wire format. */
export const STUB_SCENARIOS = {
	complete: [
		started,
		line({ type: "message_delta", text: "stub " }),
		line({ type: "message_delta", text: "ok" }),
		line({
			type: "usage",
			input: 7,
			output: 2,
			cached: null,
			cost: null,
			source: "unknown",
		}),
		line({ type: "completed", finalText: "stub ok" }),
	],
	usage_unknown: [
		started,
		line({
			type: "usage",
			input: 7,
			output: 2,
			cached: null,
			cost: null,
			source: "unknown",
		}),
		line({ type: "completed", finalText: "no cost" }),
	],
	slow: [started, { hang: true }],
	approval: [
		started,
		line({
			type: "approval_request",
			requestId: "ap-1",
			kind: "execute",
			detail: "echo hi",
		}),
		{
			awaitStdin: {
				timeoutMs: 5000,
				branches: [
					{
						match: '"allow"',
						steps: [
							line({
								type: "tool_call",
								name: "bash",
								kind: "execute",
								status: "completed",
							}),
							line({ type: "completed", finalText: "approval:allow" }),
						],
					},
					{
						match: '"deny"',
						steps: [
							line({
								type: "tool_call",
								name: "bash",
								kind: "execute",
								status: "denied",
							}),
							line({ type: "completed", finalText: "approval:deny" }),
						],
					},
				],
				otherwise: [
					line({
						type: "tool_call",
						name: "bash",
						kind: "execute",
						status: "denied",
					}),
					line({ type: "completed", finalText: "approval:timeout" }),
				],
			},
		},
	],
	fail_transient: fail("upstream connection reset", 1),
	fail_rate_limit: fail("HTTP 429 rate limited", 1),
	fail_auth: fail("error: not logged in", 1),
	fail_config: fail("unknown model: x", 2),
	fail_permanent: fail("prompt rejected: context too long", 1),
	fail_unknown: fail("segmentation fault in flux module", 139),
};

/** Conformance harness: one stub CLI per session, launches counted from the invocation log. */
export function createStubCliHarness() {
	return {
		name: "stub-cli-adapter",
		scenarios: Object.keys(STUB_SCENARIOS),
		async open(scenario) {
			const dir = await mkdtemp(join(tmpdir(), "aw-stub-cli-"));
			await mkdir(dir, { recursive: true });
			const cli = await createStubCli({
				dir,
				scripts: [
					{
						name: "version",
						when: { argvIncludes: ["--version"] },
						effect: false,
						steps: [{ stdout: "stub-cli 1.0.0" }],
					},
					{
						name: scenario,
						when: { argvIncludes: ["run"] },
						steps: STUB_SCENARIOS[scenario],
					},
				],
			});
			const store = createAdapterStore();
			const forAttempt = (attemptKey) => (invocation) =>
				attemptKey === undefined || invocation.argv.includes(attemptKey);
			return {
				executor: createStubCliExecutor({ cliPath: cli.path, store }),
				effectCount: (attemptKey) => cli.effectCount(forAttempt(attemptKey)),
				launches: (attemptKey) => cli.launches(forAttempt(attemptKey)),
				restart: async () =>
					createStubCliExecutor({ cliPath: cli.path, store }),
				async dispose() {
					for (const attempt of store.attempts.values())
						attempt.run?.child.kill("SIGKILL");
					await rm(dir, { recursive: true, force: true });
				},
			};
		},
	};
}
