import assert from "node:assert/strict";
import { createBrowser, findChrome } from "./dashboard-browser.mjs";
import { managementProject } from "./dashboard-management.mjs";
import { profileAction } from "../../dist/hosts/catalog.js";

export async function executorsFixture(t, options = {}) {
	const chrome = await findChrome();
	assert.ok(chrome, "Chrome is required");
	const p = await managementProject(t, options);
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	await b.send("Emulation.setDeviceMetricsOverride", {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	const url = `${p.origin}/?project=${p.server.projectId}&view=executors`;
	return { ...p, b, url };
}
export async function loadExecutors(p, url = p.url) {
	await p.b.send("Page.navigate", { url });
	await p.b.waitFor(() => !!document.querySelector(".executors"));
}
export async function setPermission(b, value, executor = "codex") {
	await b.evaluate(
		(value, executor) => {
			const control = document.querySelector(
				`[aria-label="${executor} permission mode"]`,
			);
			if (!control) throw new Error(`Missing ${executor} permission mode`);
			control.value = value;
			control.dispatchEvent(new Event("change", { bubbles: true }));
		},
		value,
		executor,
	);
}
export async function toggleCapability(b, capability, executor = "codex") {
	await b.evaluate(
		(capability, executor) => {
			const row = document.querySelector(
				`[data-executor-permissions="${executor}"]`,
			);
			row.querySelector("details").open = true;
			row.querySelector(`input[value="${capability}"]`).click();
		},
		capability,
		executor,
	);
}
export async function savePermissions(b, executor = "codex") {
	await b.evaluate(
		(executor) =>
			document
				.querySelector(
					`[data-executor-permissions="${executor}"] [data-save-permissions]`,
				)
				.click(),
		executor,
	);
	await b.waitFor(
		`document.querySelector('[data-executor-permissions="${executor}"] [role="status"]')?.textContent === 'Saved.'`,
	);
}
export const storedProfile = async (p, name = "codex") =>
	(await profileAction(p.ctx, { op: "show", name })).data.profile;
export const seedProfile = (p, values = {}, name = "codex") =>
	profileAction(p.ctx, { op: "set", name, values });
