import assert from "node:assert/strict";
import { test } from "node:test";
import { createSecretRedactor } from "../../dist/executors/redact.js";
import {
	CodexStderrParser,
	codexStderrDenial,
} from "../../dist/executors/codex/stderr.js";

const line = (reason) =>
	`2026-11-06T03:47:04.836808Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: ${JSON.stringify(`Rejected(${JSON.stringify(reason)})`)} }`;
const forbidden =
	"`/bin/zsh -lc 'touch probe-a.txt'` rejected: policy forbids commands starting with `touch`";
const prompt =
	"approval required by policy, but AskForApproval is set to Never";

test("recorded Codex execpolicy stderr forms normalize to denied shell events", () => {
	assert.deepEqual(codexStderrDenial(line(forbidden)), {
		type: "tool_call",
		name: "shell",
		kind: "execute",
		status: "denied",
		input: { command: "/bin/zsh -lc 'touch probe-a.txt'" },
		output: forbidden,
	});
	assert.deepEqual(
		codexStderrDenial(
			`\x1b[2m${line(prompt).replace("ERROR", "\x1b[31mERROR\x1b[0m")}\x1b[0m`,
		),
		{
			type: "tool_call",
			name: "shell",
			kind: "execute",
			status: "denied",
			output: prompt,
		},
	);
});

test("unknown, unrelated, model-quoted, incomplete and malformed rejection lines emit nothing", () => {
	for (const text of [
		"",
		"ERROR unrelated",
		line("new unknown rejection"),
		line(prompt).replace("exec_command", "other_tool"),
		line(prompt).replace("ERROR", "WARN"),
		`model says ${line(prompt)}`,
		line(prompt).slice(0, -2),
		line(prompt).replace("Rejected", "NotRejected"),
		"ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: bad }",
	])
		assert.equal(codexStderrDenial(text), undefined, text);
});

test("stderr lines tolerate every chunk boundary, CRLF, and a final unterminated line", () => {
	const text = `${line(forbidden)}\r\n${line(prompt)}`;
	for (let split = 0; split <= text.length; split++) {
		const parser = new CodexStderrParser();
		assert.deepEqual(
			[
				...parser.push(text.slice(0, split)),
				...parser.push(text.slice(split)),
				...parser.finish(),
			],
			[codexStderrDenial(line(forbidden)), codexStderrDenial(line(prompt))],
		);
	}
});

test("oversized stderr lines are dropped and reasons/commands are bounded", () => {
	const parser = new CodexStderrParser();
	assert.deepEqual(parser.push(`${"x".repeat(70_000)}${line(prompt)}\n`), []);
	assert.equal(parser.push(`${line(prompt)}\n`).length, 1);
	const event = codexStderrDenial(
		line(
			`\`${"x".repeat(20_000)}\` rejected: policy forbids commands starting with \`x\``,
		),
	);
	assert.equal(event.output.length, 16_384);
	assert.equal(event.input.command.length, 16_384);
});

test("decoded stderr secrets are redacted before reason/command truncation", () => {
	const secret = 'hidden-"quoted"-secret';
	const redact = createSecretRedactor([[secret, "TOKEN"]], {
		minLength: 8,
		replacement: () => "<redacted>",
	});
	const command = "x".repeat(16_380) + secret;
	const parser = new CodexStderrParser(redact.text);
	const [event] = parser.push(
		`${line(`\`${command}\` rejected: policy forbids commands starting with \`x\``)}\n`,
	);
	assert.equal(event.output.length, 16_384);
	assert.equal(event.input.command.length, 16_384);
	assert.equal(JSON.stringify(event).includes("hidden"), false);
	assert.equal(JSON.stringify(event).includes("quoted"), false);
});
