// Replay SubagentApi: serves recorded pi-subagent responses from calls.jsonl
// (produced by src/subagent-api-recorder.ts with PI_WORKFLOW_RECORD_DIR) so the
// engine can be driven without Pi or a model. Inject with
// setSubagentApiForTests(createReplaySubagentApi(...)).
//
// Matching: method + replayKey(method, args) from ./normalize.mjs (same
// normalization as the run record; allowed-difference renaming applied per
// call) + the literal pi-subagent run/attempt ids in the arguments
// (replayQueueId). Replay hands out the recorded run/attempt ids verbatim, so
// they are reproducible; keeping them in the queue identity stops the polls of
// two attempts of one task (output retry, launch retry) from sharing a queue,
// which per-call id numbering would otherwise collapse into one key.
// Recorded calls for one queue are served in recorded order.
//   - Observation methods (status/reconcile/state reads, pure helpers) collapse
//     consecutive identical normalized responses and repeat the last response
//     once exhausted: poll counts are timing, not behavior.
//   - Effectful methods (launch, barrier create/release/revoke, interrupt, ...)
//     are served once each; an extra call throws.
// A miss throws with the closest recorded key for that method and a line diff
// of the canonical normalized arguments.
//
// Argument echo rebinding: when a matched call's replay arguments differ from
// the recorded ones only in normalized/allowed fields (e.g. a fresh random
// barrier directory, an env-derived subjectSha256), each differing recorded
// string is mapped to its replay value and that mapping is applied to every
// later recorded response and restored file. Real responses echo their
// request (descriptor.directory, subjectSha256, ready.subjectSha256, ...), so
// replayed responses must echo the replay request, not the recorded one.
//
// Side effects the real API leaves on disk are restored from the recording:
//   - createDurableLaunchBarrierV2: the recorded barrier directory files
//     (from <fixture>/run/...) are written at the returned descriptor.directory.
//   - first terminal getSubagentStatus for a task: <fixture>/subagent-runs/<taskId>
//     is written to <ROOT>/.pi/workflow-subagents/<workflowRunId>/<taskId>, and
//     the files the worker process itself writes into the workflow task directory
//     (WORKER_WRITTEN_TASK_FILES: the workflow_artifact read ledger) are restored
//     from <fixture>/run/tasks/<taskId>/. The engine checks required artifact
//     reads against that ledger after the worker ends.
//   - first terminal getSubagentStatus for a pi-subagent run R: when the fixture
//     has <fixture>/worker-snapshots/R/web-source-cache (recorded by
//     run-bundled.mjs --snapshot-web-cache when the engine first saw R terminal),
//     its files are written over <ROOT>/.pi/workflows/<workflowRunId>/web-source-cache.
//     Workers fill that shared cache during their run; support helpers read it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createContext, firstLineDiff, replayKey, restorePaths } from "./normalize.mjs";

const OBSERVATION_METHODS = new Set([
	"getSubagentStatus",
	"getSubagentLogs",
	"reconcileSubagentRun",
	"readDurableLaunchBarrierV2State",
	"supportsExplicitExtensionIsolation",
	"durableLaunchBarrierDigest",
	"formatPruneSubagentRunsSummary",
	"isDurableLaunchBarrierError",
	"isDurableLaunchBarrierRevokedError",
]);
const KNOWN_SYNC_METHODS = new Set([
	"supportsExplicitExtensionIsolation",
	"durableLaunchBarrierDigest",
	"formatPruneSubagentRunsSummary",
	"isDurableLaunchBarrierError",
	"isDurableLaunchBarrierRevokedError",
]);
// Files the worker (through the generated workflow_artifact extension) writes
// into <ROOT>/.pi/workflows/<workflowRunId>/tasks/<taskId>/ during its run.
const WORKER_WRITTEN_TASK_FILES = ["read-ledger.jsonl"];
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "timed_out", "timeout"]);

const SUBAGENT_IDS = /\b(?:run|attempt)_[0-9a-z]{6,12}_[0-9a-f]{6}\b/g;

/** Queue identity of a call: method, replay key, and literal subagent run/attempt ids in the args. */
export function replayQueueId(method, args, ctx, allowed = []) {
	const { key, canonical } = replayKey(method, args, ctx, allowed);
	const ids = [...new Set(JSON.stringify(args ?? null).match(SUBAGENT_IDS) ?? [])].sort();
	return { id: `${method}\0${key}\0${ids.join(",")}`, key, canonical };
}

