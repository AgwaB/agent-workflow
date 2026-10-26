// New in agent-workflow (WP1b): an executor module whose submit refuses every request before it
// consumes the execution authority (SdkError INVALID_REQUEST, no effect), as an adapter's
// pre-consume request checks do. A durable worker reloads it from its descriptor.
//
// Config (descriptor.config, JSON): id (default "wf-refuse"), message (refusal text).
import { fileURLToPath } from "node:url";
import { createFakeExecutor } from "@agwab/agent-workflow/sdk/testing";
import { SdkError } from "../../dist/sdk/errors.js";

export const REFUSING_EXECUTOR_FIXTURE_MODULE = fileURLToPath(import.meta.url);

export function refusingFixtureDescriptor(config = {}) {
	return {
		id: config.id ?? "wf-refuse",
		version: "0.1.0",
		contractVersion: "0.1.0",
		module: REFUSING_EXECUTOR_FIXTURE_MODULE,
		config,
	};
}

export function createExecutor(config = {}) {
	const id = config.id ?? "wf-refuse";
	const probeInner = createFakeExecutor({ id, version: "0.1.0" });
	return {
		id,
		version: "0.1.0",
		contractVersion: "0.1.0",
		probe: () => probeInner.probe(),
		capabilities: () => probeInner.capabilities(),
		async submit() {
			throw new SdkError(
				"INVALID_REQUEST",
				config.message ?? "refused before consume",
			);
		},
		observe() {
			throw new Error("nothing was submitted");
		},
		async cancel() {
			return "no_active";
		},
		async reconcile() {
			return { absent: true };
		},
		respond() {
			throw new Error("nothing was submitted");
		},
	};
}
