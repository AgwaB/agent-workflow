// test-tier: integration
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

test("auto transmits the prepared shortlist packet", async () => {
	const { cwd, env, log } = await setup();
	const result = await api.autoAction(
		{ cwd, env, host: "cli" },
		{ task: "Review source code." },
	);
	const { packet } = transmittedPacket(log);
	assert.deepEqual(
		packet.candidateCards.map((card) => card.label),
		result.data.shortlist.map((candidate) => candidate.label),
	);
});
