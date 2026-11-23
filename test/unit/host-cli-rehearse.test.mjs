// test-tier: integration
// `agent-workflow rehearse`: argv parsing, exit codes (0 sound, 1 problems or invalid spec, 2 usage), --json,
// --keep, help. In-process through runAgentWorkflowCli plus one spawn of the real bin. No model, no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = await import("../../dist/hosts/cli/index.js");
const { setRehearsalRemoveForTests } = await import(
	"../../dist/core/rehearsal-settle.js"
);
const BIN = fileURLToPath(
	new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
);
const SCAFFOLD = fileURLToPath(
	new URL(
		"../../skills/workflow-guide/scaffolds/object-tool-fallback/spec.json",
		import.meta.url,
	),
);

let root;
let cwd;

const WORKFLOW = {
	schemaVersion: 1,
	name: "cli-rehearse",
	defaults: { agent: "scout", readOnly: true, tools: ["read"] },
	artifactGraph: {
		stages: [
			{ id: "a", type: "single", prompt: "Collect facts." },
			{
				id: "b",
				type: "reduce",
				from: ["a"],
				inputPolicy: {
					requiredReads: [
						{ source: "a", artifact: "control", path: "$.nothere" },
					],
					enforcement: "fail",
				},
				prompt: "Summarize.",
			},
		],
	},
};

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-cli-rehearse-")));
	cwd = join(root, "project");
	await mkdir(join(cwd, ".agent-workflow"), { recursive: true });
	await writeFile(join(cwd, "bad.json"), JSON.stringify(WORKFLOW));
	await writeFile(
		join(cwd, "good.json"),
		JSON.stringify({
			...WORKFLOW,
			name: "cli-rehearse-good",
			artifactGraph: {
				stages: [
					WORKFLOW.artifactGraph.stages[0],
					{
						...WORKFLOW.artifactGraph.stages[1],
						inputPolicy: { requiredReads: ["a.control"], enforcement: "fail" },
					},
				],
			},
		}),
	);
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

async function run(argv) {
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd,
		env: process.env,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
	});
	return { code, out: out.join(""), err: err.join("") };
}

test("a sound workflow exits 0 and the text names the stages", async () => {
	const result = await run(["rehearse", "good.json"]);
	assert.equal(result.code, 0, result.out + result.err);
	assert.match(result.out, /Rehearsal of good\.json: wiring OK/u);
	assert.match(result.out, /No model was called/u);
	assert.match(
		result.out,
		/b: reduce; 1 task; 1 completed; sources a received by 1\/1; required reads 1\/1/u,
	);
	assert.match(result.out, /Final report: rendered/u);
});

test("a wiring problem exits 1 and names the stage, the read and the tool's message", async () => {
	const result = await run(["rehearse", "bad.json"]);
	assert.equal(result.code, 1);
	assert.match(result.out, /wiring problems found/u);
	assert.match(
		result.out,
		/stage b: required read a\.control \$\.nothere does not resolve/u,
	);
});

async function gateWorkflow(name, helperBody) {
	await mkdir(join(cwd, "helpers"), { recursive: true });
	await writeFile(join(cwd, "helpers", `${name}.mjs`), helperBody);
	await writeFile(
		join(cwd, `${name}.json`),
		JSON.stringify({
			schemaVersion: 1,
			name,
			defaults: WORKFLOW.defaults,
			artifactGraph: {
				stages: [
					{ id: "a", type: "single", prompt: "Collect facts." },
					{ id: "g", from: "a", support: { uses: `./helpers/${name}.mjs` } },
					{ id: "c", type: "reduce", from: ["g"], prompt: "Summarize." },
				],
			},
		}),
	);
	return `${name}.json`;
}

for (const declared of ["failed", "blocked"]) {
	test(`content gates (${declared}): exit 0, the text names the helper and reason and does not claim it is proven not to be wiring`, async () => {
		const file = await gateWorkflow(
			`gated-${declared}`,
			`export default async () => ({ schema: "g-v1", status: "${declared}", digest: "0 of 20 tickets classified" });\n`,
		);
		const result = await run(["rehearse", file]);
		assert.equal(result.code, 0, result.out + result.err);
		assert.match(
			result.out,
			/wiring OK so far, but a helper declared failed\/blocked on the synthetic data \(read the reason below\)/u,
		);
		assert.doesNotMatch(result.out, /not a wiring problem/u);
		assert.doesNotMatch(result.out, /wiring problems found/u);
		assert.match(
			result.out,
			new RegExp(
				`- g\\.main \\(stage g\\) declared ${declared} on synthetic data: 0 of 20 tickets classified`,
				"u",
			),
		);
		assert.match(
			result.out,
			/expected for a content check; if it names a missing source or setup, it is a wiring problem/u,
		);
		assert.match(result.out, /Stages skipped after the gate: c\./u);
		assert.doesNotMatch(result.out, /Findings:/u);
		const json = await run(["rehearse", file, "--json"]);
		assert.equal(json.code, 0);
		const parsed = JSON.parse(json.out);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.data.status, "content-gates");
		assert.equal(parsed.data.runStatus, declared);
	});
}

test("a helper that looks up a source it does not have and declares blocked is exit 1, not a content gate", async () => {
	const file = await gateWorkflow(
		"wrong-lookup",
		'export default async ({ sources }) => sources.extract ? { schema: "g-v1", status: "passed", digest: "ok" } : { schema: "g-v1", status: "blocked", digest: "source extract is missing" };\n',
	);
	const result = await run(["rehearse", file]);
	assert.equal(result.code, 1, result.out + result.err);
	assert.match(result.out, /wiring problems found/u);
	assert.match(
		result.out,
		/support helper "\.\/helpers\/wrong-lookup\.mjs" looks up source "extract", which is not one of its sources \(a\)/u,
	);
	const json = await run(["rehearse", file, "--json"]);
	assert.equal(json.code, 1);
	const parsed = JSON.parse(json.out);
	assert.equal(parsed.ok, false);
	assert.notEqual(parsed.data.status, "content-gates");
	assert.equal(parsed.data.findings.length > 0, true);
});

