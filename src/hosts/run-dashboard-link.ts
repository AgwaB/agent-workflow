// New in agent-workflow (2026-11-03): the dashboard link of a run, shared by launch and wait. A
// launch gives it so the user can watch; a finished wait gives it again, opening the report view, so
// the result can be read in the dashboard instead of only through report file paths.
import { getWorkflowProcessRole } from "../core/process-role.js";
import {
	dashboardStartBudgetMs,
	ensureDashboard,
	readDashboardDiscovery,
} from "./dashboard/discovery.js";
import { type HostApiContext, hostEnv } from "./types.js";

/** WP43d: `auth` is set only when that dashboard requires sign-in (`--auth`). */
export interface RunDashboardLink {
	url: string;
	port: number;
	started?: true;
	auth?: true;
}

/**
 * The project's dashboard URL for `runId` (`view=report` opens the report). A running dashboard is
 * reused; with `start` (and autostart on, supervisor role, not read-only) one is started. Best
 * effort within the discovery budget (`dashboardStartBudgetMs`); undefined when none is available.
 */
export async function runDashboardLink(
	ctx: HostApiContext,
	runId: string,
	options: { start: boolean; view?: "report" },
): Promise<RunDashboardLink | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async (): Promise<RunDashboardLink | undefined> => {
				let dashboard = await readDashboardDiscovery(ctx.cwd);
				let started = false;
				if (
					!dashboard &&
					options.start &&
					hostEnv(ctx).AGENT_WORKFLOW_DASHBOARD_AUTOSTART !== "0" &&
					getWorkflowProcessRole(hostEnv(ctx)) === "supervisor" &&
					!ctx.readonly
				) {
					dashboard = await ensureDashboard(ctx.cwd, hostEnv(ctx), {
						start: true,
					});
					started = Boolean(dashboard);
				}
				if (!dashboard) return undefined;
				const query = new URLSearchParams({ run: runId });
				if (options.view) query.set("view", options.view);
				return {
					url: `http://127.0.0.1:${dashboard.port}/?${query.toString()}`,
					port: dashboard.port,
					...(started ? { started: true as const } : {}),
					...(dashboard.auth ? { auth: true as const } : {}),
				};
			})(),
			new Promise<undefined>((done) => {
				timer = setTimeout(() => done(undefined), dashboardStartBudgetMs());
			}),
		]);
	} catch {
		// A dashboard failure never fails the launch or the wait.
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
