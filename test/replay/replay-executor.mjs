// WP1b replay executor: an executor module (`createExecutor(config)`) that serves the worker
// outcomes recorded from pi-workflow (test/replay/fixtures/<name>) to the agent-workflow engine.
// The engine selects it through the executor registry and a real runtime durable worker reloads it
// from its descriptor in a fresh process, so the run goes engine → core task backend → runtime
// durable worker → this module, with no Pi process, model or network.
//
// Match key (see docs/replay.md): `<taskId> NUL sha256(normalized task prompt)`.
//   - taskId: the third field of the engine attemptKey (`awf1:<runId>:<taskId>:<hex>`); on the
//     recorded side the second field of the pi-subagent `correlationId` (`<runId>:<taskId>`).
//   - normalized task prompt: SubmitRequest.prompt (recorded: runSubagent `task`) through the
//     replay normalization policy (normalize.mjs: portable paths, id/timestamp placeholders) and
//     the literal renames of allowed-differences.json (`renames` entries, agent-workflow literal →
//     pi-workflow literal). The system prompt is not part of the key; it is compared as a file.
//   - Only when no recorded launch has the key: digest bindings (digest-binding.mjs) proven
//     against the replay run directory replace replayed digests over renamed-literal bytes with
//     the recorded ones, and the key is recomputed; the serve entry lists the bindings used.
//   - Several recorded launches with the same key are served in recorded order (shared across
//     worker processes through the trace log); a resubmitted attemptKey gets the call it was
//     served before.
// A miss throws INVALID_REQUEST before the authority is consumed (no effect) and logs the closest
// recorded prompt for that task (or any task) with the first differing line.
//
// On a hit the module consumes the authority, reproduces the worker-side effects the engine
// observes, and emits the recorded outcome as normalized events:
//   1. artifact reads: every `read-ledger.jsonl` row the recorded worker wrote during this attempt
//      is re-issued as a `workflow_artifact` tools/call against the real artifact MCP server, spawned
//      from the request's `workflow_artifact` McpServerSpec (so it reads the task's
//      artifact-access.json and writes the ledger itself). The server gets
//      `--max-output-chars <MAX_MCP_OUTPUT_LIMIT_CHARS>`: the recorded Pi worker received these
//      results whole (its ledger rows say so), see docs/replay.md "What the replay cannot reproduce".
//   2. events: `started` (sessionId as the Pi adapter reports it), one `usage` event mapped from
//      the recorded Pi usage by the Pi adapter's own `usageFromPi`, then `completed` with the
//      recorded output.log text verbatim (host roots restored) or `failed` with the failure class
//      of the recorded failureKind. A kept Pi session is reported as `ownedSession`, like the Pi
//      adapter does for a requested session.
//
// Config (descriptor.config, JSON; persisted, so it holds paths only):
//   fixtureDir  absolute fixture directory (required)
//   roots       {ROOT, PKG, HOME, TMP} replay host roots; values may be arrays (required)
//   traceLog    absolute JSONL path; serve/miss/read entries are appended (required)
//   id          executor id (default "pi": the replay stands in for the Pi executor)
//   outputLimit artifact server --max-output-chars (default MAX_MCP_OUTPUT_LIMIT_CHARS; null = the
//               engine's server spec unchanged)
//   adapterChecks  true (default): before matching, refuse the request exactly as the Pi adapter's
//               pre-consume plan() does (effort level, tool mapping, MCP injection, server names),
//               using the adapter's own tables from dist/executors/pi. false: engine-only variant
//               (the recorded worker is served whatever tools the engine asks for).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyDigestBindings, proveDigestBindings } from "./digest-binding.mjs";
import {
	applyLiteralRenames,
	createContext,
	firstLineDiff,
	loadAllowedDifferences,
	normalizeText,
	restorePaths,
} from "./normalize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..", "..");
const distUrl = (path) => pathToFileURL(join(PKG, "dist", path)).href;

export const REPLAY_EXECUTOR_MODULE = fileURLToPath(import.meta.url);
export const REPLAY_EXECUTOR_VERSION = "0.1.0";

export function replayExecutorDescriptor(config) {
	return {
		id: config.id ?? "pi",
		version: REPLAY_EXECUTOR_VERSION,
		contractVersion: "0.1.0",
		module: REPLAY_EXECUTOR_MODULE,
		config,
	};
}

