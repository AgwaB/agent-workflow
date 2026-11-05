import assert from "node:assert/strict";
import test from "node:test";

import {
	parseWorkflowDynamicArgs,
	parseWorkflowRunArgs,
} from "../../dist/hosts/args.js";
import { awArgumentCompletions } from "../../dist/hosts/pi/command.js";

test("workflow command completions and run arg parsing preserve task text", () => {
	assert.deepEqual(
		awArgumentCompletions("")?.map((item) => item.value),
		[
			"help",
			"list",
			"validate",
			"check",
			"roles",
			"agents",
			"profile",
			"run",
			"dynamic",
			"auto",
			"status",
			"show",
			"inspect",
			"logs",
			"wait",
			"resume",
			"approve",
			"stop",
			"prune",
			"notices",
			"dashboard",
		],
	);
	assert.deepEqual(
		awArgumentCompletions("l")?.map((item) => item.value),
		["list", "logs"],
	);
	assert.equal(awArgumentCompletions("run re"), null);
	assert.deepEqual(
		parseWorkflowRunArgs("run review Fix this:\n  const x = 1;"),
		{ specPath: "review", task: "Fix this:\n  const x = 1;", detach: false },
	);
	assert.deepEqual(parseWorkflowRunArgs('run review "Fix the thing"'), {
		specPath: "review",
		task: "Fix the thing",
		detach: false,
	});
	assert.deepEqual(
		parseWorkflowRunArgs('run review "Fix the thing" --detach'),
		{ specPath: "review", task: "Fix the thing", detach: true },
	);
	assert.deepEqual(
		parseWorkflowRunArgs('run review "Keep literal --detach in the task"'),
		{
			specPath: "review",
			task: "Keep literal --detach in the task",
			detach: false,
		},
	);
	assert.deepEqual(
		parseWorkflowRunArgs(
			'run review "Keep literal --model=openai-codex/gpt-5.5 in the task"',
		),
		{
			specPath: "review",
			task: "Keep literal --model=openai-codex/gpt-5.5 in the task",
			detach: false,
		},
	);
	assert.deepEqual(
		parseWorkflowRunArgs(
			'run --model kimi-coding/kimi-for-coding --thinking low review "Fix the thing" --detach',
		),
		{
			specPath: "review",
			task: "Fix the thing",
			detach: true,
			model: "kimi-coding/kimi-for-coding",
			thinking: "low",
		},
	);
	assert.deepEqual(
		parseWorkflowRunArgs(
			'run review "Fix the thing" --model=openai-codex/gpt-5.5 --reasoning=xhigh',
		),
		{
			specPath: "review",
			task: "Fix the thing",
			detach: false,
			model: "openai-codex/gpt-5.5",
			thinking: "xhigh",
		},
	);
	assert.deepEqual(
		parseWorkflowDynamicArgs(
			'dynamic --model openai-codex/gpt-5.5 --thinking low "Research adaptive workflows" --detach',
		),
		{
			task: "Research adaptive workflows",
			detach: true,
			model: "openai-codex/gpt-5.5",
			thinking: "low",
		},
	);
	assert.deepEqual(
		parseWorkflowDynamicArgs(
			'dynamic "Keep literal --detach and --model=x in the task"',
		),
		{
			task: "Keep literal --detach and --model=x in the task",
			detach: false,
		},
	);
	assert.throws(
		() => parseWorkflowRunArgs("run --thinking turbo review Fix"),
		/Invalid effort level/,
	);
});
