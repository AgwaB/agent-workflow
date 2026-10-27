// New in agent-workflow (WP12b): E2E support helper (deterministic, no side effects). Counts the
// reviewer controls and echoes the triage lens ids.
export default async function merge({ sources }) {
	const entries = Object.entries(sources ?? {});
	const reviewers = entries.filter(([key]) => key.startsWith("reviewers"));
	const triage = entries.find(([key]) => key === "triage")?.[1];
	const lensIds = Array.isArray(triage?.lenses)
		? triage.lenses.map((lens) => String(lens.id))
		: [];
	// In an artifact-graph workflow the returned object is the stage's control.json.
	return {
		schema: "e2e-merge-control-v1",
		digest: `merged ${reviewers.length} reviewer controls`,
		reviewerCount: reviewers.length,
		lensIds,
	};
}
