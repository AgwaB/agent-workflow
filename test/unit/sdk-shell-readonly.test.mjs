// Read-only shell commands on readOnly stages (owner decision 2026-11-02; ported from gajae-code's
// read-only bash profile).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	checkReadOnlyShellCommand,
	decideApproval,
	defaultApprovalPolicy,
	effectiveApprovalKind,
	isReadOnlyShellCommand,
	validateExecEvent,
} from "../../dist/sdk/index.js";

test("plain inspection commands pass", () => {
	for (const command of [
		"ls",
		"ls -la src",
		"tree -L 2",
		"pwd",
		"rg -n 'workflow stop' src",
		"rg --files",
		'grep -rn "cancel" sample/src',
		"find . -name '*.ts' -type f",
		"cat sample/src/workflow-stop.ts",
		"head -n 40 a.ts",
		"tail -n 20 a.ts",
		"wc -l a.ts b.ts",
		"du -sh src",
		"stat a.ts",
		"file a.ts",
		"git status --short",
		"git log --oneline -5",
		"git diff HEAD~1 -- src",
		"git show HEAD:package.json",
		"git blame -L 1,20 a.ts",
		"git ls-files src",
		"git rev-parse HEAD",
	])
		assert.equal(checkReadOnlyShellCommand(command).ok, true, command);
});

test("anything that writes, chains, expands or runs another program is refused", () => {
	const refused = {
		"echo OK > conformance-readonly.txt":
			/not a read-only inspection command|operator/,
		"ls > out.txt": /operator '>'/,
		"cat a | sh": /operator '\|'/,
		"ls; rm -rf .": /operator ';'/,
		"ls && rm x": /operator '&'/,
		"cat $(echo /etc/passwd)": /expansion '\$'/,
		"cat `id`": /command substitution/,
		'grep "$HOME" a': /inside double quotes/,
		"ls *.ts": /expansion '\*'/,
		"ls ~/secrets": /home expansion/,
		"ls a\\ b": /backslash/,
		"ls\nrm x": /more than one command/,
		"cat 'unterminated": /unterminated quote/,
		"rm -rf build": /rm is not a read-only inspection command/,
		"sed -i s/a/b/ f": /sed is not/,
		"FOO=1 ls": /FOO=1 is not/,
		"find . -name x -delete": /find -delete/,
		"find . -exec rm {} ;": /operator ';'|expansion/,
		"find . -execdir ls": /find -execdir/,
		"find . -fprint out": /find -fprint/,
		"rg --pre ./x pattern": /preprocessors/,
		"rg --pre=./x pattern": /preprocessors/,
		"rg -zn pattern": /-z/,
		"rg --hostname-bin ./x p": /hostname-bin/,
		"tree -o out.txt": /tree -o/,
		"file -C -m magic": /file -C/,
		"tail -f log": /does not end/,
		"git push": /git push is not a read-only git command/,
		"git -c core.pager=sh log": /git -c is not/,
		"git diff --output=x": /--output/,
		"git log -p --ext-diff": /--ext-diff/,
		"": /empty command/,
	};
	for (const [command, reason] of Object.entries(refused)) {
		const check = checkReadOnlyShellCommand(command);
		assert.equal(check.ok, false, command);
		assert.match(check.reason, reason, `${command}: ${check.reason}`);
	}
	// `~` inside a word is literal (git revisions).
	assert.equal(isReadOnlyShellCommand("git diff HEAD~2"), true);
});

test("a readOnly stage judges a plain read-only shell request as search; others stay execute", () => {
	const ro = { readOnly: true, permissionMode: "safe" };
	const read = { kind: "execute", command: "rg -n stop src" };
	assert.equal(effectiveApprovalKind(read, ro), "search");
	assert.equal(effectiveApprovalKind(read, { readOnly: false }), "execute");
	assert.equal(effectiveApprovalKind({ kind: "execute" }, ro), "execute");
	assert.equal(
		effectiveApprovalKind({ kind: "edit", command: "ls" }, ro),
		"edit",
	);
	// safe: allowed when the stage's tools allow search (grep/find), denied otherwise.
	const searchPolicy = defaultApprovalPolicy({
		allowKinds: ["read", "search"],
	});
	assert.equal(decideApproval(searchPolicy, read, ro), "allow");
	assert.equal(decideApproval(defaultApprovalPolicy(), read, ro), "deny");
	// free: allowed; a writing command is denied only in safe mode.
	const free = { readOnly: true, permissionMode: "free" };
	assert.equal(decideApproval(defaultApprovalPolicy(), read, free), "allow");
	const write = { kind: "execute", command: "echo OK > f.txt" };
	assert.equal(decideApproval(searchPolicy, write, ro), "deny");
	assert.equal(decideApproval(defaultApprovalPolicy(), write, free), "allow");
	// The event carries the command as an optional string.
	assert.deepEqual(
		validateExecEvent({
			type: "approval_request",
			requestId: "p1",
			kind: "execute",
			detail: "rg",
			command: "rg x",
		}),
		[],
	);
	assert.notDeepEqual(
		validateExecEvent({
			type: "approval_request",
			requestId: "p1",
			kind: "execute",
			detail: "rg",
			command: 1,
		}),
		[],
	);
});