export function readCalls(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line))
		.sort((left, right) => left.seq - right.seq);
}

function rebind(text, echoes) {
	let out = text;
	for (const [from, to] of echoes) out = out.split(from).join(to);
	return out;
}

function collectEchoes(recorded, replay, echoes) {
	if (typeof recorded === "string" && typeof replay === "string") {
		if (recorded !== replay && recorded.length >= 8 && !echoes.some(([from]) => from === recorded)) {
			echoes.push([recorded, replay]);
			echoes.sort((left, right) => right[0].length - left[0].length);
		}
		return;
	}
	if (Array.isArray(recorded) && Array.isArray(replay)) {
		recorded.forEach((entry, index) => collectEchoes(entry, replay[index], echoes));
		return;
	}
	if (recorded && replay && typeof recorded === "object" && typeof replay === "object") {
		for (const key of Object.keys(recorded)) collectEchoes(recorded[key], replay[key], echoes);
	}
}

function writeTreeRestored(fromDir, toDir, roots, echoes) {
	for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
		const source = join(fromDir, entry.name);
		const target = join(toDir, rebind(entry.name, echoes));
		if (entry.isDirectory()) writeTreeRestored(source, target, roots, echoes);
		else {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, rebind(restorePaths(readFileSync(source, "utf8"), roots), echoes));
		}
	}
}

/**
 * options:
 *   calls        recorded entries (portable form, see readCalls)
 *   surface      { methods: string[] } recorded API surface
 *   roots        replay host roots { ROOT, PKG, HOME, TMP } used to restore <ROOT>...
 *   allowed      allowed-difference entries (normalize.loadAllowedDifferences)
 *   fixtureDir   directory holding run/ and subagent-runs/ (portable form)
 */