export function readJsonLines(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Prompt text in the comparison space: portable, placeholders, agent-workflow literals renamed. */
export function normalizedPrompt(text, ctx, renames) {
	const local = { ...ctx, ids: new Map(), idCounts: new Map() };
	return applyLiteralRenames(normalizeText(text, local), renames).text;
}

export function matchKey(taskId, normalized) {
	return `${taskId}\0${sha256(normalized)}`;
}

/**
 * Recorded worker launches of a fixture: one entry per runSubagent call, in recorded order, with
 * the recorded outcome (subagent-runs/<taskId>/<run>/attempts/<attempt>/{result.json,output.log})
 * and the read-ledger rows written during that attempt.
 */
export function loadRecordedWorkerCalls(fixtureDir, renames = []) {
	const recordedCtx = createContext({});
	const calls = readJsonLines(join(fixtureDir, "calls.jsonl")).filter(
		(call) => call.method === "runSubagent" && call.result,
	);
	const ledgers = new Map();
	const out = [];
	for (const call of calls) {
		const args = call.args[0];
		const taskId = String(args.correlationId ?? "").split(":")[1];
		const runId = call.result.runId;
		const attemptId = call.result.attemptId;
		const attemptDir = join(
			fixtureDir,
			"subagent-runs",
			taskId,
			runId,
			"attempts",
			attemptId,
		);
		const result = JSON.parse(
			readFileSync(join(attemptDir, "result.json"), "utf8"),
		);
		const outputText = readFileSync(join(attemptDir, "output.log"), "utf8");
		if (!ledgers.has(taskId))
			ledgers.set(
				taskId,
				readJsonLines(
					join(fixtureDir, "run", "tasks", taskId, "read-ledger.jsonl"),
				),
			);
		const started = Date.parse(result.startedAt ?? call.startedAt);
		const ended = Date.parse(result.completedAt ?? "9999-01-01T00:00:00Z");
		const reads = ledgers
			.get(taskId)
			.filter((row) => {
				const at = Date.parse(row.at);
				return at >= started && at <= ended;
			})
			.map((row) => ({
				source: row.source,
				artifact: row.artifact,
				...(row.path === undefined ? {} : { path: row.path }),
				...(row.maxItems === undefined ? {} : { maxItems: row.maxItems }),
				...(row.maxChars === undefined ? {} : { maxChars: row.maxChars }),
			}));
		const prompt = normalizedPrompt(args.task, recordedCtx, []);
		out.push({
			seq: call.seq,
			taskId,
			runId,
			attemptId,
			key: matchKey(taskId, prompt),
			prompt,
			sessionId: args.sessionId ?? null,
			result,
			outputText,
			reads,
		});
	}
	// Rows of the ledger that no attempt window covers would be silently lost; refuse instead.
	for (const [taskId, rows] of ledgers) {
		const covered = out
			.filter((call) => call.taskId === taskId)
			.reduce((sum, call) => sum + call.reads.length, 0);
		if (covered !== rows.length)
			throw new Error(
				`replay fixture ${fixtureDir}: ${rows.length - covered} read-ledger row(s) of ${taskId} fall outside every recorded attempt window`,
			);
	}
	void renames;
	return out;
}

/** Closest recorded prompt (longest common prefix) and the first differing line. */
export function closestRecordedCall(calls, taskId, prompt) {
	const candidates = calls.filter((call) => call.taskId === taskId);
	const pool = candidates.length > 0 ? candidates : calls;
	let best;
	let bestLength = -1;
	for (const call of pool) {
		let length = 0;
		const max = Math.min(call.prompt.length, prompt.length);
		while (length < max && call.prompt[length] === prompt[length]) length += 1;
		if (length > bestLength) {
			best = call;
			bestLength = length;
		}
	}
	return best === undefined
		? undefined
		: {
				taskId: best.taskId,
				seq: best.seq,
				commonPrefixChars: bestLength,
				diff: firstLineDiff(best.prompt, prompt),
			};
}

/** Recorded pi-subagent failureKind → SDK failure class (no fixture records a worker failure). */
export function failureClassFor(failureKind) {
	switch (failureKind) {
		case "rate_limit":
			return "rate_limit";
		case "auth":
			return "auth";
		case "cancelled":
		case "aborted":
		case "user_cancelled":
			return "cancelled";
		case "transient":
		case "timeout":
		case "stale":
			return "transient";
		case "context_length_exceeded":
		case "provider_input_invalid":
			return "permanent";
		default:
			return "unknown";
	}
}

function log(path, entry) {
	appendFileSync(
		path,
		`${JSON.stringify({ ...entry, pid: process.pid, at: Date.now() })}\n`,
	);
}

/** Minimal MCP stdio client: initialize, then one tools/call per read, then EOF and wait for exit. */
async function readThroughArtifactServer(server, reads, outputLimit) {
	const args = [...server.args];
	if (outputLimit !== null)
		args.push("--max-output-chars", String(outputLimit));
	const child = spawn(server.command, args, {
		env: { ...process.env, ...(server.env ?? {}) },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolve) =>
		child.on("exit", (code, signal) => resolve({ code, signal })),
	);
	const pending = new Map();
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const index = buffer.indexOf("\n");
			if (index < 0) break;
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const waiter = pending.get(message.id);
			if (waiter !== undefined) {
				pending.delete(message.id);
				waiter(message);
			}
		}
	});
	let nextId = 0;
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			nextId += 1;
			const id = nextId;
			pending.set(id, resolve);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
			exited.then(({ code }) => {
				if (pending.has(id))
					reject(
						new Error(
							`artifact MCP server exited (${code}) before answering ${method}: ${stderr.trim()}`,
						),
					);
			});
		});
	const results = [];
	try {
		const init = await request("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "agent-workflow-replay", version: "0.1.0" },
		});
		if (init.error) throw new Error(`initialize: ${init.error.message}`);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		for (const read of reads) {
			const response = await request("tools/call", {
				name: "workflow_artifact",
				arguments: { action: "read", ...read },
			});
			results.push({
				read,
				isError: response.result?.isError === true,
				error: response.error?.message,
				textChars: response.result?.content?.[0]?.text?.length ?? 0,
			});
		}
	} finally {
		child.stdin.end();
	}
	const { code } = await exited;
	if (code !== 0)
		throw new Error(`artifact MCP server exited ${code}: ${stderr.trim()}`);
	return results;
}

