// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/deep-review-source-scope.test.mjs. MIT, same author. Changes: 2026-11-01 — a quote at most 10 lines outside its planned range is accepted (recorded), so the "not found" case moved 12 lines away; imports from dist/core (subagent-backend names from their WP4c modules); harness from test/helpers/; setSubagentApiForTests→setTaskRuntimeApiForTests; paths .pi/{workflows,agents,workflow-subagents}→.agent-workflow/…, env PI_WORKFLOW_*→AGENT_WORKFLOW_*.
import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	writeFileSync,
	rmSync,
	symlinkSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pipeline from "../../workflows/deep-review/helpers/finding-pipeline.mjs";

test("source coverage distinguishes unsupported scope and ranges without weakening containment", async () => {
	const root = mkdtempSync(join(tmpdir(), "review-scope-"));
	const outside = mkdtempSync(join(tmpdir(), "review-outside-"));
	try {
		writeFileSync(
			join(root, "source.txt"),
			`first\nexact quote\n${"filler\n".repeat(14)}last\n`,
		);
		writeFileSync(join(outside, "source.txt"), "exact quote\n");
		symlinkSync(join(outside, "source.txt"), join(root, "escape.txt"));
		for (const [pointer, issue] of [
			["source.txt:2-2", null],
			[join(root, "source.txt"), "repository-relative within the runtime cwd"],
			[
				join(outside, "source.txt"),
				"repository-relative within the runtime cwd",
			],
			["../outside/source.txt", "repository-relative within the runtime cwd"],
			["source.txt:1-2,3-4", "multiple source ranges are unsupported"],
			["escape.txt", "required source file is unavailable"],
			["missing.txt", "required source file is unavailable"],
			// agent-workflow 2026-11-01: a quote at most 10 lines outside the planned range is accepted
			// with a recorded correction; farther away it still fails.
			["source.txt:1", null],
			["source.txt:14", "content quote was not found"],
		]) {
			const result = await pipeline({
				sources: {
					triage: {
						reviewLenses: [{ id: "runtime", evidenceToInspect: [pointer] }],
					},
					"reviewers.runtime": {
						lens: "runtime",
						findings: [],
						evidenceChecked: [pointer],
						noIssueNotes: [],
						sourceCoverage: [
							{
								path: pointer,
								status: "read",
								evidence: "exact quote",
								artifact: "",
								reason: "",
							},
						],
					},
				},
				context: {
					cwd: root,
					sourceStatuses: [
						{
							source: "reviewers.runtime",
							specId: "reviewers.runtime",
							taskId: "task-1",
							stageId: "reviewers",
							itemIdentity: "runtime",
							placeholderSpecId: "reviewers.item",
							status: "completed",
						},
					],
				},
				options: { mode: "dedup" },
			});
			const failures = result.reviewerLedger.sourceCoverageFailures;
			if (issue === null) assert.equal(failures.length, 0, pointer);
			else {
				assert.equal(failures.length, 1, pointer);
				assert.ok(
					failures[0].statusDetail.includes(issue),
					`${pointer}: ${failures[0].statusDetail}`,
				);
			}
		}
	} finally {
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		rmSync(outside, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("triage teaches the same repository-contained source pointer contract", () => {
	const spec = JSON.parse(
		readFileSync(
			new URL("../../workflows/deep-review/spec.json", import.meta.url),
			"utf8",
		),
	);
	const prompt = spec.artifactGraph.stages.find(
		(stage) => stage.id === "triage",
	).prompt;
	assert.match(prompt, /relative to the runtime cwd/);
	assert.match(prompt, /comma-separated line ranges/);
	assert.match(prompt, /Cross-repository review requires separate runs/);
});
