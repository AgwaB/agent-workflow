import type {
	AgentDefinition,
	CompiledTask,
	WorkflowResourcePolicy,
} from "./types.js";

/**
 * Marks compiled tasks that use the explicit, sealed resource-policy contract.
 * Tasks without this marker are permanently legacy, even when they happen to
 * carry an authored `inheritSkills: false` value. New compiles use version 2
 * (2026-11-10: `contextFiles` says whether the stage inherits project context);
 * version 1 remains the policy of the runs that sealed it.
 */
export const WORKFLOW_RESOURCE_POLICY_VERSION = 2 as const;

export type { WorkflowResourcePolicy } from "./types.js";

/**
 * Resolve the one resource policy that is allowed to affect a workflow launch.
 * The absent marker deliberately preserves pre-policy behavior.
 */
export function resolveWorkflowResourcePolicy(
	task: Pick<
		CompiledTask,
		"resourcePolicyVersion" | "inheritSkills" | "inheritProjectContext"
	>,
): WorkflowResourcePolicy | undefined {
	if (task.resourcePolicyVersion === undefined) return undefined;
	const skillDiscovery = task.inheritSkills === false ? "disabled" : "ambient";
	if (task.resourcePolicyVersion === 1)
		return { version: 1, skillDiscovery, contextFiles: "disabled" };
	if (task.resourcePolicyVersion === 2)
		return {
			version: 2,
			skillDiscovery,
			contextFiles:
				task.inheritProjectContext === true ? "inherited" : "disabled",
		};
	throw new Error("workflow resource policy version is unsupported");
}

/** Strict structural validation for a persisted or prepared policy record. */
export function isWorkflowResourcePolicy(
	value: unknown,
): value is WorkflowResourcePolicy {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return (
		keys.length === 3 &&
		keys[0] === "contextFiles" &&
		keys[1] === "skillDiscovery" &&
		keys[2] === "version" &&
		(record.skillDiscovery === "ambient" ||
			record.skillDiscovery === "disabled") &&
		((record.version === 1 && record.contextFiles === "disabled") ||
			(record.version === 2 &&
				(record.contextFiles === "disabled" ||
					record.contextFiles === "inherited")))
	);
}

/**
 * Reject a prepared policy that does not exactly represent the compiled task.
 * Returning the prepared object ensures launch code consumes the sealed value,
 * not mutable authoring metadata.
 */
export function assertWorkflowResourcePolicyMatchesTask(
	task: Pick<
		CompiledTask,
		"resourcePolicyVersion" | "inheritSkills" | "inheritProjectContext"
	>,
	preparedPolicy: unknown,
): WorkflowResourcePolicy | undefined {
	const resolved = resolveWorkflowResourcePolicy(task);
	if (resolved === undefined) {
		if (preparedPolicy !== undefined) {
			throw new Error(
				"workflow resource policy drifted from legacy compiled semantics",
			);
		}
		return undefined;
	}
	if (
		!isWorkflowResourcePolicy(preparedPolicy) ||
		preparedPolicy.version !== resolved.version ||
		preparedPolicy.skillDiscovery !== resolved.skillDiscovery ||
		preparedPolicy.contextFiles !== resolved.contextFiles
	) {
		throw new Error("workflow resource policy drifted from compiled semantics");
	}
	return preparedPolicy;
}

/**
 * Diagnostics are deliberately warning-only: raw frontmatter remains available
 * even when the parsed boolean field is absent.
 */
export function resourceInheritanceWarnings(agent: AgentDefinition): string[] {
	const frontmatter =
		agent.frontmatter &&
		typeof agent.frontmatter === "object" &&
		!Array.isArray(agent.frontmatter)
			? agent.frontmatter
			: {};
	const warnings: string[] = [];
	for (const field of ["inheritSkills", "inheritProjectContext"] as const) {
		if (
			Object.hasOwn(frontmatter, field) &&
			typeof frontmatter[field] !== "boolean"
		) {
			warnings.push(
				`agent "${agent.displayName}" has non-boolean ${field} frontmatter; it is ignored`,
			);
		}
	}
	if (frontmatter.inheritProjectContext === true) {
		warnings.push(
			`agent "${agent.displayName}" requests inheritProjectContext: true: its workers load the user's and project's instruction files (Pi loads only those; Claude and Codex inherit all user context)`,
		);
	}
	return warnings;
}
