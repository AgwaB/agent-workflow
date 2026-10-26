// Turns a codex app-server transcript (the adapter's raw `codex-app-server.jsonl` format:
// `{dir: "out"|"in"|"stderr"|"meta", msg}`) into createStubCli steps. Every client line ("out")
// becomes an `awaitStdin` that matches the request method (or the response id) and then replays the
// server lines ("in") that followed it. Entries may also be `{branches: [{match, entries}],
// otherwise}` (approval allow/deny), `{sleepMs}`, `{exit}` or `{hang: true}`.
import { readFileSync } from "node:fs";

const UNEXPECTED = [
	{ stderr: "stub codex: unexpected client message" },
	{ exit: 70 },
];

export function matchFor(message) {
	if (typeof message.method === "string") return `"method":"${message.method}"`;
	if (message.id !== undefined) return `"id":${JSON.stringify(message.id)}`;
	throw new Error(`cannot match client message ${JSON.stringify(message)}`);
}

export function stepsFromTranscript(entries, start = 0) {
	const steps = [];
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.branches !== undefined) {
			steps.push({
				awaitStdin: {
					branches: entry.branches.map((branch) => ({
						match: branch.match,
						steps: stepsFromTranscript(branch.entries),
					})),
					otherwise: stepsFromTranscript(entry.otherwise ?? []),
				},
			});
			return steps;
		}
		if (entry.sleepMs !== undefined) steps.push({ sleepMs: entry.sleepMs });
		else if (entry.exit !== undefined) steps.push({ exit: entry.exit });
		else if (entry.hang === true) steps.push({ hang: true });
		else if (entry.dir === "in") steps.push({ stdout: entry.msg });
		else if (entry.dir === "stderr")
			steps.push({ stderr: String(entry.msg).trimEnd() });
		else if (entry.dir === "out") {
			steps.push({
				awaitStdin: {
					branches: [
						{
							match: matchFor(entry.msg),
							steps: stepsFromTranscript(entries, index + 1),
						},
					],
					otherwise: UNEXPECTED,
				},
			});
			return steps;
		}
		// "meta" entries are ignored.
	}
	return steps;
}

export function readTranscript(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}
