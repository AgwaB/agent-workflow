// WP6: recorded Pi transcripts and the live-call log are scrubbed — no tokens, emails, account
// ids, home paths or host names — and every transcript is well-formed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	findForbidden,
	scrubText,
	scrubTranscriptLine,
} from "../fixtures/executors/pi/scrub.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = join(root, "test/fixtures/executors/pi");

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

test("Pi fixtures and docs carry no secrets, emails, home paths or host names", () => {
	const targets = [...files(fixtures), join(root, "docs/executors.md")];
	const offenders = [];
	for (const path of targets) {
		const text = readFileSync(path, "utf8");
		// The scrubber's own source spells the patterns; check it for machine values only.
		const machineOnly = path.endsWith("scrub.mjs");
		const found = machineOnly
			? findForbidden(text).filter((name) =>
					["home directory", "host name"].includes(name),
				)
			: findForbidden(text);
		if (found.length > 0)
			offenders.push(`${relative(root, path)}: ${found.join(", ")}`);
	}
	assert.deepEqual(offenders, []);
});

test("transcripts are scrub-stable, well-formed and say where they came from", () => {
	const dir = join(fixtures, "transcripts");
	const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	assert.ok(names.length >= 10, `only ${names.length} transcripts`);
	for (const name of names) {
		const transcript = JSON.parse(readFileSync(join(dir, name), "utf8"));
		assert.equal(transcript.schema, "agent-workflow-pi-transcript-v1", name);
		assert.equal(`${transcript.name}.json`, name);
		assert.match(transcript.source, /^(live #\d+|offline)/u, name);
		assert.equal(transcript.piVersion, "1.1.0");
		for (const line of transcript.stdout) {
			assert.doesNotThrow(() => JSON.parse(line), `${name}: non-JSON line`);
			assert.equal(
				scrubTranscriptLine(line),
				line,
				`${name}: line is not scrub-stable`,
			);
		}
		assert.equal(
			scrubText(transcript.stderr),
			transcript.stderr,
			`${name}: stderr`,
		);
	}
});

test("scrubber removes keys, emails, home paths and temp paths", () => {
	const dirty = [
		"Incorrect API key provided: sk-proj-abc123def456ghi.",
		"mail someone@example.org",
		// Built from parts: the public-surface check refuses literal home paths in tracked files.
		`${["", "Users", "someone", "project"].join("/")} and ${["", "home", "someone", "x"].join("/")}`,
		"/private/tmp/aw-live-pi-live03-smoke-AbC123/cwd",
		"/var/folders/gn/xyz/T/pi-mcp-1.txt",
		"AIzaSyA1234567890abcdefghijklmnopqrstu",
	].join("\n");
	const clean = scrubText(dirty);
	assert.deepEqual(findForbidden(clean, { machine: false }), []);
	assert.match(clean, /sk-<REDACTED>/u);
	assert.match(clean, /<TMP>\/aw-live-pi-live03-smoke\/cwd/u);
	assert.match(clean, /<TMPDIR>\/pi-mcp-1\.txt/u);
});
