import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stateDir } from "../helpers/state-dir.mjs";
import {
	formatHumanWorkflowResult,
	readWorkflowResultPresentation,
} from "../../dist/hosts/result-presentation.js";
import { completionPlainText } from "../../dist/hosts/terminal-markdown.js";

test("terminal reading view handles lists, headings, GFM cells and literal code", () => {
	const markdown = [
		"## **Decisions** ##",
		"",
		"1. *Keep* the **evidence**",
		"   + [X] Read _sources_",
		"",
		"| Path | Note |",
		"|---|---|",
		"| `` A`B\\|C &gt; `` | &lt; &#124; &#64; &amp;gt; |",
		"",
		"~~~~txt",
		"`literal` \u200f &gt;",
		"~~~~",
		"",
		String.raw`\#literal heading and \*not emphasis\*`,
	].join("\n");
	assert.equal(
		completionPlainText(markdown),
		[
			"Decisions",
			"",
			"1. Keep the evidence",
			"   - [x] Read sources",
			"",
			"Path | Note",
			"A`B|C &gt; | < | @ &gt;",
			"",
			"`literal` \\u200F &gt;",
			"",
			"#literal heading and *not emphasis*",
		].join("\n"),
	);
});

test("terminal resolves multiline code before decoding paragraph prose", () => {
	const markdown =
		"Value: `A\n&gt; \\-flag` and &gt;.\nNext line.\n\n`open\n\nclose`";
	assert.equal(
		completionPlainText(markdown),
		"Value: A &gt; \\-flag and >.\nNext line.\n\n`open\n\nclose`",
	);
});

test("only the bundled spec and impact final producers get the legacy escaped-entity interpretation", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-terminal-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const dir = join(stateDir(cwd), ".agent-workflow", "tasks", "task-1");
	await mkdir(dir, { recursive: true });
	const markdown =
		"a \\&gt; b, `\\&gt;`, [link](https://example.com/?q=\\&gt;)";
	await writeFile(
		join(dir, "control.json"),
		JSON.stringify({ completionSummaryMarkdown: markdown }),
	);
	const bundled = fileURLToPath(
		new URL("../../workflows/spec-review/spec.json", import.meta.url),
	);
	const impact = fileURLToPath(
		new URL("../../workflows/impact-review/spec.json", import.meta.url),
	);
	const run = {
		cwd,
		name: "spec-review",
		status: "completed",
		tasks: [
			{
				kind: "support",
				specId: "final.main",
				status: "completed",
				files: { output: join(dir, "output.md") },
			},
		],
	};
	for (const [specPath, comparison] of [
		[bundled, ">"],
		[impact, ">"],
		[join(cwd, "spec.json"), "&gt;"],
	]) {
		const presentation = await readWorkflowResultPresentation(
			cwd,
			{ ...run, specPath },
			["final.main"],
		);
		assert.equal(formatHumanWorkflowResult(presentation), markdown);
		assert.equal(
			formatHumanWorkflowResult(presentation, true),
			`a ${comparison} b, \\&gt;, link (https://example.com/?q=&gt;)`,
		);
	}
});
