// Conformance scenarios for the codex adapter as app-server transcripts. `complete`, `approval`,
// `slow` (interrupt) and the error rows replay scrubbed live recordings from `recorded/` where one
// exists; the rest are synthetic, built from the codex-cli 0.159.2 protocol
// (`codex app-server generate-ts`) with the same message shapes. Request ids follow the adapter's
// fixed order: 1 initialize, 2 config/read (isolation on), 3 thread/start, 4 mcpServerStatus/list,
// 5 turn/start, 6+ turn/interrupt.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTranscript } from "./replay.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
export const RECORDED_DIR = join(here, "recorded");

const THREAD = "019a0000-0000-7000-8000-000000000001";
const TURN = "019a0000-0000-7000-8000-0000000000a1";

const out = (msg) => ({ dir: "out", msg });
const inn = (msg) => ({ dir: "in", msg });
const note = (method, params) => inn({ method, params });

export function handshake({
	threadId = THREAD,
	turnId = TURN,
	ephemeral = true,
} = {}) {
	return [
		out({ id: 1, method: "initialize" }),
		inn({
			id: 1,
			result: {
				userAgent: "agent_workflow/0.159.2 (stub) (agent_workflow; 0.1.0)",
				codexHome: "<HOME>/.codex",
				platformFamily: "unix",
				platformOs: "macos",
			},
		}),
		out({ method: "initialized" }),
		out({ id: 2, method: "config/read" }),
		inn({
			id: 2,
			result: {
				config: {
					mcp_servers: { user_server: { command: "user-mcp", enabled: true } },
				},
				origins: {},
			},
		}),
		out({ id: 3, method: "thread/start" }),
		inn({
			id: 3,
			result: {
				thread: {
					id: threadId,
					sessionId: threadId,
					ephemeral,
					status: { type: "idle" },
					cwd: "<CWD>",
					cliVersion: "0.159.2",
					turns: [],
				},
				model: "gpt-5.6-luna",
				modelProvider: "openai",
				serviceTier: "default",
				cwd: "<CWD>",
				instructionSources: ["<HOME>/.codex/AGENTS.md"],
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
				sandbox: { type: "readOnly", networkAccess: false },
				reasoningEffort: "low",
			},
		}),
		note("thread/started", { thread: { id: threadId } }),
		out({ id: 4, method: "mcpServerStatus/list" }),
		inn({
			id: 4,
			result: { data: [{ name: "user_server", tools: {} }], nextCursor: null },
		}),
		out({ id: 5, method: "turn/start" }),
		inn({
			id: 5,
			result: {
				turn: { id: turnId, items: [], status: "inProgress", error: null },
			},
		}),
		note("turn/started", {
			threadId,
			turn: { id: turnId, items: [], status: "inProgress", error: null },
		}),
	];
}

const usage = (input, output, cached = 0) =>
	note("thread/tokenUsage/updated", {
		threadId: THREAD,
		turnId: TURN,
		tokenUsage: {
			total: {
				totalTokens: input + output,
				inputTokens: input,
				cachedInputTokens: cached,
				cacheWriteInputTokens: 0,
				outputTokens: output,
				reasoningOutputTokens: 0,
			},
			last: {
				totalTokens: input + output,
				inputTokens: input,
				cachedInputTokens: cached,
				cacheWriteInputTokens: 0,
				outputTokens: output,
				reasoningOutputTokens: 0,
			},
			modelContextWindow: 272000,
		},
	});

const agentMessage = (text) => [
	note("item/started", {
		threadId: THREAD,
		turnId: TURN,
		item: { type: "agentMessage", id: "msg_1", text: "", phase: null },
	}),
	...text.split(/(?<= )/).map((delta) =>
		note("item/agentMessage/delta", {
			threadId: THREAD,
			turnId: TURN,
			itemId: "msg_1",
			delta,
		}),
	),
	note("item/completed", {
		threadId: THREAD,
		turnId: TURN,
		item: { type: "agentMessage", id: "msg_1", text, phase: "final_answer" },
	}),
];

const turnCompleted = (status, error = null) =>
	note("turn/completed", {
		threadId: THREAD,
		turn: { id: TURN, items: [], status, error },
	});

