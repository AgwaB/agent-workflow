// agent-workflow 2026-11-08 (context-quality E8): the final synthesis once told the reader that notes.md had a wrong
// QUIC v2 RFC number and should be corrected, although notes.md had no RFC numbers at all (the wrong number came from
// the research plan). The renderer lists such sentences as source-attribution warnings in the audit.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sourceAttributionWarnings } from "../../workflows/deep-research/helpers/render-executive.mjs";

async function project(files) {
	const root = await mkdtemp(join(tmpdir(), "aw-attribution-"));
	const cwd = join(root, "project");
	await mkdir(cwd, { recursive: true });
	for (const [name, text] of Object.entries(files))
		await writeFile(join(cwd, name), text);
	await writeFile(join(root, "outside.md"), "RFC 9368\n");
	return { root, cwd };
}

test("a correction blamed on a file that states no value of that kind is flagged", async (t) => {
	const { root, cwd } = await project({
		"notes.md": "# QUIC notes\n- QUIC에는 버전 1 이후의 새 버전도 있다.\n",
	});
	t.after(() => rm(root, { recursive: true, force: true }));
	const warnings = await sourceAttributionWarnings(
		[
			"notes.md의 QUIC v2 번호를 9369로 수정하고 RFC 9368의 버전 협상 역할을 별도로 명시한다.",
			"The notes.md entry for QUIC v2 (RFC 9368) is wrong.",
		],
		cwd,
	);
	assert.deepEqual(
		warnings.map((warning) => [warning.file, warning.values]),
		[
			["notes.md", ["9369", "9368"]],
			["notes.md", ["9368"]],
		],
	);
});

test("comparisons, corrections of values the file does state, and files outside the project are not flagged", async (t) => {
	const { root, cwd } = await project({
		"notes.md":
			"- 메모: HTTP/3 표준 문서는 RFC 9113이다.\n- 메모: RFC 9000은 2022년 5월에 발행되었다.\n",
	});
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.deepEqual(
		await sourceAttributionWarnings(
			[
				// Correction of a number the file states (9113) — may be right.
				"notes.md의 HTTP/3 식별자 RFC 9113을 RFC 9114로 교정한다.",
				// Correction of a date the file states.
				"notes.md는 RFC 9000을 2022년 5월로 잘못 기록했으며 공식 발행월은 2021년 5월이다.",
				// Comparison without a correction.
				"notes.md의 QUIC TLS 1.3 사용 주장은 RFC 9001과 일치한다.",
				// Outside the project: never read.
				"../outside.md has the wrong number 9999.",
				// No file named.
				"The plan's RFC 9368 was wrong; QUIC v2 is RFC 9369.",
			],
			cwd,
		),
		[],
	);
	assert.deepEqual(
		await sourceAttributionWarnings(
			["notes.md is wrong about 9369."],
			undefined,
		),
		[],
	);
});