export async function createExecutor(config) {
	const { fixtureDir, traceLog } = config ?? {};
	if (typeof fixtureDir !== "string" || typeof traceLog !== "string")
		throw new Error("replay executor needs fixtureDir and traceLog");
	const id = config.id ?? "pi";
	const allowed = loadAllowedDifferences(undefined, { replay: true });
	const renames = allowed.flatMap((entry) => entry.renames ?? []);
	const ctx = createContext(config.roots ?? {});
	const recorded = loadRecordedWorkerCalls(fixtureDir, renames);
	const { createFakeExecutor } = await import(distUrl("sdk/testing/index.js"));
	const { usageFromPi } = await import(distUrl("executors/pi/parse.js"));
	const { SdkError } = await import(distUrl("sdk/errors.js"));
	const { MAX_MCP_OUTPUT_LIMIT_CHARS } = await import(
		distUrl("mcp/artifact-server/delivery.js")
	);
	const { PI_EFFORT_LEVELS, PI_EXECUTOR_TOOL_MAPPING } = await import(
		distUrl("executors/pi/argv.js")
	);
	const { mapTools } = await import(distUrl("sdk/tools.js"));
	const adapterChecks = config.adapterChecks !== false;
	/** The request checks of the Pi adapter's plan() that run before the authority is consumed. */
	const piAdapterChecks = (req) => {
		if (req.effort !== undefined && !PI_EFFORT_LEVELS.includes(req.effort))
			throw new SdkError(
				"INVALID_REQUEST",
				`effort ${req.effort} is not a Pi thinking level (${PI_EFFORT_LEVELS.join(", ")})`,
			);
		const mapped = mapTools(req.tools, PI_EXECUTOR_TOOL_MAPPING);
		if (mapped.unmapped.length > 0)
			throw new SdkError(
				"CAPABILITY_MISSING",
				`Pi executor has no mapping for tools: ${mapped.unmapped.join(", ")}`,
				{ subject: "toolAllowlist" },
			);
		const serverNames = new Set(req.mcpServers.map((server) => server.name));
		for (const tool of mapped.mcpTools)
			if (!serverNames.has(tool.server))
				throw new SdkError(
					"CAPABILITY_MISSING",
					`tool ${tool.tool} needs the MCP server ${tool.server}, which the request does not inject`,
					{ subject: "mcpInjection" },
				);
		for (const server of req.mcpServers)
			if (!/^[A-Za-z0-9_-]+$/u.test(server.name))
				throw new SdkError(
					"INVALID_REQUEST",
					`MCP server name ${server.name} is not valid for Pi (letters, digits, _ and -)`,
				);
	};
	const outputLimit =
		config.outputLimit === undefined
			? MAX_MCP_OUTPUT_LIMIT_CHARS
			: config.outputLimit;
	const sessionsRoot = join(
		process.env.AGENT_WORKFLOW_HOME ?? join(homedir(), ".agent-workflow"),
		"executors",
		"pi",
		"sessions",
	);

	const fixture = JSON.parse(
		readFileSync(join(fixtureDir, "fixture.json"), "utf8"),
	);
	/**
	 * Digest bindings (digest-binding.mjs) proven against the in-flight replay run directory: a
	 * prompt that quotes a digest over renamed-literal bytes (e.g. a helper's control digest over a
	 * source manifest that names the state path) is matched with the recorded digest substituted.
	 */
	const boundPrompt = (req, prompt) => {
		const bindings = proveDigestBindings({
			recordedDir: join(fixtureDir, "run"),
			replayedDir: join(
				[config.roots?.ROOT].flat()[0] ?? req.cwd,
				".agent-workflow",
				"workflows",
				req.attemptKey.split(":")[1],
			),
			recordedRoots:
				fixture.replayRoot === undefined
					? undefined
					: { ROOT: fixture.replayRoot },
			replayRoots: config.roots ?? {},
			renames,
		});
		const used = [...bindings]
			.filter(([hex]) => prompt.includes(hex))
			.map(([hex, binding]) => ({ replayed: hex, ...binding }));
		return {
			prompt: applyDigestBindings(prompt, bindings),
			used,
			proven: bindings.size,
		};
	};

	const choose = (req) => {
		const taskId = req.attemptKey.split(":")[2];
		let prompt = normalizedPrompt(req.prompt, ctx, renames);
		let key = matchKey(taskId, prompt);
		let digestBindings;
		const trace = readJsonLines(traceLog);
		const previous = trace.find(
			(entry) => entry.type === "serve" && entry.attemptKey === req.attemptKey,
		);
		if (previous !== undefined)
			return recorded.find((call) => call.seq === previous.seq);
		const served = new Set(
			trace.filter((entry) => entry.type === "serve").map((entry) => entry.seq),
		);
		const unserved = (candidateKey) =>
			recorded.find(
				(candidate) =>
					candidate.key === candidateKey && !served.has(candidate.seq),
			);
		let call = unserved(key);
		let bindingAttempt;
		if (call === undefined && !recorded.some((entry) => entry.key === key)) {
			const bound = boundPrompt(req, prompt);
			bindingAttempt = {
				proven: bound.proven,
				usedInPrompt: bound.used.length,
			};
			if (bound.used.length > 0) {
				prompt = bound.prompt;
				key = matchKey(taskId, prompt);
				digestBindings = bound.used;
				call = unserved(key);
			}
		}
		if (call !== undefined) {
			log(traceLog, {
				type: "serve",
				attemptKey: req.attemptKey,
				taskId,
				seq: call.seq,
				key: sha256(key),
				...(digestBindings === undefined ? {} : { digestBindings }),
			});
			return call;
		}
		const closest = closestRecordedCall(recorded, taskId, prompt);
		const exhausted = recorded.some((candidate) => candidate.key === key);
		log(traceLog, {
			type: "miss",
			attemptKey: req.attemptKey,
			taskId,
			key: sha256(key),
			exhausted,
			closest,
			...(bindingAttempt === undefined
				? {}
				: { digestBindings: bindingAttempt }),
		});
		throw new SdkError(
			"INVALID_REQUEST",
			exhausted
				? `replay miss for ${taskId}: every recorded launch with this prompt was already served`
				: `replay miss for ${taskId}: no recorded launch has this prompt; closest recorded ${closest?.taskId} seq ${closest?.seq}, first difference at line ${closest?.diff?.line}: recorded ${JSON.stringify(closest?.diff?.a)} replay ${JSON.stringify(closest?.diff?.b)}`,
		);
	};

	const scriptFor = (req, call) => {
		const sessionId = req.resumeSessionId ?? req.sessionId ?? null;
		const ownedSession =
			sessionId === null
				? undefined
				: { kind: "pi-session-dir", locator: join(sessionsRoot, sessionId) };
		const steps = [{ type: "started", sessionId }];
		const usage = usageFromPi(call.result.metadata?.usage);
		if (usage !== undefined) steps.push(usage);
		const text = restorePaths(call.outputText, config.roots ?? {});
		if (call.result.status === "completed")
			steps.push({
				type: "completed",
				finalText: text,
				...(ownedSession === undefined ? {} : { ownedSession }),
			});
		else
			steps.push({
				type: "failed",
				class: failureClassFor(call.result.failureKind),
				message: `recorded ${call.result.status}/${call.result.failureKind}`,
				raw: null,
				...(ownedSession === undefined ? {} : { ownedSession }),
			});
		return steps;
	};

	const inners = new Map();
	const probeInner = createFakeExecutor({
		id,
		version: REPLAY_EXECUTOR_VERSION,
	});
	return {
		id,
		version: REPLAY_EXECUTOR_VERSION,
		contractVersion: "0.1.0",
		probe: () => probeInner.probe(),
		capabilities: () => probeInner.capabilities(),
		async submit(req) {
			if (adapterChecks)
				try {
					piAdapterChecks(req);
				} catch (error) {
					log(traceLog, {
						type: "adapter-refusal",
						attemptKey: req.attemptKey,
						taskId: req.attemptKey.split(":")[2],
						code: error.code,
						message: error.message,
					});
					throw error;
				}
			const call = choose(req);
			let inner = inners.get(req.attemptKey);
			if (inner === undefined) {
				inner = createFakeExecutor({
					id,
					version: REPLAY_EXECUTOR_VERSION,
					script: scriptFor(req, call),
				});
				inners.set(req.attemptKey, inner);
			}
			const authority = {
				attemptKey: req.authority.attemptKey,
				async consume() {
					const decision = await req.authority.consume();
					log(traceLog, {
						type: "consume",
						attemptKey: req.attemptKey,
						outcome: decision.kind,
					});
					if (decision.kind !== "released" || call.reads.length === 0)
						return decision;
					const server = (req.mcpServers ?? []).find(
						(entry) => entry.name === "workflow_artifact",
					);
					if (server === undefined) {
						log(traceLog, {
							type: "read-unreproducible",
							attemptKey: req.attemptKey,
							reason: "request carries no workflow_artifact MCP server",
							reads: call.reads,
						});
						return decision;
					}
					const results = await readThroughArtifactServer(
						server,
						call.reads,
						outputLimit,
					);
					log(traceLog, {
						type: "reads",
						attemptKey: req.attemptKey,
						seq: call.seq,
						results,
					});
					return decision;
				},
			};
			return inner.submit({ ...req, authority });
		},
		observe: (ref) => inners.get(ref.attemptKey).observe(ref),
		async cancel(ref, scope) {
			const inner = inners.get(ref.attemptKey);
			return inner === undefined ? "no_active" : inner.cancel(ref, scope);
		},
		async reconcile(attemptKey) {
			const inner = inners.get(attemptKey);
			return inner === undefined
				? { unknown: true, reason: "attempt unknown to this replay process" }
				: inner.reconcile(attemptKey);
		},
		respond: (ref, requestId, decision) =>
			inners.get(ref.attemptKey).respond(ref, requestId, decision),
		async deleteOwnedSession() {
			return "not_found";
		},
	};
}

export function listFixtureNames(fixturesRoot) {
	return readdirSync(fixturesRoot, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(fixturesRoot, entry.name, "fixture.json")),
		)
		.map((entry) => entry.name)
		.sort();
}
