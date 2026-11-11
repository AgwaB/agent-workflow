// Probe-only wrapper over the standard fake. Every probe is observable; submit remains a test fake.
import { appendFileSync } from "node:fs";
import { createExecutor as fixtureExecutor } from "./workflow-executor-fixture.mjs";
export function createExecutor(config) {
	const executor = fixtureExecutor(config);
	return {
		...executor,
		// Optional per-executor effort levels and per-model levels (2026-11-11: the Effort picker).
		capabilities: () => ({
			...executor.capabilities(),
			...(config.effortLevels ? { effortLevels: config.effortLevels } : {}),
		}),
		async probe() {
			appendFileSync(config.probeLog, `${config.id}\n`);
			return {
				...(await executor.probe()),
				models: ["fixture-model"],
				modelListComplete: true,
				...(config.modelEfforts ? { modelEfforts: config.modelEfforts } : {}),
			};
		},
	};
}
