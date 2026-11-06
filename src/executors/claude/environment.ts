import { readFileSync } from "node:fs";
import type { ExecutorCapabilities } from "../../sdk/capabilities.js";

export interface ClaudeEnvironmentOptions {
	readonly managedSettingsPath?: string;
	readonly platform?: NodeJS.Platform;
	readonly uid?: number;
}
export interface ClaudeEnvironmentFindings {
	readonly managedSettingsPath: string;
	readonly bypassDisabled: boolean;
	readonly denyRules: number;
	readonly askRules: number;
	readonly root: boolean;
	readonly problems: readonly string[];
}

/** Endpoint-managed policy loads even with --setting-sources "". Never read credentials. */
export function inspectClaudeEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env,
	options: ClaudeEnvironmentOptions = {},
): ClaudeEnvironmentFindings {
	const platform = options.platform ?? process.platform;
	const managedSettingsPath =
		options.managedSettingsPath ??
		env.AGENT_WORKFLOW_CLAUDE_MANAGED_SETTINGS_PATH ??
		(platform === "darwin"
			? "/Library/Application Support/ClaudeCode/managed-settings.json"
			: platform === "win32"
				? "C:\\Program Files\\ClaudeCode\\managed-settings.json"
				: "/etc/claude-code/managed-settings.json");
	const problems: string[] = [];
	let bypassDisabled = false;
	let denyRules = 0;
	let askRules = 0;
	const object = (value: unknown): value is Record<string, unknown> =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(managedSettingsPath, "utf8"),
		);
		if (
			!object(parsed) ||
			(parsed.permissions !== undefined && !object(parsed.permissions))
		)
			throw new Error("invalid settings");
		const permissions = object(parsed.permissions) ? parsed.permissions : {};
		bypassDisabled = permissions.disableBypassPermissionsMode === "disable";
		if (
			permissions.disableBypassPermissionsMode !== undefined &&
			!["disable", "allow"].includes(
				String(permissions.disableBypassPermissionsMode),
			)
		)
			throw new Error("invalid bypass setting");
		for (const key of ["deny", "ask"] as const) {
			const rules = permissions[key];
			if (rules === undefined) continue;
			if (
				!Array.isArray(rules) ||
				!rules.every((rule) => typeof rule === "string")
			)
				throw new Error("invalid rules");
			if (key === "deny") denyRules = rules.length;
			else askRules = rules.length;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			problems.push(
				`cannot inspect ${managedSettingsPath}; managed policy may block workers; ask your administrator to verify permissions before running`,
			);
	}
	return {
		managedSettingsPath,
		bypassDisabled,
		denyRules,
		askRules,
		root: platform !== "win32" && (options.uid ?? process.getuid?.()) === 0,
		problems,
	};
}

export function claudeEnvironmentWarnings(
	findings: ClaudeEnvironmentFindings,
): string[] {
	return [
		...(findings.bypassDisabled
			? [
					`managed settings ${findings.managedSettingsPath} set permissions.disableBypassPermissionsMode=disable; free-mode workers cannot use bypassPermissions and startup may be refused; ask your administrator to permit bypass or use a compatible executor/profile`,
				]
			: []),
		...(findings.denyRules > 0
			? [
					`${findings.denyRules} managed permissions.deny rule(s) in ${findings.managedSettingsPath} will deny matching tools even in bypassPermissions; review the rules with your administrator or use a compatible executor`,
				]
			: []),
		...(findings.askRules > 0
			? [
					`${findings.askRules} managed permissions.ask rule(s) in ${findings.managedSettingsPath} can require approval even in bypassPermissions; the workflow answers supported requests automatically, but provider-only interaction may be denied; review the rules with your administrator before running unattended`,
				]
			: []),
		...(findings.root
			? [
					"running as root: Claude Code refuses bypassPermissions under root/sudo unless it recognizes a sandbox; free-mode startup may fail; run workers as a non-root user in the intended sandbox",
				]
			: []),
		...findings.problems,
	];
}

/** Managed policy is not excluded by context isolation; reuse CAPABILITY_WARNING plumbing. */
export function claudeEnvironmentCapabilities(
	findings: ClaudeEnvironmentFindings,
): Partial<ExecutorCapabilities> {
	const warnings = claudeEnvironmentWarnings(findings);
	return warnings.length === 0
		? {}
		: {
				contextIsolation: {
					level: "emulated",
					source: "probed",
					warning: warnings.join("; "),
				},
			};
}
