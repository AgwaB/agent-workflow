/**
 * Model ids written for Pi carry Pi's provider prefix (`openai-codex/gpt-6.1-sol`,
 * `anthropic/claude-opus-5-5`); a legacy `~/.pi` agent or workflow brings them to every executor.
 * The CLI executors take bare ids. This translates the prefix an executor's own CLI owns and
 * names the ones it can never serve, so the run is refused before launch instead of a stage
 * failing mid-run with "unknown model".
 *
 * - codex: `openai-codex/` (Pi's ChatGPT-login provider) is dropped. Other `provider/…` ids pass
 *   through: a Codex custom provider (OpenRouter, a gateway) may use such ids legitimately.
 * - claude: `anthropic/` is dropped; any other `provider/…` id is refused (Claude Code serves only
 *   Anthropic models; Bedrock ARNs contain `:` before their `/` and are not provider prefixes).
 * - pi and others: unchanged (Pi resolves provider-qualified ids itself).
 */
export function executorModelId(
	executorId: string,
	model: string,
): { model: string } | { refused: string } {
	const prefix = /^([a-z0-9][a-z0-9-]*)\//u.exec(model)?.[1];
	if (prefix === undefined) return { model };
	if (executorId === "codex")
		return prefix === "openai-codex"
			? { model: model.slice(prefix.length + 1) }
			: { model };
	if (executorId === "claude")
		return prefix === "anthropic"
			? { model: model.slice(prefix.length + 1) }
			: {
					refused: `model "${model}" belongs to provider ${prefix}, which Claude Code cannot run`,
				};
	return { model };
}
