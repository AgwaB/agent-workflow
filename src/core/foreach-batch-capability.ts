// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) src/foreach-batch-capability.ts. MIT, same author. Changes: none.
import { createHash } from "node:crypto";

import type { WorkflowForeachBatchRecord } from "./types.js";
import {
	assertWorkflowStateRootCapability,
	openWorkflowStateRootCapability,
	type WorkflowStateRootCapability,
} from "./workflow-state-root.js";
import { canonicalWithoutUndefined } from "./json-values.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const CAPABILITIES = new WeakMap<
	object,
	{
		cwd: string;
		stateRootCapability: WorkflowStateRootCapability;
		stateRootSha256: string;
		subjectSha256: string;
		schedule: Readonly<WorkflowForeachBatchRecord>;
	}
>();

export interface WorkflowForeachBatchCapability {
	readonly kind: "agent-workflow-private-foreach-batch-capability-v1";
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

export function foreachBatchCapabilitySubjectSha256(
	record: WorkflowForeachBatchRecord,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonicalWithoutUndefined({
					version: record.version,
					batchId: record.batchId,
					placeholderSpecId: record.placeholderSpecId,
					stageId: record.stageId,
					generation: record.generation,
					sourceGeneration: record.sourceGeneration,
					grouping: record.grouping,
					executionSurfaceSha256: record.executionSurfaceSha256,
					stateRootSha256: record.stateRootSha256,
					members: record.members,
					attempt: record.attempt,
					preparedAt: record.preparedAt,
					batchPrompt: record.batchPrompt,
					batchPromptSha256: record.batchPromptSha256,
				}),
			),
		)
		.digest("hex");
}

export async function issueForeachBatchCapability(
	cwd: string,
	record: WorkflowForeachBatchRecord,
): Promise<WorkflowForeachBatchCapability> {
	if (
		!record.stateRootSha256 ||
		!SHA256.test(record.stateRootSha256) ||
		!record.capabilitySubjectSha256 ||
		!SHA256.test(record.capabilitySubjectSha256)
	)
		throw new Error(
			`foreach batch ${record.batchId} lacks hardened capability identity`,
		);
	const stateRootCapability = await openWorkflowStateRootCapability(cwd);
	const stateRoot = await assertWorkflowStateRootCapability(
		cwd,
		stateRootCapability,
	);
	if (stateRoot.identitySha256 !== record.stateRootSha256)
		throw new Error(
			`foreach batch ${record.batchId} state-root identity drift`,
		);
	const subjectSha256 = foreachBatchCapabilitySubjectSha256(record);
	if (subjectSha256 !== record.capabilitySubjectSha256)
		throw new Error(`foreach batch ${record.batchId} capability subject drift`);
	const capability = Object.freeze({
		kind: "agent-workflow-private-foreach-batch-capability-v1" as const,
	});
	CAPABILITIES.set(capability, {
		cwd,
		stateRootCapability,
		stateRootSha256: stateRoot.identitySha256,
		subjectSha256,
		schedule: deepFreeze(structuredClone(record)),
	});
	return capability;
}

export async function assertForeachBatchCapability(
	cwd: string,
	record: WorkflowForeachBatchRecord,
	capability: WorkflowForeachBatchCapability,
): Promise<void> {
	const bound = CAPABILITIES.get(capability);
	if (!bound || bound.cwd !== cwd)
		throw new Error("private foreach batch capability is required");
	const stateRoot = await assertWorkflowStateRootCapability(
		cwd,
		bound.stateRootCapability,
	);
	if (
		stateRoot.identitySha256 !== bound.stateRootSha256 ||
		record.stateRootSha256 !== bound.stateRootSha256 ||
		foreachBatchCapabilitySubjectSha256(record) !== bound.subjectSha256 ||
		record.capabilitySubjectSha256 !== bound.subjectSha256
	)
		throw new Error(
			`foreach batch ${record.batchId} capability revalidation failed`,
		);
}

export function inspectForeachBatchCapability(
	capability: WorkflowForeachBatchCapability,
): unknown {
	const bound = CAPABILITIES.get(capability);
	if (!bound) return { valid: false };
	return {
		valid: true,
		stateRootSha256: bound.stateRootSha256,
		subjectSha256: bound.subjectSha256,
		schedule: structuredClone(bound.schedule),
	};
}
