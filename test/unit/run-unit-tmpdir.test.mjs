// test-tier: integration
// 2026-11-10 (maintenance check): test files left mkdtemp(os.tmpdir()) directories behind — 2,836 under the user's
// TMPDIR after two days. test/run-unit.mjs now gives each file its own TMPDIR and removes it with the file's home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"run-unit.mjs",
);

test("a test file's temporary directories are removed with its run", () => {
	const work = mkdtempSync(join(tmpdir(), "run-unit-tmpdir-"));
	try {
		const report = join(work, "report.json");
		const fixture = join(work, "leaks.test.mjs");
		writeFileSync(
			fixture,
			[
				'import { mkdtempSync, writeFileSync } from "node:fs";',
				'import { tmpdir } from "node:os";',
				'import { join } from "node:path";',
				'import test from "node:test";',
				'test("leaves a temporary directory behind", () => {',
				'\tconst dir = mkdtempSync(join(tmpdir(), "leak-"));',
				"\twriteFileSync(process.env.RUN_UNIT_TMPDIR_REPORT, JSON.stringify({ tmp: tmpdir(), dir }));",
				"});",
				"",
			].join("\n"),
		);
		// Without NODE_TEST_CONTEXT: node:test refuses to run files from inside a test file otherwise.
		const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
		const result = spawnSync(process.execPath, [runner, fixture], {
			encoding: "utf8",
			env: { ...env, RUN_UNIT_TMPDIR_REPORT: report },
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.ok(
			existsSync(report),
			result.stdout.slice(-3000) + result.stderr.slice(-2000),
		);
		const { tmp, dir } = JSON.parse(readFileSync(report, "utf8"));
		assert.notEqual(tmp, tmpdir(), "the file ran with its own TMPDIR");
		assert.equal(existsSync(dir), false, `left behind: ${dir}`);
		assert.equal(existsSync(tmp), false, `TMPDIR left behind: ${tmp}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