test("a helper that throws stays a wiring finding (exit 1), not a content gate", async () => {
	const file = await gateWorkflow(
		"thrower",
		'export default async () => { throw new Error("helper exploded on purpose"); };\n',
	);
	const result = await run(["rehearse", file]);
	assert.equal(result.code, 1);
	assert.match(result.out, /wiring problems found/u);
	assert.match(result.out, /helper exploded on purpose/u);
	assert.doesNotMatch(
		result.out,
		/Declared failed\/blocked on synthetic data/u,
	);
});

test("--json prints the same data as one object with the rehearsal schema", async () => {
	const result = await run([
		"rehearse",
		"bad.json",
		"--json",
		"--items",
		"3",
		"--loop",
		"exhaust",
	]);
	assert.equal(result.code, 1);
	const parsed = JSON.parse(result.out);
	assert.equal(parsed.action, "rehearse");
	assert.equal(parsed.ok, false);
	assert.equal(parsed.outcome, "failed");
	assert.equal(parsed.data.schema, "agent-workflow-rehearsal-v1");
	assert.deepEqual(parsed.data.options, { items: 3, loop: "exhaust" });
	assert.equal(
		parsed.data.stages.find((s) => s.stage === "b").requiredReads[0].satisfied,
		false,
	);
	assert.ok(parsed.data.findings.length > 0);

	const good = JSON.parse((await run(["rehearse", "good.json", "--json"])).out);
	assert.equal(good.ok, true);
	assert.equal(good.data.status, "completed");
});

test("an invalid spec exits 1 with the validation message; an unknown workflow likewise", async () => {
	await writeFile(
		join(cwd, "invalid.json"),
		JSON.stringify({ schemaVersion: 1, name: "x" }),
	);
	for (const name of ["invalid.json", "no-such-workflow"]) {
		const result = await run(["rehearse", name, "--json"]);
		assert.equal(result.code, 1, name);
		const parsed = JSON.parse(result.out);
		assert.equal(parsed.data.status, "invalid-spec");
		assert.ok(parsed.data.findings[0].startsWith("invalid spec:"));
	}
});

test("usage errors exit 2", async () => {
	for (const argv of [
		["rehearse"],
		["rehearse", "good.json", "--loop", "maybe"],
		["rehearse", "good.json", "--items", "x"],
		["rehearse", "good.json", "--items", "99"],
		["rehearse", "good.json", "--bogus"],
		["rehearse", "good.json", "--keep", "--keep"],
	]) {
		const result = await run(argv);
		assert.equal(
			result.code,
			2,
			`${argv.join(" ")}: ${result.out}${result.err}`,
		);
	}
});

test("--keep prints the kept state root; without it nothing is kept", async () => {
	const kept = await run(["rehearse", "good.json", "--keep", "--json"]);
	const { stateRoot } = JSON.parse(kept.out).data;
	try {
		assert.ok(stateRoot && existsSync(stateRoot));
	} finally {
		if (stateRoot)
			await rm(stateRoot, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 50,
			});
	}
	const plain = JSON.parse(
		(await run(["rehearse", "good.json", "--json"])).out,
	);
	assert.equal(plain.data.stateRoot, undefined);
});

test("help lists the command and its options", async () => {
	const help = await run(["help", "rehearse"]);
	assert.equal(help.code, 0);
	assert.match(help.out, /Usage: agent-workflow rehearse/u);
	assert.match(help.out, /--items N/u);
	assert.match(help.out, /--loop pass\|exhaust/u);
	assert.match((await run(["help"])).out, /rehearse <workflow>/u);
});

test("the real bin: exit codes 0 and 2, and the synthetic executor is not selectable for a real run", () => {
	const env = { ...process.env, AGENT_WORKFLOW_HOME: join(root, "bin-home") };
	const ok = spawnSync(process.execPath, [BIN, "rehearse", SCAFFOLD], {
		cwd,
		env,
		encoding: "utf8",
	});
	assert.equal(ok.status, 0, ok.stdout + ok.stderr);
	const usage = spawnSync(process.execPath, [BIN, "rehearse"], {
		cwd,
		env,
		encoding: "utf8",
	});
	assert.equal(usage.status, 2);
	const real = spawnSync(
		process.execPath,
		[
			BIN,
			"run",
			"good.json",
			"task",
			"--executor",
			"aw-rehearsal-synthetic",
			"--detach",
		],
		{ cwd, env, encoding: "utf8" },
	);
	assert.notEqual(real.status, 0, real.stdout);
	assert.match(real.stdout + real.stderr, /aw-rehearsal-synthetic/u);
});

test("a temporary root that cannot be removed does not fail the command; the text and --json name it", async () => {
	setRehearsalRemoveForTests(() => {
		throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
	});
	const leftovers = [];
	try {
		const text = await run(["rehearse", "good.json"]);
		assert.equal(text.code, 0, text.out + text.err);
		const named = /could not be fully removed: (\S+)/u.exec(text.out);
		assert.ok(named, text.out);
		leftovers.push(named[1]);
		const json = JSON.parse(
			(await run(["rehearse", "good.json", "--json"])).out,
		);
		assert.equal(json.ok, true);
		assert.match(json.data.leftover, /aw-rehearse-/u);
		leftovers.push(json.data.leftover);
	} finally {
		setRehearsalRemoveForTests(undefined);
		for (const path of leftovers)
			await rm(path, { recursive: true, force: true });
	}
});
