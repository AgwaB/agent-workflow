// Characterization of `/aw` and CLI argument handling (refactor D, 2026-11-04): the host API call
// and request each command line becomes, the usage errors, and the CLI --json results must stay as
// recorded in test/fixtures/command-parity/expected.json. An intended change:
// `node test/helpers/command-parity.mjs --write`, then review the diff.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { characterize, EXPECTED_PATH } from "../helpers/command-parity.mjs";

test("/aw and agent-workflow handle the recorded command lines as before", async () => {
	const actual = await characterize();
	const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));
	for (const section of ["pi", "cli", "cliJson"])
		for (const key of Object.keys(expected[section]))
			assert.deepEqual(
				actual[section][key],
				expected[section][key],
				`${section}: ${key}`,
			);
	assert.deepEqual(Object.keys(actual.pi), Object.keys(expected.pi));
	assert.deepEqual(Object.keys(actual.cli), Object.keys(expected.cli));
	assert.deepEqual(Object.keys(actual.cliJson), Object.keys(expected.cliJson));
});
