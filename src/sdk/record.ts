/**
 * Run-record fields for executor dispatch (plan §2.2 "run 기록", WP3 row; design §8.3, prior-art §3 #6).
 * Selection (role → executor:model:effort) and actual dispatch (executor id/version/CLI version/model)
 * are recorded separately so a degraded or substituted run is visible afterwards.
 */
import type { ExecutorProbe } from "./contract.js";
import { EXECUTOR_CONTRACT_VERSION } from "./contract.js";
import type { ExecutorDescriptor } from "./descriptor.js";
import type { NegotiationReport } from "./requirements.js";

export interface ExecutorSelection {
	readonly profileRole: string | null;
	readonly executorId: string;
	readonly model: string | null;
	readonly effort: string | null;
	/** Which layer chose it (B2: run flag > workflow profile > user profile > default). */
	readonly source: "run-flag" | "workflow-profile" | "user-profile" | "default";
}

export interface ExecutorDispatch {
	readonly executorId: string;
	readonly executorVersion: string;
	readonly cliVersion: string | null;
	readonly model: string | null;
	readonly effort: string | null;
}

export interface ExecutorRunRecord {
	readonly schema: "agent-workflow-executor-record-v0";
	readonly contractVersion: string;
	readonly selection: ExecutorSelection;
	readonly dispatch: ExecutorDispatch;
	readonly descriptor: ExecutorDescriptor;
	readonly negotiation: NegotiationReport;
	readonly probe: Pick<
		ExecutorProbe,
		"installed" | "cliVersion" | "auth"
	> | null;
	/** Convenience flag for result views: "this run ran degraded". */
	readonly degraded: boolean;
}

export function createExecutorRunRecord(input: {
	selection: ExecutorSelection;
	dispatch: ExecutorDispatch;
	descriptor: ExecutorDescriptor;
	negotiation: NegotiationReport;
	probe?: ExecutorProbe | null;
}): ExecutorRunRecord {
	const probe = input.probe ?? null;
	return {
		schema: "agent-workflow-executor-record-v0",
		contractVersion: EXECUTOR_CONTRACT_VERSION,
		selection: input.selection,
		dispatch: input.dispatch,
		descriptor: input.descriptor,
		negotiation: input.negotiation,
		probe:
			probe === null
				? null
				: {
						installed: probe.installed,
						cliVersion: probe.cliVersion,
						auth: probe.auth,
					},
		degraded:
			input.negotiation.degradations.length > 0 ||
			input.negotiation.forcedReadOnly,
	};
}
