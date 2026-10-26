export function isRegistryFreeValidationOnly(env = process.env) {
	return (
		env.AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION === "1" &&
		env.GITHUB_ACTIONS === "true"
	);
}
