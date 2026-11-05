import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DURABLE_WORKER_SYSTEM_PROMPT_FILE,
	DURABLE_WORKER_TASK_FILE,
	assertDurableWorkerPayloadShape,
	resolveDurableWorkerPayload,
	writeDurableWorkerPayload,
} from "../../dist/runtime/durable-worker-payload.js";

test("durable-worker-payload", async () => {
	const sha256 = (value) => createHash("sha256").update(value).digest("hex");
	const root = await mkdtemp(join(tmpdir(), "agent-workflow-payload-"));
	try {
		// 1. Writer externalizes string prompts and references them by name, size, and digest.
		const attemptDir = join(root, "attempts", "attempt-1");
		await (await import("node:fs/promises")).mkdir(attemptDir, {
			recursive: true,
		});
		const payloadPath = join(attemptDir, "worker.json");
		const task =
			"Summarize the repository.\n\nWith a second paragraph and unicode: 안녕 ✓\n";
		const systemPrompt = "You are a careful worker.";
		const written = await writeDurableWorkerPayload({
			payloadPath,
			input: {
				task,
				systemPrompt,
				tools: ["read"],
				extensions: ["/tmp/explicit-extension.ts"],
				noExtensions: true,
				runsDir: ".agent-workflow/runs",
				async: true,
			},
			cwd: root,
			backend: "headless",
			runId: "run_payload_1",
			attemptId: "attempt-1",
			startedAt: "2026-09-02T00:00:00.000Z",
		});
		const stored = JSON.parse(await readFile(payloadPath, "utf8"));
		assert.equal(
			written.bytes,
			Buffer.byteLength(await readFile(payloadPath, "utf8"), "utf8"),
		);
		assert.equal(stored.input.task, undefined, "task must not be inlined");
		assert.equal(
			stored.input.systemPrompt,
			undefined,
			"systemPrompt must not be inlined",
		);
		assert.deepEqual(stored.input.tools, ["read"]);
		assert.deepEqual(stored.input.extensions, ["/tmp/explicit-extension.ts"]);
		assert.equal(stored.input.noExtensions, true);
		assert.deepEqual(stored.input.taskRef, {
			path: DURABLE_WORKER_TASK_FILE,
			bytes: Buffer.byteLength(task, "utf8"),
			sha256: sha256(Buffer.from(task, "utf8")),
		});
		assert.deepEqual(stored.input.systemPromptRef, {
			path: DURABLE_WORKER_SYSTEM_PROMPT_FILE,
			bytes: Buffer.byteLength(systemPrompt, "utf8"),
			sha256: sha256(Buffer.from(systemPrompt, "utf8")),
		});
		assert.equal(
			await readFile(join(attemptDir, DURABLE_WORKER_TASK_FILE), "utf8"),
			task,
		);
		assert.equal(
			await readFile(
				join(attemptDir, DURABLE_WORKER_SYSTEM_PROMPT_FILE),
				"utf8",
			),
			systemPrompt,
		);
		assert.deepEqual(written.sidecars, [
			join(attemptDir, DURABLE_WORKER_TASK_FILE),
			join(attemptDir, DURABLE_WORKER_SYSTEM_PROMPT_FILE),
		]);
		assert.ok(
			written.bytes < 800,
			`payload should be small, got ${written.bytes} bytes`,
		);

		// 2. Resolver restores the exact inline strings and drops the references.
		const resolved = await resolveDurableWorkerPayload(stored, payloadPath);
		assert.equal(resolved.input.task, task);
		assert.equal(resolved.input.systemPrompt, systemPrompt);
		assert.equal(resolved.input.taskRef, undefined);
		assert.equal(resolved.input.systemPromptRef, undefined);
		assert.deepEqual(resolved.input.tools, ["read"]);
		assert.deepEqual(resolved.input.extensions, ["/tmp/explicit-extension.ts"]);
		assert.equal(resolved.input.noExtensions, true);
		assert.equal(resolved.runId, "run_payload_1");
		assert.equal(
			stored.input.taskRef.path,
			DURABLE_WORKER_TASK_FILE,
			"resolver must not mutate its input",
		);

		// 3. Legacy inline payloads pass through untouched (pre-reference format).
		const legacy = {
			input: {
				task: "inline task",
				systemPrompt: "inline system",
				tools: ["read"],
			},
			cwd: root,
			backend: "headless",
			runId: "run_legacy",
			attemptId: "attempt-legacy",
			startedAt: "2026-09-02T00:00:00.000Z",
		};
		const legacyResolved = await resolveDurableWorkerPayload(
			legacy,
			join(root, "missing", "worker.json"),
		);
		assert.deepEqual(legacyResolved, legacy);
		assert.deepEqual(
			await resolveDurableWorkerPayload({ input: undefined }, payloadPath),
			{ input: undefined },
		);

		// 4. A payload without systemPrompt externalizes only the task.
		const taskOnlyDir = join(root, "attempts", "attempt-2");
		await (await import("node:fs/promises")).mkdir(taskOnlyDir, {
			recursive: true,
		});
		await writeDurableWorkerPayload({
			payloadPath: join(taskOnlyDir, "worker.json"),
			input: { task: "only task" },
			cwd: root,
			backend: "inline",
			runId: "run_payload_2",
			attemptId: "attempt-2",
			startedAt: "2026-09-02T00:00:00.000Z",
		});
		const taskOnly = JSON.parse(
			await readFile(join(taskOnlyDir, "worker.json"), "utf8"),
		);
		assert.equal(taskOnly.input.systemPromptRef, undefined);
		assert.equal(taskOnly.input.taskRef.path, DURABLE_WORKER_TASK_FILE);
		await assert.rejects(
			stat(join(taskOnlyDir, DURABLE_WORKER_SYSTEM_PROMPT_FILE)),
		);

		// 5. Tampering and unsafe references are rejected before use.
		const tampered = structuredClone(stored);
		await writeFile(join(attemptDir, DURABLE_WORKER_TASK_FILE), `${task}!`);
		await assert.rejects(
			resolveDurableWorkerPayload(tampered, payloadPath),
			/taskRef size mismatch/u,
		);
		await writeFile(
			join(attemptDir, DURABLE_WORKER_TASK_FILE),
			task.replace("Summarize", "Summarise"),
		);
		await assert.rejects(
			resolveDurableWorkerPayload(tampered, payloadPath),
			/taskRef digest mismatch/u,
		);
		await writeFile(join(attemptDir, DURABLE_WORKER_TASK_FILE), task);
		for (const badPath of [
			"../task.md",
			"/etc/passwd",
			"sub/task.md",
			"",
			".hidden",
			"a\\b",
		]) {
			const unsafe = structuredClone(stored);
			unsafe.input.taskRef.path = badPath;
			await assert.rejects(
				resolveDurableWorkerPayload(unsafe, payloadPath),
				/plain file name/u,
				`path ${JSON.stringify(badPath)} must be rejected`,
			);
		}
		const badDigest = structuredClone(stored);
		badDigest.input.taskRef.sha256 = "not-a-digest";
		await assert.rejects(
			resolveDurableWorkerPayload(badDigest, payloadPath),
			/lowercase hex SHA-256/u,
		);
		const ambiguous = structuredClone(stored);
		ambiguous.input.task = "inline and ref";
		await assert.rejects(
			resolveDurableWorkerPayload(ambiguous, payloadPath),
			/both task and taskRef/u,
		);
		await assert.rejects(
			writeDurableWorkerPayload({
				payloadPath: join(taskOnlyDir, "worker.json"),
				input: {
					task: "x",
					taskRef: { path: "task.md", bytes: 1, sha256: "0".repeat(64) },
				},
				cwd: root,
				backend: "inline",
				runId: "run_payload_3",
				attemptId: "attempt-3",
				startedAt: "2026-09-02T00:00:00.000Z",
			}),
			/already declares taskRef/u,
		);

		// [deferred-WP2a-2] 5b-6 spawn the real durable worker
		// (src/workers/durable-worker.mjs) and terminal finalizer through
		// orchestrate/async.ts and api.mjs: missing sidecar, invalid JSON, foreign
		// envelope, stale attempt, and model-backed end-to-end launches. Ported with
		// the executor-backed durable worker in WP2a-2.

		// agent-workflow addition: assertDurableWorkerPayloadShape now accepts any
		// resolved executor id (not only inline/headless/tmux) and still rejects "auto".
		const shape = {
			input: {},
			cwd: root,
			backend: "codex",
			runId: "run_shape",
			attemptId: "attempt-shape",
			startedAt: "2026-09-02T00:00:00.000Z",
		};
		assertDurableWorkerPayloadShape(shape);
		assertDurableWorkerPayloadShape({ ...shape, backend: "headless" });
		for (const [patch, pattern] of [
			[{ backend: "auto" }, /backend "auto" is unknown/u],
			[{ backend: "bad id" }, /backend "bad id" is unknown/u],
			[{ runId: "../x" }, /runId "\.\.\/x" is not a safe id/u],
			[{ cwd: "relative" }, /cwd must be absolute/u],
			[{ startedAt: "never" }, /is not a timestamp/u],
			[{ input: [] }, /input must be an object/u],
		])
			assert.throws(
				() => assertDurableWorkerPayloadShape({ ...shape, ...patch }),
				pattern,
			);
	} finally {
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