const failing = (error) => [
	...handshake(),
	note("error", { error, willRetry: false, threadId: THREAD, turnId: TURN }),
	turnCompleted("failed", error),
];

const commandItem = (status, extra = {}) => ({
	type: "commandExecution",
	id: "call_1",
	command: "/bin/zsh -lc 'echo hi > approved.txt'",
	cwd: "<CWD>",
	processId: null,
	source: "agent",
	status,
	commandActions: [{ type: "unknown", command: "echo hi > approved.txt" }],
	aggregatedOutput: null,
	exitCode: null,
	durationMs: null,
	...extra,
});

export const SYNTHETIC = {
	complete: [
		...handshake(),
		...agentMessage("stub ok"),
		usage(120, 8, 64),
		turnCompleted("completed"),
	],
	usage_unknown: [
		...handshake(),
		...agentMessage("no cost"),
		usage(100, 4),
		turnCompleted("completed"),
	],
	slow: [
		...handshake(),
		note("item/started", {
			threadId: THREAD,
			turnId: TURN,
			item: { type: "reasoning", id: "rs_1", summary: [], content: [] },
		}),
		{
			branches: [
				{
					match: '"method":"turn/interrupt"',
					entries: [inn({ id: 6, result: {} }), turnCompleted("interrupted")],
				},
			],
			otherwise: [{ exit: 0 }],
		},
	],
	approval: [
		...handshake(),
		note("item/started", {
			threadId: THREAD,
			turnId: TURN,
			item: commandItem("inProgress"),
		}),
		inn({
			id: 0,
			method: "item/commandExecution/requestApproval",
			params: {
				kind: "command",
				threadId: THREAD,
				turnId: TURN,
				itemId: "call_1",
				startedAtMs: 0,
				environmentId: null,
				reason: "write outside the sandbox",
				command: "/bin/zsh -lc 'echo hi > approved.txt'",
				cwd: "<CWD>",
			},
		}),
		{
			branches: [
				{
					match: '"decision":"accept"',
					entries: [
						note("serverRequest/resolved", { threadId: THREAD, requestId: 0 }),
						note("item/completed", {
							threadId: THREAD,
							turnId: TURN,
							item: commandItem("completed", {
								exitCode: 0,
								aggregatedOutput: "",
							}),
						}),
						...agentMessage("approval:allow"),
						turnCompleted("completed"),
					],
				},
				{
					match: '"decision":"decline"',
					entries: [
						note("serverRequest/resolved", { threadId: THREAD, requestId: 0 }),
						note("item/completed", {
							threadId: THREAD,
							turnId: TURN,
							item: commandItem("declined"),
						}),
						...agentMessage("approval:deny"),
						turnCompleted("completed"),
					],
				},
			],
			otherwise: [{ exit: 0 }],
		},
	],
	fail_transient: failing({
		message: "stream disconnected before completion",
		codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
		additionalDetails: null,
	}),
	fail_rate_limit: failing({
		message: "Rate limit reached for requests",
		codexErrorInfo: "rateLimitExceeded",
		additionalDetails: null,
	}),
	fail_auth: failing({
		message: "401 Unauthorized",
		codexErrorInfo: "unauthorized",
		additionalDetails: null,
	}),
	fail_config: failing({
		message:
			"The 'gpt-nope' model is not supported when using Codex with a ChatGPT account.",
		codexErrorInfo: "badRequest",
		additionalDetails: null,
	}),
	fail_permanent: failing({
		message: "Your input exceeds the context window of this model.",
		codexErrorInfo: "contextWindowExceeded",
		additionalDetails: null,
	}),
	fail_unknown: failing({
		message: "segmentation fault in flux module",
		codexErrorInfo: "other",
		additionalDetails: null,
	}),
	crash_after_consume: [...handshake(), turnCompleted("completed")],
};

/** Recorded transcript for a scenario when one was captured live, else the synthetic one. */
export function scenarioTranscript(scenario) {
	const recorded = join(RECORDED_DIR, `${scenario}.jsonl`);
	if (existsSync(recorded))
		return { source: "recorded", entries: readTranscript(recorded) };
	return { source: "synthetic", entries: SYNTHETIC[scenario] };
}
