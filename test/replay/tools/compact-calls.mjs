#!/usr/bin/env node
// compact-calls.mjs <portable calls.jsonl> <out calls.jsonl>
//
// Drops observation-method polls that the replay SubagentApi would collapse
// anyway (../replay-subagent-api.mjs): for each replay queue (replayQueueId:
// method, replay key, literal subagent run/attempt ids), an
// observation call is kept only when its normalized response differs from the
// previous kept response for that key. Effectful calls are always kept. The
// result builds exactly the same replay queues as the full file, so replay is
// unchanged; only timing-dependent poll repetitions (and their seq numbers) are
// removed. Input must already be portable (tools/make-portable.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { createContext, loadAllowedDifferences, replayKey } from "../normalize.mjs"; // pi-workflow copy: "../../test/replay/normalize.mjs"
import { replayQueueId } from "../replay-subagent-api.mjs"; // pi-workflow copy: "../../test/replay/replay-subagent-api.mjs"

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

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	process.stderr.write("usage: compact-calls.mjs <calls.jsonl> <out.jsonl>\n");
	process.exit(2);
}
const allowed = loadAllowedDifferences();
const ctx = createContext({});
const lines = readFileSync(input, "utf8").split("\n").filter((line) => line.trim() !== "");
const calls = lines.map((line) => JSON.parse(line)).sort((left, right) => left.seq - right.seq);
const last = new Map();
const kept = [];
for (const call of calls) {
	if (OBSERVATION_METHODS.has(call.method)) {
		const { id } = replayQueueId(call.method, call.args, ctx, allowed);
		const normalized = replayKey("result", [call.result ?? null, call.error ?? null], ctx, allowed).key;
		if (last.get(id) === normalized) continue;
		last.set(id, normalized);
	}
	kept.push(call);
}
writeFileSync(output, kept.map((call) => JSON.stringify(call)).join("\n") + (kept.length ? "\n" : ""));
process.stdout.write(`compacted ${calls.length} -> ${kept.length} calls\n`);
