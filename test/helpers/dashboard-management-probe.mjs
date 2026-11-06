// Probe-only wrapper over the standard fake. Every probe is observable; submit remains a test fake.
import { appendFileSync } from "node:fs";
import { createExecutor as fixtureExecutor } from "./workflow-executor-fixture.mjs";
export function createExecutor(config) {
	const executor = fixtureExecutor(config);
	return {
		...executor,
		async probe() {
			appendFileSync(config.probeLog, `${config.id}\n`);
			return {
				...(await executor.probe()),
				models: ["fixture-model"],
				modelListComplete: true,
			};
		},
	};
}
