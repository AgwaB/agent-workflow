// Fake `codex app-server` for the WP12d-2 review regressions (#5 secret echo, #9 session
// ownership). No model, no network. It echoes the request env value `ECHO_SECRET` and every
// injected MCP server env value through a command item, an agent message and stderr (the stderr
// copy split across two writes), answers thread/resume and thread/delete, and appends every
// message it receives to `$FAKE_CODEX_LOG` when set.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const THREAD =
	process.env.FAKE_CODEX_THREAD ?? "019a0000-0000-7000-8000-00000000d201";
const TURN = "019a0000-0000-7000-8000-00000000d202";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (message) => {
	if (process.env.FAKE_CODEX_LOG)
		appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(message)}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mcpValues = [];
let threadId = THREAD;

function readMcpEnv(config) {
	for (const [key, value] of Object.entries(config ?? {}))
		if (
			/^mcp_servers\.[^.]+\.env$/.test(key) &&
			value &&
			typeof value === "object"
		)
			mcpValues.push(...Object.values(value));
}

async function runTurn() {
	// Keeps the turn running (round 3: deletion while an app-server is still in the session home).
	await sleep(Number(process.env.FAKE_CODEX_TURN_DELAY_MS ?? 0));
	const secrets = [process.env.ECHO_SECRET ?? "", ...mcpValues].filter(Boolean);
	const echoed = secrets.join(" ");
	const item = {
		type: "commandExecution",
		id: "call_echo",
		command: "/bin/sh -c 'env'",
		cwd: process.cwd(),
		processId: null,
		source: "agent",
		status: "inProgress",
		commandActions: [{ type: "unknown", command: "env" }],
		aggregatedOutput: null,
		exitCode: null,
		durationMs: null,
	};
	send({ method: "item/started", params: { threadId, turnId: TURN, item } });
	send({
		method: "item/completed",
		params: {
			threadId,
			turnId: TURN,
			item: {
				...item,
				status: "completed",
				aggregatedOutput: `tokens: ${echoed}\n`,
				exitCode: 0,
				durationMs: 1,
			},
		},
	});
	// The stderr copy is split inside each value across two writes (chunk boundary).
	for (const secret of secrets) {
		const half = Math.floor(secret.length / 2);
		process.stderr.write(`warn: token ${secret.slice(0, half)}`);
		await sleep(60);
		process.stderr.write(`${secret.slice(half)} leaked\n`);
		await sleep(20);
	}
	const text = `final answer mentions ${echoed}`;
	send({
		method: "item/completed",
		params: {
			threadId,
			turnId: TURN,
			item: { type: "agentMessage", id: "msg_1", text, phase: "final_answer" },
		},
	});
	send({
		method: "turn/completed",
		params: {
			threadId,
			turn: { id: TURN, items: [], status: "completed", error: null },
		},
	});
}

// Round 4: FAKE_CODEX_LINGER_MS keeps the server alive after its stdin closed (until killed).
const rl = createInterface({ input: process.stdin });
if (process.env.FAKE_CODEX_LINGER_MS)
	rl.once("close", () =>
		setTimeout(() => {}, Number(process.env.FAKE_CODEX_LINGER_MS)),
	);
rl.on("line", (line) => {
	const message = JSON.parse(line);
	// The home this app-server runs in (re-review 2026-11-09: kept sessions keep a private home).
	log(
		message.method === "initialize"
			? {
					...message,
					codexHome: process.env.CODEX_HOME ?? null,
					pid: process.pid,
				}
			: message,
	);
	const reply = (result) => send({ id: message.id, result });
	switch (message.method) {
		case "initialize":
			return reply({ userAgent: "fake", platformFamily: "unix" });
		case "config/read":
			return reply({ config: { mcp_servers: {} }, origins: {} });
		case "thread/start":
		case "thread/resume":
			readMcpEnv(message.params.config);
			threadId =
				message.method === "thread/resume" ? message.params.threadId : THREAD;
			return reply({
				thread: { id: threadId, turns: [] },
				model: "fake-model",
				sandbox: {
					type: {
						"read-only": "readOnly",
						"workspace-write": "workspaceWrite",
						"danger-full-access": "dangerFullAccess",
					}[message.params.sandbox],
				},
				approvalPolicy: message.params.approvalPolicy,
			});
		case "mcpServerStatus/list":
			return reply({ data: [], nextCursor: null });
		case "turn/start":
			reply({
				turn: { id: TURN, items: [], status: "inProgress", error: null },
			});
			void runTurn();
			return;
		case "thread/delete":
			// Round 4: a slow delete (FAKE_CODEX_DELETE_DELAY_MS) to race a resume against it.
			setTimeout(
				() => reply({}),
				Number(process.env.FAKE_CODEX_DELETE_DELAY_MS ?? 0),
			);
			return;
		default:
			if (message.id !== undefined) return reply({});
	}
});
