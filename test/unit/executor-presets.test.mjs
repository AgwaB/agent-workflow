import assert from "node:assert/strict";
import test from "node:test";
import {
	EXECUTOR_PRESET_IDS,
	executorPreset,
	isExecutorPresetId,
} from "../../dist/core/executor-presets.js";

const sol = "gpt-6.1-sol";
const luna = "gpt-6-luna";
const opus = "claude-opus-5-5";
const entry = (model, effort) => ({
	executor: model === opus ? "claude" : "codex",
	model,
	effort,
});
const expected = {
	codex: [
		entry(sol, "high"),
		entry(luna, "medium"),
		entry(luna, "high"),
		entry(luna, "high"),
		entry(sol, "xhigh"),
	],
	"codex-high": [
		entry(sol, "xhigh"),
		entry(sol, "high"),
		entry(sol, "xhigh"),
		entry(sol, "max"),
		entry(sol, "xhigh"),
	],
	claude: [
		entry(opus, "high"),
		entry(opus, "medium"),
		entry(opus, "high"),
		entry(opus, "high"),
		entry(opus, "high"),
	],
	mixed: [
		entry(opus, "high"),
		entry(luna, "medium"),
		entry(opus, "high"),
		entry(luna, "high"),
		entry(opus, "high"),
	],
};
const roles = [
	"planning",
	"research-execution",
	"synthesis",
	"verification",
	"final-judgment",
];

test("R1: only the four reference built-ins exist; pi is not a preset", () => {
	assert.deepEqual(EXECUTOR_PRESET_IDS, Object.keys(expected));
	assert.equal(isExecutorPresetId("pi"), false);
	assert.throws(() => executorPreset("pi"), /unknown preset/);
});
for (const [id, values] of Object.entries(expected)) {
	test(`R1: ${id} has the exact reference role values and research default`, () => {
		const preset = executorPreset(id);
		assert.deepEqual(preset.roles, {
			default: values[1],
			...Object.fromEntries(roles.map((role, index) => [role, values[index]])),
		});
		assert.equal(preset.executor, values[1].executor);
		preset.roles.default.model = "mutated";
		assert.deepEqual(
			executorPreset(id).roles.default,
			values[1],
			"fresh independent role values",
		);
	});
}
