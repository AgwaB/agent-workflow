/**
 * Worker session files under the Claude config dir (D3, R#10). Claude Code keeps a session as
 * `<configDir>/projects/<cwd slug>/<sessionId>.jsonl` plus a `<sessionId>/` directory (spilled
 * tool results; measured live: an MCP result over `MAX_MCP_OUTPUT_TOKENS` is written to
 * `<sessionId>/tool-results/` even with `--no-session-persistence`). The adapter only removes entries
 * named after a session UUID it created; the slug is not recomputed, every project dir is checked
 * for that exact name.
 */
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isUuid } from "./argv.js";

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Remove `<sessionId>/` (and with `transcript`, `<sessionId>.jsonl`) from every project dir.
 * Returns how many entries were removed. Empty project dirs left behind are removed too.
 */
export async function removeClaudeSessionFiles(
	claudeConfigDir: string,
	sessionId: string,
	options: { readonly transcript: boolean },
): Promise<number> {
	if (!isUuid(sessionId)) return 0;
	const projects = join(claudeConfigDir, "projects");
	let entries: string[];
	try {
		entries = await readdir(projects);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const project of entries) {
		const dir = join(projects, project);
		let touched = false;
		const targets = [join(dir, sessionId)];
		if (options.transcript) targets.push(join(dir, `${sessionId}.jsonl`));
		for (const target of targets)
			if (await exists(target)) {
				await rm(target, { recursive: true, force: true });
				removed += 1;
				touched = true;
			}
		if (touched) await rmdir(dir).catch(() => {}); // only succeeds when empty
	}
	return removed;
}
