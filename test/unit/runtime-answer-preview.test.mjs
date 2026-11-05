import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAttemptArtifactStore } from "../../dist/runtime/artifacts/store.js";
import { readAnswerPreview } from "../../dist/runtime/artifacts/preview.js";
import { test } from "node:test";

test("answer-preview", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-workflow-answer-preview-"));
	try {
		const store = await createAttemptArtifactStore({
			cwd,
			runId: "run_preview",
			attemptId: "attempt-1",
		});
		const output = await store.writeTextArtifact(
			"output",
			"한글🙂".repeat(1000),
		);
		const result = await store.writeResult({
			cwd,
			backend: "headless",
			status: "completed",
			artifacts: [output],
		});
		const preview = await readAnswerPreview(result);
		assert.ok(preview.text.length > 0);
		assert.ok(Buffer.byteLength(preview.text) <= 2048);
		assert.equal(
			preview.text.includes("�"),
			false,
			"UTF-8 boundary stays intact",
		);
		assert.equal(preview.truncated, true);
		assert.equal(preview.partial, false);
		assert.equal(
			(await readAnswerPreview({ ...result, status: "failed" })).partial,
			true,
		);
		assert.equal(
			(
				await readAnswerPreview({
					...result,
					metadata: { ...result.metadata, outputPartial: true },
				})
			).partial,
			true,
		);
		assert.equal(
			await readAnswerPreview({ ...result, status: "running" }),
			undefined,
		);
		assert.equal(
			await readAnswerPreview({ ...result, artifacts: [] }),
			undefined,
		);
		assert.equal(
			await readAnswerPreview({
				...result,
				artifacts: [{ type: "output", path: "../../etc/passwd" }],
			}),
			undefined,
		);
		assert.equal(
			await readAnswerPreview({ ...result, attemptId: "other-attempt" }),
			undefined,
		);
		const path = resolve(cwd, output.path);
		await writeFile(path, "short answer");
		assert.deepEqual(await readAnswerPreview(result), {
			text: "short answer",
			partial: false,
			truncated: false,
		});
		await writeFile(path, "");
		assert.equal(await readAnswerPreview(result), undefined);
		await rm(path);
		assert.equal(await readAnswerPreview(result), undefined);
		const sibling = join(cwd, "private.txt");
		await writeFile(sibling, "not output");
		await symlink(sibling, path);
		assert.equal(
			await readAnswerPreview(result),
			undefined,
			"do not follow symlinked artifacts",
		);
		await rm(path);
		await mkdir(path);
		assert.equal(
			await readAnswerPreview(result),
			undefined,
			"reject non-regular output",
		);
		await rm(path, { recursive: true });

		// [deferred-WP2a-2] The remainder of the source check drives the Pi extension
		// tool (src/index.ts) with a fake `pi` binary: answerPreview on sync, wait,
		// status, parallel and async/notify responses. It needs run/async + a
		// durable worker and is ported with WP2a-2.
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
