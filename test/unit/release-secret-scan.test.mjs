// New in agent-workflow (WP12c): the release check's secret scan (tools/release/secret-scan.mjs)
// flags secret values — token shapes, private-key blocks, JWTs, long high-entropy values under
// key-like names — and not identifier names or documentation mentions (`ANTHROPIC_API_KEY`,
// `PI_RUN_SECRETS_ENV`, "private key block"), which the earlier word pattern rejected.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	findSecretValues,
	isHighEntropySecretValue,
	LOCAL_PATH_PATTERN,
	secretScanSelfTest,
	secretScanSelfTestCases,
} from "../../tools/release/secret-scan.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));

test("self-test: every planted secret is caught, no benign mention is flagged", () => {
	assert.deepEqual(secretScanSelfTest(), []);
	const { planted, benign } = secretScanSelfTestCases();
	assert.ok(planted.length >= 20 && benign.length >= 15);
});

test("findings name the rule and line, never the secret value", () => {
	const { planted } = secretScanSelfTestCases();
	const text = [
		"# config",
		...planted.map(([, value]) => value.replaceAll("\n", "\\n")),
	].join("\n");
	const findings = findSecretValues(text);
	assert.ok(findings.length >= planted.length, JSON.stringify(findings));
	for (const finding of findings) {
		assert.deepEqual(Object.keys(finding).sort(), ["line", "rule"]);
		for (const [, value] of planted)
			assert.ok(!finding.rule.includes(value.slice(-16)));
	}
	assert.equal(findings[0].line, 2);
});

test("token rules: each planted shape reports its own rule", () => {
	const { planted } = secretScanSelfTestCases();
	const rules = (name) =>
		findSecretValues(planted.find(([label]) => label === name)[1]).map(
			(finding) => finding.rule,
		);
	assert.ok(rules("GitHub classic token").includes("GitHub token (gh?_…)"));
	assert.ok(rules("AWS access key id").includes("AWS access key id"));
	assert.ok(rules("RSA private key").includes("private key block"));
	assert.ok(rules("PKCS#8 private key in JSON").includes("private key block"));
	assert.ok(rules("JWT").includes("JWT"));
	assert.ok(rules("npm token").includes("npm token (npm_…)"));
	assert.ok(
		rules("hex secret under a key name").some((rule) =>
			rule.startsWith('high-entropy value assigned to "webhookSecret"'),
		),
	);
});

test("high-entropy values need mixed classes; identifiers, paths and placeholders are not secrets", () => {
	for (const value of [
		"AGENT_WORKFLOW_PI_RUN_SECRETS_JSON",
		"AW_CONFORMANCE_MCP_TOKEN",
		"agent-workflow.workflow_1.task-2",
		"/var/lib/agent-workflow/run-index/a1.json",
		"xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		"clientSecretFromEnvironment",
		"12345678901234567890123",
	])
		assert.equal(isHighEntropySecretValue(value), false, value);
	for (const value of [
		"Zk3pQ9vX2mL7wR4tY8nB1cD6",
		"3f9a1c0be47d2a5f8e6b9c0d1e2f3a4b5c6d7e8f",
		"0f8c2a4e-1b3d-4c5e-9a7b-2d4f6e8a0c1b",
	])
		assert.equal(isHighEntropySecretValue(value), true, value);
	// Unquoted values only count on env/ini lines, not as code expressions.
	assert.deepEqual(
		findSecretValues(
			"\t\tlaunchAuthoritySha256: record.launchAuthoritySha256,\n" +
				"const authorityBindingSha256 = options.authorityBindingSha256Value2;\n",
		),
		[],
	);
	assert.equal(
		findSecretValues("export DB_PASSWORD=Zk3pQ9vX2mL7wR4tY8nB1cD6\n").length,
		1,
	);
});

function filesUnder(path) {
	const absolute = join(repo, path);
	if (!existsSync(absolute)) return [];
	if (statSync(absolute).isFile()) return [path];
	return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
		filesUnder(join(path, entry.name)),
	);
}

test("shipped text (src, dist, docs, skills, workflows, agents, README) has no secret values or local paths", () => {
	const files = [
		"src",
		"dist",
		"docs",
		"skills",
		"workflows",
		"agents",
		"README.md",
		"NOTICE",
	]
		.flatMap(filesUnder)
		.filter((path) => !/\.(png|jpe?g|gif|webp|svg|node)$/iu.test(path));
	assert.ok(files.length > 100, String(files.length));
	const findings = files.flatMap((path) =>
		findSecretValues(readFileSync(join(repo, path), "utf8")).map(
			(finding) => `${path}:${finding.line}: ${finding.rule}`,
		),
	);
	assert.deepEqual(findings, []);
	// release-check also refuses local machine paths and desktop artifact names.
	assert.deepEqual(
		files.filter((path) =>
			LOCAL_PATH_PATTERN.test(readFileSync(join(repo, path), "utf8")),
		),
		[],
	);
	// The words the earlier pattern rejected are still in the shipped docs and sources.
	const docs = readFileSync(join(repo, "docs/environment.md"), "utf8");
	assert.match(docs, /ANTHROPIC_API_KEY/);
});
