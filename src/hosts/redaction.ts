// New in agent-workflow (WP19, stage-2 review #7): the one redactor for host text that can carry
// worker output (logs, wait/status/inspect/show text and result previews, the Pi completion
// message). The shared text redaction (`redactSensitiveWorkflowText`: credential assignments,
// quoted structured credentials such as `"Authorization":"Basic …"` and `"refresh_token":"…"`,
// header lines, bearer tokens, URL secrets, macOS/Linux/Windows home paths) runs after the values
// of sensitive host environment variables (`*_KEY`, `*TOKEN*`, `*SECRET*`, …) are replaced.
import {
	isSensitiveWorkflowQueryKey,
	redactSensitiveWorkflowText,
} from "../core/workflow-sensitive-query.js";
import { createSecretRedactor } from "../executors/redact.js";

/** Shared redaction plus the values of sensitive host environment variables. */
export function hostTextRedactor(
	env: NodeJS.ProcessEnv,
): (text: string) => string {
	const secrets: [string, string][] = [];
	for (const [key, value] of Object.entries(env))
		if (typeof value === "string" && isSensitiveWorkflowQueryKey(key))
			secrets.push([value, key]);
	const envRedactor = createSecretRedactor(secrets, {
		minLength: 8,
		replacement: (label) => `[REDACTED:${label}]`,
	});
	return (text) => redactSensitiveWorkflowText(envRedactor.text(text));
}
