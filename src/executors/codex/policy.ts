// Codex rules the engine applies before launch (core/executor-policy.ts): the built-in default
// profile (the `codex` preset) and the user's own Codex defaults from `$CODEX_HOME/config.toml`,
// used for every stage when the preset's model is not offered on this machine.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExecutorPolicy,
	ExecutorUserDefaults,
} from "../../core/executor-policy.js";

/** `key = "value"` pairs of one TOML table (`undefined`: the top level, before any header). */
function tomlStrings(
	text: string,
	table: string | undefined,
): Record<string, string> {
	const values: Record<string, string> = {};
	let current: string | undefined;
	for (const raw of text.split(/\r?\n/u)) {
		const line = raw.trim();
		const header = /^\[([^\]]+)\]$/u.exec(line);
		if (header) {
			current = header[1]!.replace(/"/gu, "").trim();
			continue;
		}
		if (current !== table) continue;
		const pair = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/u.exec(line);
		if (pair) values[pair[1]!] = pair[2]!;
	}
	return values;
}

/** The model and reasoning effort Codex uses when a request names none (its active profile first). */
export function codexUserDefaults(
	env: NodeJS.ProcessEnv = process.env,
): ExecutorUserDefaults | undefined {
	const path = join(
		env.CODEX_HOME || join(env.HOME || homedir(), ".codex"),
		"config.toml",
	);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const top = tomlStrings(text, undefined);
	const selected = top.profile
		? { ...top, ...tomlStrings(text, `profiles.${top.profile}`) }
		: top;
	const model = selected.model?.trim() || undefined;
	const effort = selected.model_reasoning_effort?.trim() || undefined;
	if (model === undefined && effort === undefined) return undefined;
	return {
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
		source: path,
	};
}

export const CODEX_EXECUTOR_POLICY: ExecutorPolicy = {
	defaultPreset: "codex",
	userDefaults: codexUserDefaults,
};
