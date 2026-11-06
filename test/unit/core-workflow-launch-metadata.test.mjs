import { stateDir } from "../helpers/state-dir.mjs";
import assert from "node:assert/strict";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runWorkflowSpec } from "../../dist/core/engine.js";
import "../helpers/register-default-executor.mjs";

import {
	isWorkflowRunLaunchMetadata,
	readWorkflowLaunchCommandArtifact,
	setWorkflowLaunchArtifactTestHooksForTests,
	workflowRunDir,
	workflowRunPath,
	writeWorkflowLaunchCommandArtifact,
} from "../../dist/core/store.js";

function launchWith(command) {
	return {
		schema: "agent-workflow-run-launch-v1",
		source: "cli",
		entry: { kind: "command", action: "run" },
		requestKind: "named-workflow",
		routingMode: "off",
		profile: { kind: "named", name: "medium" },
		task: { characters: 18, lines: 2 },
		command,
	};
}

test("launch command artifact is exact, private, integrity-linked, and absent from metadata JSON", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-"));
	const runId = "workflow_launch_private";
	const text =
		'agent-workflow run  --profile medium review "line one\nline two 🚀"';
	try {
		const command = await writeWorkflowLaunchCommandArtifact(cwd, runId, text);
		const run = { runId, launch: launchWith(command) };
		const artifact = join(workflowRunDir(cwd, runId), "launch-command.txt");

		assert.equal(await readFile(artifact, "utf8"), text);
		assert.equal((await stat(artifact)).mode & 0o777, 0o600);
		assert.equal((await stat(workflowRunDir(cwd, runId))).mode & 0o777, 0o700);
		assert.equal(command.bytes, Buffer.byteLength(text, "utf8"));
		assert.match(command.sha256, /^[0-9a-f]{64}$/);
		assert.equal(await readWorkflowLaunchCommandArtifact(cwd, run), text);
		assert.equal(JSON.stringify(run).includes(text), false);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("launch metadata validation is closed and artifact reads fail closed on tampering", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-tamper-"));
	const runId = "workflow_launch_tamper";
	try {
		const command = await writeWorkflowLaunchCommandArtifact(
			cwd,
			runId,
			"agent-workflow dynamic secret",
		);
		const launch = launchWith(command);
		assert.equal(isWorkflowRunLaunchMetadata(launch), true);
		assert.equal(
			isWorkflowRunLaunchMetadata({
				schema: "agent-workflow-run-launch-v1",
				source: "mcp:codex",
				entry: { kind: "tool", name: "workflow_dynamic" },
				requestKind: "direct-dynamic",
				routingMode: "off",
				profile: { kind: "not-applicable" },
				task: { characters: 12, lines: 1 },
				command: { ...command, fidelity: "agent-workflow-tool-call-v1" },
			}),
			true,
		);
		assert.equal(
			isWorkflowRunLaunchMetadata({ ...launch, unexpected: true }),
			false,
		);
		for (const invalid of [
			{ ...launch, entry: { kind: "command", action: "resume" } },
			{ ...launch, command: { state: "unavailable", reason: "not-a-command" } },
			{ ...launch, task: { characters: -1, lines: 2 } },
			{ ...launch, command: { ...command, sha256: "A".repeat(64) } },
			{ ...launch, command: { ...command, artifact: "../launch-command.txt" } },
		]) {
			assert.equal(isWorkflowRunLaunchMetadata(invalid), false);
		}

		const run = { runId, launch };
		await writeFile(
			join(workflowRunDir(cwd, runId), "launch-command.txt"),
			"tampered",
		);
		await assert.rejects(
			() => readWorkflowLaunchCommandArtifact(cwd, run),
			/verification failed/,
		);
		await assert.rejects(
			() =>
				readWorkflowLaunchCommandArtifact(cwd, {
					runId,
					launch: { ...launch, unexpected: true },
				}),
			/metadata malformed/,
		);

		await writeWorkflowLaunchCommandArtifact(
			cwd,
			runId,
			"agent-workflow dynamic secret",
		);
		await chmod(join(workflowRunDir(cwd, runId), "launch-command.txt"), 0o644);
		await assert.rejects(
			() => readWorkflowLaunchCommandArtifact(cwd, run),
			/verification failed/,
		);
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("pi-workflow's launch records are not accepted", () => {
	const command = { state: "unavailable", reason: "not-a-command" };
	for (const launch of [
		{
			schema: "pi-workflow-run-launch-v1",
			source: { kind: "tool", name: "workflow_run" },
			requestKind: "named-workflow",
			routingMode: "off",
			profile: { kind: "base" },
			task: { characters: 1, lines: 1 },
			command,
		},
		{
			schema: "pi-workflow-run-launch-v2",
			source: { kind: "slash-command", action: "auto" },
			requestKind: "named-workflow",
			routingMode: "auto-confirmed",
			profile: { kind: "base" },
			task: { characters: 1, lines: 1 },
			selection: {},
			command,
		},
	])
		assert.equal(isWorkflowRunLaunchMetadata(launch), false, launch.schema);
});

test("launch artifact rejects symlinked workflow roots, run directories, and artifacts", {
	skip: process.platform === "win32",
}, async () => {
	const secret = "agent-workflow run symlink-sensitive";
	const rootCwd = await mkdtemp(join(tmpdir(), "piwf-launch-root-link-"));
	const runCwd = await mkdtemp(join(tmpdir(), "piwf-launch-run-link-"));
	const artifactCwd = await mkdtemp(
		join(tmpdir(), "piwf-launch-artifact-link-"),
	);
	const outside = await mkdtemp(join(tmpdir(), "piwf-launch-outside-"));
	try {
		await mkdir(join(stateDir(rootCwd), ".agent-workflow"), {
			recursive: true,
		});
		await symlink(
			outside,
			join(stateDir(rootCwd), ".agent-workflow", "workflows"),
		);
		await assert.rejects(
			() =>
				writeWorkflowLaunchCommandArtifact(
					rootCwd,
					"workflow_root_link",
					secret,
				),
			/Unsafe workflow launch artifact path/,
		);

		await mkdir(join(stateDir(runCwd), ".agent-workflow", "workflows"), {
			recursive: true,
		});
		await symlink(outside, workflowRunDir(runCwd, "workflow_run_link"));
		await assert.rejects(
			() =>
				writeWorkflowLaunchCommandArtifact(runCwd, "workflow_run_link", secret),
			/Unsafe workflow launch artifact path/,
		);

		const runId = "workflow_artifact_link";
		const command = await writeWorkflowLaunchCommandArtifact(
			artifactCwd,
			runId,
			secret,
		);
		const artifact = join(
			workflowRunDir(artifactCwd, runId),
			"launch-command.txt",
		);
		const outsideTarget = join(outside, "outside-command.txt");
		await writeFile(outsideTarget, "outside remains unchanged", {
			mode: 0o600,
		});
		await rm(artifact);
		await symlink(outsideTarget, artifact);
		await assert.rejects(
			() =>
				readWorkflowLaunchCommandArtifact(artifactCwd, {
					runId,
					launch: launchWith(command),
				}),
			/verification failed/,
		);
		await assert.rejects(
			() => writeWorkflowLaunchCommandArtifact(artifactCwd, runId, secret),
			/Unsafe workflow launch artifact path/,
		);
		assert.equal(
			await readFile(outsideTarget, "utf8"),
			"outside remains unchanged",
		);
		assert.equal(
			(await readdir(outside)).some((name) => name === "launch-command.txt"),
			false,
		);
	} finally {
		await rm(rootCwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		await rm(runCwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		await rm(artifactCwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		await rm(outside, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("launch artifact read and commit reject path swaps without disclosing command bytes", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-swap-"));
	const outside = await mkdtemp(join(tmpdir(), "piwf-launch-swap-outside-"));
	const readRunId = "workflow_read_swap";
	const writeRunId = "workflow_write_swap";
	const readSecret = "agent-workflow run original-read-command";
	const writeSecret = "agent-workflow run original-write-command";
	try {
		const command = await writeWorkflowLaunchCommandArtifact(
			cwd,
			readRunId,
			readSecret,
		);
		setWorkflowLaunchArtifactTestHooksForTests({
			async onAfterReadOpen({ artifactPath }) {
				await rename(artifactPath, `${artifactPath}.opened`);
				await symlink(join(outside, "replacement.txt"), artifactPath);
			},
		});
		await writeFile(join(outside, "replacement.txt"), readSecret, {
			mode: 0o600,
		});
		await assert.rejects(
			() =>
				readWorkflowLaunchCommandArtifact(cwd, {
					runId: readRunId,
					launch: launchWith(command),
				}),
			/verification failed/,
		);

		setWorkflowLaunchArtifactTestHooksForTests({
			async onBeforeWriteRename() {
				const original = workflowRunDir(cwd, writeRunId);
				await rename(original, join(outside, "detached-run"));
				await mkdir(join(outside, "replacement-run"));
				await symlink(join(outside, "replacement-run"), original);
			},
		});
		await assert.rejects(
			() => writeWorkflowLaunchCommandArtifact(cwd, writeRunId, writeSecret),
			/Unsafe workflow launch artifact path/,
		);
		assert.deepEqual(await readdir(join(outside, "replacement-run")), []);
		for (const name of await readdir(join(outside, "detached-run"))) {
			const contents = await readFile(join(outside, "detached-run", name));
			assert.equal(contents.includes(Buffer.from(writeSecret)), false);
		}
	} finally {
		setWorkflowLaunchArtifactTestHooksForTests();
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		await rm(outside, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("launch artifact hard-link races fail closed and zero escaped command bytes", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-hardlink-"));
	const outside = await mkdtemp(
		join(tmpdir(), "piwf-launch-hardlink-outside-"),
	);
	const secret = "agent-workflow run hardlink-race-secret";
	try {
		for (const phase of ["before", "after"]) {
			const runId = `workflow_hardlink_${phase}`;
			const escaped = join(outside, `${phase}.txt`);
			setWorkflowLaunchArtifactTestHooksForTests(
				phase === "before"
					? {
							async onBeforeWriteRename({ tempPath }) {
								await link(tempPath, escaped);
							},
						}
					: {
							async onAfterWriteRename({ artifactPath }) {
								await link(artifactPath, escaped);
							},
						},
			);
			await assert.rejects(
				() => writeWorkflowLaunchCommandArtifact(cwd, runId, secret),
				/Unsafe workflow launch artifact path/,
			);
			assert.equal(await readFile(escaped, "utf8"), "");
			await assert.rejects(() => stat(workflowRunPath(cwd, runId)), {
				code: "ENOENT",
			});
			await assert.rejects(
				() => stat(join(workflowRunDir(cwd, runId), "launch-command.txt")),
				{ code: "ENOENT" },
			);
			setWorkflowLaunchArtifactTestHooksForTests();
		}
	} finally {
		setWorkflowLaunchArtifactTestHooksForTests();
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		await rm(outside, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("sidecar write failure prevents run record publication", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-launch-write-failure-"));
	const runId = "workflow_sidecar_write_failure";
	const exact = "agent-workflow run write-failure";
	try {
		await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
		await writeFile(
			join(cwd, ".agent-workflow", "agents", "launch-worker.md"),
			'---\ndescription: launch worker\ntools: ["read"]\nreadOnly: true\n---\n# Launch worker\n',
		);
		await writeFile(
			join(cwd, "workflow.json"),
			JSON.stringify({
				schemaVersion: 1,
				name: "launch-write-failure",
				defaults: {
					agent: "launch-worker",
					readOnly: true,
					tools: ["read"],
				},
				artifactGraph: {
					stages: [{ id: "main", type: "single", prompt: "Do work." }],
				},
			}),
		);
		setWorkflowLaunchArtifactTestHooksForTests({
			onBeforeWriteRename() {
				throw new Error("injected sidecar commit failure");
			},
		});
		await assert.rejects(
			() =>
				runWorkflowSpec("workflow.json", cwd, {
					runId,
					task: "Do work.",
					launch: {
						schema: "agent-workflow-run-launch-v1",
						source: "cli",
						entry: { kind: "command", action: "run" },
						requestKind: "named-workflow",
						routingMode: "off",
						profile: { kind: "base" },
						task: { characters: 8, lines: 1 },
						command: { state: "captured", text: exact },
					},
				}),
			/injected sidecar commit failure/,
		);
		await assert.rejects(() => stat(workflowRunPath(cwd, runId)), {
			code: "ENOENT",
		});
		await assert.rejects(
			() => stat(join(workflowRunDir(cwd, runId), "launch-command.txt")),
			{ code: "ENOENT" },
		);
		for (const name of await readdir(workflowRunDir(cwd, runId))) {
			const path = join(workflowRunDir(cwd, runId), name);
			const entry = await stat(path);
			if (entry.isFile())
				assert.equal(
					(await readFile(path)).includes(Buffer.from(exact)),
					false,
				);
		}
	} finally {
		setWorkflowLaunchArtifactTestHooksForTests();
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
