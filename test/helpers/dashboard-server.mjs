// Real HTTP server with an explicit registry entry, including fixture-only projects.
import { registerProject, projectId } from "../../dist/core/state-location.js";
import { startDashboardServer as start } from "../../dist/hosts/dashboard/server.js";
export async function startDashboardServer(options) {
	await registerProject(options.cwd);
	return { ...(await start(options)), projectId: projectId(options.cwd) };
}
export function projectApi(server, path) {
	if (path.startsWith("/api/runs"))
		return `/api/projects/${server.projectId}/${path.slice(5)}`;
	if (path.startsWith("/api/events"))
		return path
			.replace(
				"/api/events",
				`/api/events?project=${server.projectId}${path.includes("?") ? "&" : ""}`,
			)
			.replace("&?", "&");
	return path;
}
