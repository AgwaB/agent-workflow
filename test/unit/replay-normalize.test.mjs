import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	compareTrees,
	createContext,
	loadAllowedDifferences,
	normalizeTree,
	replayKey,
} from "../replay/normalize.mjs";

const fixturesRoot = fileURLToPath(
	new URL("../replay/fixtures/", import.meta.url),
);
const fixtures = readdirSync(fixturesRoot, { withFileTypes: true })
	.filter(
		(entry) =>
			entry.isDirectory() &&
			existsSync(join(fixturesRoot, entry.name, "fixture.json")),
	)
	.map((entry) => entry.name)
	.sort();

test("replay fixtures include the minimal recording", () => {
	assert.ok(fixtures.includes("minimal"), `fixtures: ${fixtures.join(", ")}`);
});

for (const name of fixtures) {
	const fixture = join(fixturesRoot, name);
	test(`replay policy reproduces the committed normalized tree of the ${name} recording`, (t) => {
		if (!existsSync(join(fixture, "run"))) {
			t.skip("run/ is not committed for this fixture (see LARGE.md)");
			return;
		}
		const out = mkdtempSync(join(tmpdir(), "aw-replay-normalize-"));
		try {
			normalizeTree(join(fixture, "run"), join(out, "n"), createContext({}), {
				allowed: loadAllowedDifferences(),
			});
			assert.deepEqual(
				compareTrees(join(fixture, "normalized"), join(out, "n")),
				[],
			);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});

	test(`${name} calls.jsonl parses and every call has a replay key`, () => {
		const lines = readFileSync(join(fixture, "calls.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean);
		assert.ok(lines.length > 0);
		const ctx = createContext({});
		const allowed = loadAllowedDifferences();
		let previous = 0;
		for (const line of lines) {
			const call = JSON.parse(line);
			assert.ok(call.seq > previous, "calls are in seq order");
			previous = call.seq;
			assert.match(
				replayKey(call.method, call.args, ctx, allowed).key,
				/^[0-9a-f]{64}$/,
			);
		}
	});
}
