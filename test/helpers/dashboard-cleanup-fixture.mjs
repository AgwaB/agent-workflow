// Deliberately fails in a subprocess; the parent checks teardown after failure/timeout.
import assert from "node:assert/strict";
import test from "node:test";
import { dashboardProject } from "./dashboard-project.mjs";
import { setDashboardStartBudgetForTests } from "../../dist/hosts/dashboard/discovery.js";

setDashboardStartBudgetForTests(15_000);

test("dashboard cleanup failure fixture", {
	timeout: process.env.CLEANUP_MODE === "timeout" ? 1000 : 60_000,
}, async (t) => {
	const keepAlive = setInterval(() => {}, 1000);
	t.after(() => clearInterval(keepAlive));
	const fixture = await dashboardProject(t, "aw-wp43c-failure-");
	console.log(`PROJECT ${fixture.cwd}`);
	const dashboard = await fixture.ensure({ ...process.env, BROWSER: "none" });
	assert.ok(dashboard, "fixture started a real detached dashboard");
	console.log(`DASHBOARD ${dashboard.pid}`);
	if (process.env.CLEANUP_MODE === "timeout") await new Promise(() => {});
	else assert.fail("intentional assertion failure after starting a dashboard");
});
