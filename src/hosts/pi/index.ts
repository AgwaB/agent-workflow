// New in agent-workflow (WP11b): `@agwab/agent-workflow/hosts/pi`, the Pi extension entry (also the
// `pi.extensions` entry of package.json). Load it from Pi: `pi -e <package>/dist/hosts/pi/index.js`
// or `pi install npm:@agwab/agent-workflow`. The Pi packages are optional peers of agent-workflow;
// importing this entry without Pi fails here with an explicit message instead of a bare module
// resolution error. Inside Pi the import resolves to Pi's own copy (Pi maps its packages for
// extensions). Nothing else in agent-workflow imports this module.
export const MODULE = "src/hosts/pi";

// Not a string literal on purpose: the package type-checks and builds without the optional peer.
const PI_PACKAGE: string = ["@earendil-works", "pi-coding-agent"].join("/");

export class PiHostUnavailableError extends Error {
	constructor(cause: unknown) {
		super(
			`@agwab/agent-workflow/hosts/pi is a Pi extension and needs the Pi coding agent (${PI_PACKAGE}, an optional peer dependency), which could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}. Load it from Pi (pi -e <path-to>/dist/hosts/pi/index.js, or pi install npm:@agwab/agent-workflow), or install the peer. The CLI (agent-workflow) and @agwab/agent-workflow/hosts/api do not need Pi.`,
		);
		this.name = "PiHostUnavailableError";
	}
}

try {
	await import(PI_PACKAGE);
} catch (error) {
	throw new PiHostUnavailableError(error);
}

export {
	createAgentWorkflowPiExtension,
	default,
	type PiHostApi,
	type PiHostOptions,
} from "./extension.js";
export {
	AW_COMMAND,
	AW_DYNAMIC_TOOL,
	AW_LIST_TOOL,
	AW_RUN_TOOL,
	AW_TOOL_NAMES,
	AW_WAIT_TOOL,
} from "./names.js";
