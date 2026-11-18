// test-tier: integration
// Legacy routing and observation-only Executors layout.
import assert from "node:assert/strict";
import test from "node:test";
import {
	executorsFixture,
	loadExecutors,
} from "../helpers/dashboard-profiles.mjs";
const opts = { timeout: 60000 };

test(
	"Executors legacy deep links survive reload and Back/Forward without a Profiles page",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		await loadExecutors(p);
		await loadExecutors(
			p,
			p.url.replace("view=executors", "view=profiles") +
				"&profile=missing&createProfile=1",
		);
		await p.b.waitFor(
			() => new URL(location.href).searchParams.get("view") === "executors",
		);
		await p.b.send("Page.reload");
		await p.b.waitFor(() => !!document.querySelector(".executors"));
		await p.b.evaluate(() => history.back());
		await p.b.waitFor(() => !!document.querySelector(".executors"));
		await p.b.evaluate(() => history.forward());
		await p.b.waitFor(() => document.title.startsWith("Executors"));
		assert.equal(
			await p.b.evaluate(
				() =>
					document.querySelectorAll(
						".profiles-page, [data-profile-open], [data-profile-new]",
					).length,
			),
			0,
		);
		assert.deepEqual(p.b.errors, []);
	},
);

test(
	"Executor permission fact and status table remain readable at narrow and wide widths",
	opts,
	async (t) => {
		const p = await executorsFixture(t);
		for (const width of [390, 1600]) {
			await p.b.send("Emulation.setDeviceMetricsOverride", {
				width,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await loadExecutors(p);
			const layout = await p.b.evaluate(() => {
				const fact = document.querySelector(
					'[data-testid="executor-permission-fact"]',
				);
				fact.scrollIntoView({ block: "center" });
				const r = fact.getBoundingClientRect();
				const host = document.querySelector(".executor-status-scroll");
				return {
					visible:
						fact.checkVisibility() &&
						r.top >= 0 &&
						r.bottom <= innerHeight &&
						r.left >= 0 &&
						r.right <= innerWidth,
					overflow: document.documentElement.scrollWidth > innerWidth,
					tableScrollable: ["auto", "scroll"].includes(
						getComputedStyle(host).overflowX,
					),
					controls: document.querySelectorAll(
						".executors select, .executors input, .executors button",
					).length,
				};
			});
			assert.deepEqual(
				layout,
				{ visible: true, overflow: false, tableScrollable: true, controls: 0 },
				String(width),
			);
		}
		assert.deepEqual(p.b.errors, []);
	},
);
