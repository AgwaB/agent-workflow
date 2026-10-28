// New in agent-workflow (WP42 review round 1, finding 2): consent binds the classifier packet. The
// packet (task, exact candidate list, bounded descriptions) is built once before the consent
// dialog; exactly that frozen packet is transmitted. A catalog change while the dialog is open
// (a workflow added, a description changed) never reaches the classifier request.
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import {
	api,
	autoProject,
	autoSpec,
	core,
	READY,
	submits,
} from "../helpers/pi-auto-harness.mjs";
import { workflowFixtureDescriptor } from "../helpers/workflow-executor-fixture.mjs";

let root;
let counter = 0;
const unregister = [];

before(async () => {
	root = await realpath(
		await mkdtemp(join(tmpdir(), "aw-wp42-auto-consent-packet-")),
	);
});
afterEach(() => {
	for (const undo of unregister.splice(0).reverse()) undo();
	core.resetExecutorProbeCacheForTests();
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

async function setup() {
	counter += 1;
	const cwd = join(root, `p${counter}`);
	const env = await autoProject(cwd, join(root, `home${counter}`), [
		["allowed-workflow", "Review source code."],
	]);
	const log = join(root, `effects-${counter}.jsonl`);
	unregister.push(
		core.registerWorkflowExecutor(
			workflowFixtureDescriptor({
				id: "pi",
				effectLog: log,
				autoRecommend: "allowed-workflow",
				logPrompt: true,
				probe: READY,
			}),
		),
	);
	return { cwd, env, log };
}

function transmittedPacket(log) {
	const calls = submits(log).classifier;
	assert.equal(calls.length, 1, "exactly one classifier request");
	const prompt = calls[0].prompt;
	return {
		prompt,
		packet: JSON.parse(
			prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1),
		),
	};
}

test("a workflow added during the consent dialog never reaches the classifier request", async () => {
	const { cwd, env, log } = await setup();
	let offered;
	const result = await api.autoAction(
		{ cwd, env, host: "pi" },
		{
			task: "Review source code.",
			consent: {
				source: "prompt",
				confirm: async (_title, _message, preview) => {
					offered = preview.candidates.map((candidate) => candidate.label);
					const extra = autoSpec(
						"not-consented-workflow",
						"Review source code.",
						"PRIVATE_DESCRIPTION_ADDED_DURING_CONSENT",
					);
					await mkdir(join(cwd, "workflows", "not-consented-workflow"), {
						recursive: true,
					});
					await writeFile(
						join(cwd, "workflows", "not-consented-workflow", "spec.json"),
						JSON.stringify(extra),
					);
					return true;
				},
			},
		},
	);
	const { prompt, packet } = transmittedPacket(log);
	assert.ok(!offered.includes("not-consented-workflow"));
	assert.doesNotMatch(prompt, /PRIVATE_DESCRIPTION_ADDED_DURING_CONSENT/);
	assert.doesNotMatch(prompt, /not-consented-workflow/);
	assert.deepEqual(
		packet.candidateCards.map((card) => card.label),
		offered,
		"the preview's candidate list is the transmitted list",
	);
	assert.equal(packet.task, "Review source code.");
	assert.ok(
		!result.data.ranked.some((c) => c.label === "not-consented-workflow"),
	);
});

test("a description changed during the consent dialog is not transmitted (the frozen packet is)", async () => {
	const { cwd, env, log } = await setup();
	const file = join(cwd, "workflows", "allowed-workflow", "spec.json");
	const original = JSON.parse(await readFile(file, "utf8"));
	original.description = "ORIGINAL_CONSENTED_DESCRIPTION";
	await writeFile(file, JSON.stringify(original));
	let offered;
	await api.autoAction(
		{ cwd, env, host: "pi" },
		{
			task: "Review source code.",
			consent: {
				source: "prompt",
				confirm: async (_title, _message, preview) => {
					offered = preview.candidates.map((candidate) => candidate.label);
					await writeFile(
						file,
						JSON.stringify({
							...original,
							description: "PRIVATE_DESCRIPTION_CHANGED_DURING_CONSENT",
						}),
					);
					return true;
				},
			},
		},
	);
	const { prompt, packet } = transmittedPacket(log);
	assert.doesNotMatch(prompt, /PRIVATE_DESCRIPTION_CHANGED_DURING_CONSENT/);
	assert.match(prompt, /ORIGINAL_CONSENTED_DESCRIPTION/);
	assert.deepEqual(
		packet.candidateCards.map((card) => card.label),
		offered,
	);
});

test("--yes (flag consent) transmits the packet built for the preview", async () => {
	const { cwd, env, log } = await setup();
	const result = await api.autoAction(
		{ cwd, env, host: "cli" },
		{ task: "Review source code.", consent: { source: "flag" } },
	);
	const { packet } = transmittedPacket(log);
	assert.deepEqual(
		packet.candidateCards.map((card) => card.label),
		result.data.shortlist.map((candidate) => candidate.label),
	);
});
