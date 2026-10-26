// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/workflow-auto-binding.test.mjs. MIT, same author. Changes: imports from dist/core/; fixture agents and run bundle paths .pi→.agent-workflow.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	assertWorkflowAutoLaunchBindingCurrent,
	assertWorkflowAutoLaunchBindingFrozen,
	captureWorkflowAutoLaunchBinding,
} from "../../dist/core/workflow-auto-binding.js";
import {
	DIRECT_DYNAMIC_RUNTIME_VERSION,
	directDynamicSpec,
	ensureDirectDynamicRuntimeBundle,
} from "../../dist/core/dynamic-runtime-bundle.js";

test("auto binding includes implicit default and role-source agents", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-auto-role-binding-"));
	const specPath = join(cwd, "workflows", "roles", "spec.json");
	const agentDir = join(cwd, ".agent-workflow", "agents");
	const spec = {
		schemaVersion: 1,
		name: "roles",
		roles: { reviewer: { fromAgent: "role-source" } },
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Review." }],
		},
	};
	try {
		await mkdir(join(cwd, "workflows", "roles"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(specPath, JSON.stringify(spec));
		for (const name of ["scout", "role-source"])
			await writeFile(
				join(agentDir, `${name}.md`),
				`---\ndescription: ${name}\ntools: [\"read\"]\nreadOnly: true\n---\n# ${name}\n`,
			);
		const binding = await captureWorkflowAutoLaunchBinding({
			cwd,
			candidateId: "b".repeat(64),
			task: "review",
			specPath,
			spec,
		});
		assert.deepEqual(
			binding.agents.map((agent) => agent.name),
			["role-source", "scout"],
		);
		await writeFile(
			join(agentDir, "role-source.md"),
			'---\ndescription: changed\ntools: ["read"]\nreadOnly: true\n---\n# changed\n',
		);
		await assert.rejects(
			() =>
				assertWorkflowAutoLaunchBindingCurrent(cwd, binding, spec, "review"),
			/Auto selection is stale/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("auto selection binds task, agents, bundle resources, and frozen bytes before dispatch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-auto-binding-"));
	const specPath = join(cwd, "workflows", "bound", "spec.json");
	const helperPath = join(cwd, "workflows", "bound", "helpers", "helper.mjs");
	const agentPath = join(cwd, ".agent-workflow", "agents", "unit-agent.md");
	const task = "Review this bounded task.";
	const spec = {
		schemaVersion: 1,
		name: "bound",
		defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "helper", support: { uses: "./helpers/helper.mjs" } }],
		},
	};
	try {
		await mkdir(join(cwd, "workflows", "bound", "helpers"), {
			recursive: true,
		});
		await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
		await writeFile(specPath, JSON.stringify(spec));
		await writeFile(helperPath, "export default () => ({ control: {} });\n");
		await writeFile(
			agentPath,
			'---\ndescription: unit\ntools: ["read"]\nreadOnly: true\n---\n# unit\n',
		);

		const binding = await captureWorkflowAutoLaunchBinding({
			cwd,
			candidateId: "a".repeat(64),
			task,
			specPath,
			spec,
		});
		assert.equal(
			binding.resources.some(
				(resource) => resource.relativePath === "spec.json",
			),
			true,
		);
		assert.equal(
			binding.resources.some(
				(resource) => resource.relativePath === "helpers/helper.mjs",
			),
			true,
		);
		assert.equal(binding.agents[0]?.name, "unit-agent");
		await assertWorkflowAutoLaunchBindingCurrent(cwd, binding, spec, task);
		const otherSpecPath = join(cwd, "workflows", "other", "spec.json");
		await mkdir(join(cwd, "workflows", "other"), { recursive: true });
		await writeFile(otherSpecPath, JSON.stringify(spec));
		await assert.rejects(
			() =>
				assertWorkflowAutoLaunchBindingCurrent(
					cwd,
					binding,
					spec,
					task,
					otherSpecPath,
				),
			/selected workflow path changed/,
		);

		const bundleRoot = join(
			cwd,
			".agent-workflow",
			"workflows",
			"workflow_binding",
			"bundle",
		);
		for (const resource of binding.resources) {
			const target = join(bundleRoot, resource.relativePath);
			await mkdir(join(target, ".."), { recursive: true });
			await writeFile(
				target,
				await readFile(join(cwd, "workflows", "bound", resource.relativePath)),
			);
		}
		await assertWorkflowAutoLaunchBindingFrozen(
			cwd,
			"workflow_binding",
			binding,
		);

		await writeFile(
			helperPath,
			"export default () => ({ control: { changed: true } });\n",
		);
		await assert.rejects(
			() => assertWorkflowAutoLaunchBindingCurrent(cwd, binding, spec, task),
			/Auto selection is stale/,
		);
		await writeFile(helperPath, "export default () => ({ control: {} });\n");
		await writeFile(
			agentPath,
			'---\ndescription: changed\ntools: ["read"]\nreadOnly: true\n---\n# changed\n',
		);
		await assert.rejects(
			() => assertWorkflowAutoLaunchBindingCurrent(cwd, binding, spec, task),
			/Auto selection is stale/,
		);
		await writeFile(
			join(bundleRoot, "helpers", "helper.mjs"),
			"changed frozen bytes\n",
		);
		await assert.rejects(
			() =>
				assertWorkflowAutoLaunchBindingFrozen(cwd, "workflow_binding", binding),
			/frozen bundle bytes changed/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("auto binding rejects a same-string cwd that was replaced before launch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-auto-cwd-binding-"));
	const movedCwd = `${cwd}-replaced`;
	const specPath = join(cwd, "workflows", "bound", "spec.json");
	const spec = {
		schemaVersion: 1,
		name: "bound",
		defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Review." }],
		},
	};
	try {
		await mkdir(join(cwd, "workflows", "bound"), { recursive: true });
		await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
		await writeFile(specPath, JSON.stringify(spec));
		await writeFile(
			join(cwd, ".agent-workflow", "agents", "unit-agent.md"),
			'---\ndescription: unit\ntools: ["read"]\nreadOnly: true\n---\n# unit\n',
		);
		const binding = await captureWorkflowAutoLaunchBinding({
			cwd,
			candidateId: "c".repeat(64),
			task: "review",
			specPath,
			spec,
		});
		await rename(cwd, movedCwd);
		await mkdir(cwd);
		await assert.rejects(
			() =>
				assertWorkflowAutoLaunchBindingCurrent(cwd, binding, spec, "review"),
			/current project directory changed before launch/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(movedCwd, { recursive: true, force: true });
	}
});