export function createReplaySubagentApi(options) {
	const { calls, surface, roots, allowed = [], fixtureDir } = options;
	const recordedCtx = createContext({});
	const replayCtx = createContext(roots);
	const queues = new Map();
	const byMethod = new Map();
	for (const call of calls) {
		const { id, canonical } = replayQueueId(call.method, call.args, recordedCtx, allowed);
		if (!queues.has(id)) queues.set(id, { method: call.method, canonical, entries: [], served: 0 });
		const queue = queues.get(id);
		if (OBSERVATION_METHODS.has(call.method)) {
			const last = queue.entries.at(-1);
			const normalized = replayKey("result", [call.result ?? null, call.error ?? null], recordedCtx, allowed).key;
			if (last && last.normalized === normalized) continue;
			queue.entries.push({ ...call, normalized });
		} else queue.entries.push(call);
		if (!byMethod.has(call.method)) byMethod.set(call.method, []);
		if (!byMethod.get(call.method).includes(id)) byMethod.get(call.method).push(id);
	}
	const log = [];
	const materialized = new Set();
	const echoes = [];

	function materializeBarrier(result) {
		if (!fixtureDir || !result?.directory) return;
		const marker = `<ROOT>/.pi/workflows/`;
		const portableDir = result.directory;
		if (!portableDir.startsWith(marker)) return;
		const [, ...rest] = portableDir.slice(marker.length).split("/");
		const source = join(fixtureDir, "run", ...rest);
		if (!existsSync(source)) return;
		writeTreeRestored(source, rebind(restorePaths(portableDir, roots), echoes), roots, echoes);
	}

	function materializeSubagentRuns(args) {
		const runsDir = args?.[0]?.runsDir;
		const cwd = args?.[0]?.cwd;
		if (!fixtureDir || !runsDir || !cwd || materialized.has(runsDir)) return;
		materialized.add(runsDir);
		const source = join(fixtureDir, "subagent-runs");
		if (!existsSync(source)) return;
		// runsDir = .pi/workflow-subagents/<workflowRunId>/<taskId>; the fixture keeps <taskId>/...
		const taskDir = runsDir.split("/").at(-1);
		const from = join(source, taskDir);
		if (existsSync(from) && statSync(from).isDirectory()) writeTreeRestored(from, join(cwd, runsDir), roots, echoes);
		const workflowRunId = runsDir.split("/").at(-2);
		for (const file of WORKER_WRITTEN_TASK_FILES) {
			const recorded = join(fixtureDir, "run", "tasks", taskDir, file);
			if (!existsSync(recorded)) continue;
			const target = join(cwd, ".pi", "workflows", workflowRunId, "tasks", taskDir, file);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, rebind(restorePaths(readFileSync(recorded, "utf8"), roots), echoes));
		}
	}

	function materializeWorkerSnapshot(args, result) {
		const runsDir = args?.[0]?.runsDir;
		const cwd = args?.[0]?.cwd;
		const runId = result?.runId ?? args?.[0]?.runId;
		if (!fixtureDir || !runsDir || !cwd || !runId || materialized.has(`snapshot:${runId}`)) return;
		materialized.add(`snapshot:${runId}`);
		const source = join(fixtureDir, "worker-snapshots", runId, "web-source-cache");
		if (!existsSync(source)) return;
		const workflowRunId = runsDir.split("/").at(-2);
		writeTreeRestored(source, join(cwd, ".pi", "workflows", workflowRunId, "web-source-cache"), roots, echoes);
	}

	function miss(method, canonical) {
		const candidates = (byMethod.get(method) ?? []).map((id) => queues.get(id));
		if (candidates.length === 0) return new Error(`replay miss: no recorded calls for method ${method}`);
		let best;
		let bestScore = -1;
		for (const candidate of candidates) {
			const a = candidate.canonical;
			let score = 0;
			while (score < a.length && score < canonical.length && a[score] === canonical[score]) score += 1;
			if (score > bestScore) {
				best = candidate;
				bestScore = score;
			}
		}
		const pretty = (text) => JSON.stringify(JSON.parse(text), null, 2);
		const diff = firstLineDiff(pretty(best.canonical), pretty(canonical));
		return new Error(
			`replay miss for ${method}; closest recorded key differs at line ${diff?.line}:\n- recorded: ${diff?.a}\n+ replay:   ${diff?.b}`,
		);
	}

	function serve(method, args) {
		const { id, canonical } = replayQueueId(method, args, replayCtx, allowed);
		const queue = queues.get(id);
		if (process.env.PI_WORKFLOW_REPLAY_TRACE)
			process.stderr.write(`replay ${method} ${queue ? `queue ${queue.served}/${queue.entries.length}` : "MISS"} ${canonical.slice(0, process.env.PI_WORKFLOW_REPLAY_TRACE === "full" ? undefined : 160)}\n`);
		if (!queue) throw miss(method, canonical);
		let entry;
		if (queue.served < queue.entries.length) entry = queue.entries[queue.served++];
		else if (OBSERVATION_METHODS.has(method)) entry = queue.entries.at(-1);
		else throw new Error(`replay exhausted: ${method} was called more often than recorded (${queue.entries.length})`);
		log.push({ seq: entry.seq, method });
		collectEchoes(JSON.parse(restorePaths(JSON.stringify(entry.args), roots)), JSON.parse(JSON.stringify(args)), echoes);
		if (entry.error !== undefined) {
			const error = new Error(entry.error.message ?? "recorded error");
			if (entry.error.name) error.name = entry.error.name;
			if (entry.error.code !== undefined) error.code = entry.error.code;
			if (entry.error.failureKind !== undefined) error.failureKind = entry.error.failureKind;
			throw error;
		}
		const result =
			entry.result === undefined ? undefined : JSON.parse(rebind(restorePaths(JSON.stringify(entry.result), roots), echoes));
		if (method === "createDurableLaunchBarrierV2") materializeBarrier(entry.result);
		if (method === "getSubagentStatus" && TERMINAL.has(result?.status)) {
			materializeSubagentRuns(args);
			materializeWorkerSnapshot(args, result);
		}
		return result;
	}

	const api = {};
	const syncMethods = new Set(KNOWN_SYNC_METHODS);
	for (const call of calls) if (call.sync === true) syncMethods.add(call.method);
	for (const method of surface?.methods ?? [...new Set(calls.map((call) => call.method))]) {
		api[method] = syncMethods.has(method)
			? (...args) => serve(method, args)
			: async (...args) => serve(method, args);
	}
	Object.defineProperty(api, "replayLog", { value: log, enumerable: false });
	Object.defineProperty(api, "replayUnserved", {
		enumerable: false,
		value: () =>
			[...queues.values()]
				.filter((queue) => !OBSERVATION_METHODS.has(queue.method) && queue.served < queue.entries.length)
				.map((queue) => ({ method: queue.method, remaining: queue.entries.length - queue.served })),
	});
	return api;
}
