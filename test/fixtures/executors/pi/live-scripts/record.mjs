#!/usr/bin/env node
// Turn one recorded Pi run into a scrubbed transcript fixture (WP6).
//   node record.mjs <name> <stdout.jsonl> <stderr file> <exitCode|signal> <source text> [model]
// Writes test/fixtures/executors/pi/transcripts/<name>.json and refuses to write when the scrubbed
// result still matches a forbidden pattern.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findForbidden, scrubText, scrubTranscriptLine } from "../scrub.mjs";

const [name, stdoutPath, stderrPath, exit, source, model] =
	process.argv.slice(2);
const read = (path) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};
const stdout = read(stdoutPath)
	.split("\n")
	.filter((line) => line.trim() !== "")
	.map(scrubTranscriptLine);
const stderr = scrubText(read(stderrPath));
const signal = /^SIG/u.test(exit) ? exit : null;
const transcript = {
	schema: "agent-workflow-pi-transcript-v1",
	name,
	source,
	piVersion: "1.1.0",
	model: model ?? null,
	exitCode: signal === null ? Number(exit) : null,
	signal,
	stdout,
	stderr,
};
const text = `${JSON.stringify(transcript, null, 1)}\n`;
const problems = findForbidden(text);
if (problems.length > 0) {
	console.error(`refusing ${name}: ${problems.join(", ")}`);
	process.exit(1);
}
const target = fileURLToPath(
	new URL(`../transcripts/${name}.json`, import.meta.url),
);
writeFileSync(target, text);
console.log(`${target}: ${stdout.length} lines, ${text.length} bytes`);
