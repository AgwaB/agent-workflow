import assert from "node:assert/strict";
import { createBrowser, findChrome } from "./dashboard-browser.mjs";
import { managementProject } from "./dashboard-management.mjs";
import { profileAction } from "../../dist/hosts/catalog.js";

export async function profilesFixture(t, options = {}) {
	const chrome = await findChrome();
	assert.ok(chrome, "Chrome is required");
	const p = await managementProject(t, options);
	const b = await createBrowser(chrome);
	t.after(() => b.close());
	const url = `${p.origin}/?project=${p.server.projectId}&view=profiles`;
	return { ...p, b, url };
}
export async function loadProfiles(p, suffix = "") {
	await p.b.send("Page.navigate", { url: p.url + suffix });
	await p.b.waitFor(() => !!document.querySelector(".profile-overview"));
}
export async function editProfile(b, name = "daily") {
	await b.click(`[data-profile-open="${name}"]`);
	await b.waitFor(
		() => !!document.querySelector('[data-management-action="save-profile"]'),
	);
}
export async function setProfileField(b, label, value) {
	await b.evaluate(
		(label, value) => {
			const control = document.querySelector(`[aria-label="${label}"]`);
			if (!control) throw new Error(`Missing field: ${label}`);
			control.value = value;
			control.dispatchEvent(new Event("input", { bubbles: true }));
			control.dispatchEvent(new Event("change", { bubbles: true }));
		},
		label,
		value,
	);
}
export async function profileButton(b, text) {
	await b.evaluate((text) => {
		const node = [...document.querySelectorAll("#center button")].find(
			(n) => n.textContent === text && n.checkVisibility(),
		);
		if (!node) throw new Error(`Missing visible button: ${text}`);
		node.click();
	}, text);
}
export async function saveProfile(b) {
	await b.click('[data-management-action="save-profile"]');
	await b.waitFor(() => !!document.querySelector(".profile-save-status"));
}
export const storedProfile = async (p, name = "daily") =>
	(await profileAction(p.ctx, { op: "show", name })).data.profile;
export const seedProfile = (p, values = {}, name = "daily") =>
	profileAction(p.ctx, { op: "set", name, values });
