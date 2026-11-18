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
export const seedProfile = (p, values = {}, name = "codex") =>
	profileAction(p.ctx, { op: "set", name, values });