test("auto binding covers the actual direct-dynamic runtime controller and agent", async () => {
	const cwd = await mkdtemp(
		join(tmpdir(), "piwf-auto-direct-dynamic-binding-"),
	);
	try {
		const specPath = await ensureDirectDynamicRuntimeBundle(cwd);
		const spec = directDynamicSpec();
		const binding = await captureWorkflowAutoLaunchBinding({
			cwd,
			candidateId: "e".repeat(64),
			task: "research",
			specPath,
			spec,
			selectionIdentitySha256: "f".repeat(64),
			runtimeVersion: DIRECT_DYNAMIC_RUNTIME_VERSION,
		});
		assert.equal(binding.runtimeVersion, DIRECT_DYNAMIC_RUNTIME_VERSION);
		assert.equal(
			binding.resources.some(
				(resource) => resource.relativePath === "controller.mjs",
			),
			true,
		);
		assert.equal(
			binding.agents.some((agent) => agent.name === "researcher"),
			true,
		);
		await assertWorkflowAutoLaunchBindingCurrent(
			cwd,
			binding,
			spec,
			"research",
			specPath,
		);
		await writeFile(
			join(
				cwd,
				".agent-workflow",
				"workflow-runtime",
				DIRECT_DYNAMIC_RUNTIME_VERSION,
				"controller.mjs",
			),
			"export default () => ({ control: { changed: true } });\n",
		);
		await assert.rejects(
			() =>
				assertWorkflowAutoLaunchBindingCurrent(
					cwd,
					binding,
					spec,
					"research",
					specPath,
				),
			/Auto selection is stale/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("auto binding rejects external provider extensions in a nested bundled workflow", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piwf-auto-nested-provider-"));
	const specPath = join(cwd, "workflows", "root", "spec.json");
	const childPath = join(cwd, "workflows", "root", "nested", "spec.json");
	const spec = {
		schemaVersion: 1,
		name: "root",
		defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [
				{
					id: "adaptive",
					type: "dynamic",
					dynamic: {
						uses: "./controller.mjs",
						workflows: { child: { uses: "./nested/spec.json" } },
					},
				},
			],
		},
	};
	const child = {
		schemaVersion: 1,
		name: "child",
		defaults: {
			agent: "unit-agent",
			readOnly: true,
			tools: [
				{
					name: "read",
					extensions: ["unfrozen-provider-extension"],
				},
			],
		},
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Review." }],
		},
	};
	try {
		await mkdir(join(cwd, "workflows", "root", "nested"), {
			recursive: true,
		});
		await mkdir(join(cwd, ".agent-workflow", "agents"), { recursive: true });
		await writeFile(specPath, JSON.stringify(spec));
		await writeFile(childPath, JSON.stringify(child));
		await writeFile(
			join(cwd, "workflows", "root", "controller.mjs"),
			"export default () => ({ control: {} });\n",
		);
		await writeFile(
			join(cwd, ".agent-workflow", "agents", "unit-agent.md"),
			'---\ndescription: unit\ntools: ["read"]\nreadOnly: true\n---\n# unit\n',
		);
		await assert.rejects(
			() =>
				captureWorkflowAutoLaunchBinding({
					cwd,
					candidateId: "d".repeat(64),
					task: "review",
					specPath,
					spec,
				}),
			/provider extension unfrozen-provider-extension/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
