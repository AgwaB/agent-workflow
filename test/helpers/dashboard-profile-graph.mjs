import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Real authored topology used by both the settings view and persisted Run fixtures.
export async function profileGraphFixtures(cwd) {
	const base = join(cwd, ".agent-workflow/workflows");
	const single = (id, profileRole, after = []) => ({
		id,
		type: "single",
		profileRole,
		after,
		prompt: "GRAPH-PROMPT-SENTINEL",
	});
	const defaults = { agent: "reader", readOnly: true, tools: ["read"] };
	const spec = {
		schemaVersion: 1,
		name: "model-flow",
		defaults,
		artifactGraph: {
			stages: [
				single("plan", "planning"),
				single("verify-a", "verification", ["plan"]),
				single("verify-b", "verification", ["plan"]),
				single("combine", "synthesis", ["verify-a", "verify-b"]),
				{
					id: "record",
					after: ["combine"],
					support: { uses: "./profile-code.mjs" },
				},
				single("final", "final-judgment", ["record"]),
			],
		},
	};
	await writeFile(join(base, "model-flow.json"), JSON.stringify(spec));
	await writeFile(
		join(base, "profile-code.mjs"),
		'export async function run() { throw new Error("DIAGRAM MUST NOT EXECUTE HELPERS"); }\n',
	);
	const expanding = {
		schemaVersion: 1,
		name: "expanding-flow",
		defaults,
		artifactGraph: {
			stages: [
				{
					id: "iterate",
					type: "loop",
					maxRounds: 2,
					until: { stage: "check", path: "$.status", equals: "verified" },
					stages: [
						{ ...single("work", "research-execution"), after: undefined },
						{ ...single("check", "verification"), after: undefined },
					],
				},
				{
					id: "adaptive",
					type: "dynamic",
					profileRole: "planning",
					after: ["iterate"],
					dynamic: { uses: "./profile-controller.mjs" },
				},
				single("final", "final-judgment", ["adaptive"]),
			],
		},
	};
	await writeFile(join(base, "expanding-flow.json"), JSON.stringify(expanding));
	await writeFile(
		join(base, "profile-controller.mjs"),
		'export async function run() { throw new Error("DIAGRAM MUST NOT EXECUTE CONTROLLERS"); }\n',
	);
	return spec;
}

// Canonical editor fixture: authored containment and real compiler dependencies, no execution.
export async function projectSettingsGraphFixtures(cwd) {
	await profileGraphFixtures(cwd);
	const base = join(cwd, ".agent-workflow/workflows");
	const single = (id, after = []) => ({
		id,
		type: "single",
		profileRole: "verification",
		after,
		prompt: "EDITOR-PROMPT-NOT-EXECUTED",
	});
	const spec = {
		schemaVersion: 1,
		name: "canonical-editor",
		defaults: {
			agent: "reader",
			readOnly: true,
			tools: ["read"],
			model: "fixture-model",
			effort: "medium",
		},
		artifactGraph: {
			stages: [
				{
					id: "iterate",
					type: "loop",
					maxRounds: 2,
					until: { stage: "check", path: "$.status", equals: "verified" },
					stages: [
						{ ...single("work"), after: undefined },
						{
							...single("check"),
							after: undefined,
							prompt: 'EDITOR-PROMPT-NOT-EXECUTED {"status":"verified"}',
						},
					],
				},
				{
					id: "nested",
					type: "dag",
					after: ["iterate"],
					stages: [single("check"), single("peer", ["check"])],
				},
				{
					id: "items",
					type: "foreach",
					profileRole: "research-execution",
					from: "nested",
					each: { agent: "reader", prompt: "Inspect {{item}}" },
					output: { analysis: { required: true } },
				},
				{
					id: "adaptive",
					type: "dynamic",
					profileRole: "planning",
					after: ["items"],
					dynamic: {
						uses: "./profile-controller.mjs",
						decisionLoop: {
							planner: { agent: "reader", profileRole: "planning" },
							workerDefaults: { agent: "reader", profileRole: "verification" },
						},
					},
				},
				{
					id: "record",
					after: ["adaptive"],
					support: { uses: "./profile-code.mjs" },
				},
				single("__proto__", ["record"]),
				single("constructor", ["__proto__"]),
			],
		},
	};
	await writeFile(join(base, "canonical-editor.json"), JSON.stringify(spec));
	await mkdir(join(base, "canonical-editor"));
	await writeFile(
		join(base, "canonical-editor/spec.json"),
		JSON.stringify({ ...spec, artifactGraph: { stages: [single("peer")] } }),
	);
	return spec;
}
