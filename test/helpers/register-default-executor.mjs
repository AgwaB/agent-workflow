// New in agent-workflow (WP4c-1): ported engine tests start runs without naming an executor, so the
// default executor id "pi" must resolve. Its adapter lands in WP6; until then this module registers
// the fake fixture executor (test/helpers/workflow-executor-fixture.mjs) under that id. Tests that
// inject a runtime API (setTaskRuntimeApiForTests) never reach the executor itself.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkflowExecutor } from "../../dist/core/executor-registry.js";
import { workflowFixtureDescriptor } from "./workflow-executor-fixture.mjs";

export const DEFAULT_EXECUTOR_EFFECT_LOG = join(
	tmpdir(),
	`aw-${process.pid}-default-executor-effects.jsonl`,
);

export const unregisterDefaultExecutor = registerWorkflowExecutor(
	workflowFixtureDescriptor({
		id: "pi",
		effectLog: DEFAULT_EXECUTOR_EFFECT_LOG,
	}),
);
