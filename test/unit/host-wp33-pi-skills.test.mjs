// New in agent-workflow (WP33 item 5, parity row 59, owner decision Q10): the bundled skills are
// exposed through the Pi package manifest under `aw-` names. Pi resolves a skill by its frontmatter
// `name` (the directory name does not count) and keeps the first of a name, so the generated copies
// (`node tools/release/plugins.mjs build`, source of truth `skills/`) are renamed; none may collide
// with pi-workflow's skill names.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as plugins from "../../tools/release/plugins.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

/** Pi's naming rule (docs/skills.md): lowercase letters, digits, single hyphens, at most 64. */
const PI_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function frontmatter(text) {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	assert.ok(match, "frontmatter");
	const fields = {};
	for (const line of match[1].split("\n")) {
		const index = line.indexOf(":");
		if (index > 0)
			fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return fields;
}

/** pi-workflow's skill names: the pinned list, plus an installed pi-workflow when one is found. */
function piWorkflowSkillNames() {
	const names = new Set(plugins.PI_WORKFLOW_SKILL_NAMES);
	const roots = [
		process.env.AGENT_WORKFLOW_PI_WORKFLOW_ROOT,
		join(repo, "node_modules", "@agwab", "pi-workflow"),
	].filter(Boolean);
	for (const root of roots) {
		const manifest = join(root, "package.json");
		if (!existsSync(manifest)) continue;
		const other = JSON.parse(readFileSync(manifest, "utf8"));
		for (const path of other.pi?.skills ?? []) {
			const file = join(root, path, "SKILL.md");
			if (existsSync(file))
				names.add(frontmatter(readFileSync(file, "utf8")).name);
		}
	}
	return names;
}

test("package.json pi.skills lists the aw- skills; each directory holds a SKILL.md named like it", () => {
	assert.deepEqual(pkg.pi.skills, [
		"./plugins/pi/skills/aw-workflow-guide",
		"./plugins/pi/skills/aw-execution-router",
	]);
	assert.deepEqual(pkg.pi.extensions, ["./dist/hosts/pi/index.js"]);
	assert.ok(pkg.files.includes("plugins/pi"), "published with the package");
	for (const path of pkg.pi.skills) {
		const file = join(repo, path, "SKILL.md");
		const fields = frontmatter(readFileSync(file, "utf8"));
		assert.equal(fields.name, path.split("/").at(-1), file);
		assert.match(fields.name, /^aw-/);
		assert.match(fields.name, PI_SKILL_NAME);
		assert.ok(fields.name.length <= 64);
		assert.ok(fields.description && fields.description.length <= 1024, file);
	}
});

test("no Pi skill name collides with pi-workflow's skills", () => {
	const ours = pkg.pi.skills.map(
		(path) =>
			frontmatter(readFileSync(join(repo, path, "SKILL.md"), "utf8")).name,
	);
	assert.equal(new Set(ours).size, ours.length, "unique among themselves");
	const theirs = piWorkflowSkillNames();
	assert.ok(theirs.has("workflow-guide") && theirs.has("execution-router"));
	for (const name of ours) assert.equal(theirs.has(name), false, name);
});

test("the Pi copies are generated from skills/ and their relative paths resolve inside the package", async () => {
	assert.deepEqual(await plugins.checkCommitted(repo), []);
	for (const path of pkg.pi.skills) {
		const dir = join(repo, path);
		const text = readFileSync(join(dir, "SKILL.md"), "utf8");
		for (const [, rel] of text.matchAll(/`(\.\.\/[^`<\s]+)`/g))
			assert.ok(existsSync(resolve(dir, rel)), `${path}: ${rel}`);
		// Every other line equals the source (only the name and paths are adapted).
		const source = readFileSync(
			join(
				repo,
				"skills",
				path.split("/").at(-1).replace(/^aw-/, ""),
				"SKILL.md",
			),
			"utf8",
		);
		assert.equal(text.split("\n").length, source.split("\n").length);
	}
	const router = readFileSync(
		join(repo, "plugins/pi/skills/aw-execution-router/SKILL.md"),
		"utf8",
	);
	assert.match(router, /Consult `aw-workflow-guide` only after/);
	const guide = readFileSync(
		join(repo, "plugins/pi/skills/aw-workflow-guide/SKILL.md"),
		"utf8",
	);
	assert.doesNotMatch(guide, /`\.\/scaffolds\//);
});
