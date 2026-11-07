// Claude Code rules the engine applies before launch (core/executor-policy.ts): the built-in default
// profile (the `claude` preset) and the user's own Claude Code defaults from `settings.json`, used
// for every stage when the preset's model is not offered on this machine. Workers run with user
// settings switched off (isolation), so the engine passes these values explicitly.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExecutorPolicy,
	ExecutorUserDefaults,
} from "../../core/executor-policy.js";

/** The `model` and `effortLevel` of the user's Claude Code settings. */
export function claudeUserDefaults(
	env: NodeJS.ProcessEnv = process.env,
): ExecutorUserDefaults | undefined {
	const path = join(
		env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
		"settings.json",
	);
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (!settings || typeof settings !== "object" || Array.isArray(settings))
		return undefined;
	const record = settings as Record<string, unknown>;
	const model =
		typeof record.model === "string" && record.model.trim()
			? record.model.trim()
			: undefined;
	const effort =
		typeof record.effortLevel === "string" && record.effortLevel.trim()
			? record.effortLevel.trim()
			: undefined;
	if (model === undefined && effort === undefined) return undefined;
	return {
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
		source: path,
	};
}

export const CLAUDE_EXECUTOR_POLICY: ExecutorPolicy = {
	defaultPreset: "claude",
	userDefaults: claudeUserDefaults,
};
