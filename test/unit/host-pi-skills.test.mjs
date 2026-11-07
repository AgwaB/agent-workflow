// Pi package skills retain their source names and use package-relative paths.
// Generated copies come from skills/ via `node tools/release/plugins.mjs build`.
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

test("package.json pi.skills lists the Pi skills; each directory holds a SKILL.md named like it", () => {
	assert.deepEqual(pkg.pi.skills, [
		"./plugins/pi/skills/workflow-guide",
		"./plugins/pi/skills/execution-router",
	]);
	assert.deepEqual(pkg.pi.extensions, ["./dist/hosts/pi/index.js"]);
	assert.ok(pkg.files.includes("plugins/pi"), "published with the package");
	for (const path of pkg.pi.skills) {
		const file = join(repo, path, "SKILL.md");
		const fields = frontmatter(readFileSync(file, "utf8"));
		assert.equal(fields.name, path.split("/").at(-1), file);
		assert.match(fields.name, PI_SKILL_NAME);
		assert.ok(fields.name.length <= 64);
		assert.ok(fields.description && fields.description.length <= 1024, file);
	}
});

test("Pi skill names are unique within the package", () => {
	const ours = pkg.pi.skills.map(
		(path) =>
			frontmatter(readFileSync(join(repo, path, "SKILL.md"), "utf8")).name,
	);
	assert.equal(new Set(ours).size, ours.length, "unique among themselves");
});

test("the Pi copies are generated from skills/ and their relative paths resolve inside the package", async () => {
	assert.deepEqual(await plugins.checkCommitted(repo), []);
	for (const path of pkg.pi.skills) {
		const dir = join(repo, path);
		const text = readFileSync(join(dir, "SKILL.md"), "utf8");
		for (const [, rel] of text.matchAll(/`(\.\.\/[^`<\s]+)`/g))
			assert.ok(existsSync(resolve(dir, rel)), `${path}: ${rel}`);
		// Only relative paths are adapted; the source names and line count stay intact.
		const source = readFileSync(
			join(repo, "skills", path.split("/").at(-1), "SKILL.md"),
			"utf8",
		);
		assert.equal(text.split("\n").length, source.split("\n").length);
	}
	const router = readFileSync(
		join(repo, "plugins/pi/skills/execution-router/SKILL.md"),
		"utf8",
	);
	assert.match(router, /Consult `workflow-guide` only after/);
	const guide = readFileSync(
		join(repo, "plugins/pi/skills/workflow-guide/SKILL.md"),
		"utf8",
	);
	assert.doesNotMatch(guide, /`\.\/scaffolds\//);
});
