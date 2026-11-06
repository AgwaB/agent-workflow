import { stripVTControlCharacters } from "node:util";
import type { ToolCallEvent } from "../../sdk/events.js";
import { TOOL_OUTPUT_EVENT_LIMIT } from "./normalize.js";

/** Only the two execpolicy rejection shapes verified against codex-cli 0.166.0. */
export function codexStderrDenial(
	line: string,
	redact: (text: string) => string = (text) => text,
): ToolCallEvent | undefined {
	const clean = stripVTControlCharacters(line).trim();
	const match =
		/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+)?ERROR codex_core::tools::router:\s+error=exec_command failed: CreateProcess \{ message: ("(?:\\.|[^"\\])*") \}$/u.exec(
			clean,
		);
	if (match?.[1] === undefined) return undefined;
	let reason: unknown;
	try {
		const message: unknown = JSON.parse(match[1]);
		if (
			typeof message !== "string" ||
			!message.startsWith("Rejected(") ||
			!message.endsWith(")")
		)
			return undefined;
		reason = JSON.parse(message.slice(9, -1));
	} catch {
		return undefined;
	}
	if (typeof reason !== "string") return undefined;
	const command =
		/^`([^\r\n]+)` rejected: policy forbids commands starting with `[^`\r\n]+`$/u.exec(
			reason,
		)?.[1];
	if (
		command === undefined &&
		reason !== "approval required by policy, but AskForApproval is set to Never"
	)
		return undefined;
	return {
		type: "tool_call",
		name: "shell",
		kind: "execute",
		status: "denied",
		...(command === undefined
			? {}
			: {
					input: { command: redact(command).slice(0, TOOL_OUTPUT_EVENT_LIMIT) },
				}),
		output: redact(reason).slice(0, TOOL_OUTPUT_EVENT_LIMIT),
	};
}

/** Chunk-safe, bounded line reader. Oversized/unknown lines are ignored, never guessed. */
export class CodexStderrParser {
	private buffer = "";
	private dropping = false;
	constructor(
		private readonly redact: (text: string) => string = (text) => text,
	) {}
	push(text: string): ToolCallEvent[] {
		const events: ToolCallEvent[] = [];
		for (const part of text.split(/(?<=\n)/u)) {
			if (!this.dropping) {
				this.buffer += part;
				if (this.buffer.length > 65_536) {
					this.buffer = "";
					this.dropping = true;
				}
			}
			if (part.endsWith("\n")) {
				const event = this.dropping
					? undefined
					: codexStderrDenial(this.buffer, this.redact);
				if (event !== undefined) events.push(event);
				this.buffer = "";
				this.dropping = false;
			}
		}
		return events;
	}
	finish(): ToolCallEvent[] {
		return this.push("\n");
	}
}
