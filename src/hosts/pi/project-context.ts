// agent-workflow 2026-11-04: a Pi session started in ~ would record runs in ~/.agent-workflow, the
// user-level home (src/hosts/project-root.ts runProject). Every handler the extension registers gets
// a context whose `cwd` is the run project; everything else is the session's own context. Pi builds
// contexts as plain objects with lazy guarded getters (core/extensions/runner.js createContext; its
// command context copies the descriptors the same way), so the derived object keeps them lazy.
import { runProject } from "../project-root.js";
import type {
	PiCommandOptions,
	PiExtensionApi,
	PiExtensionContext,
	PiToolDefinition,
} from "./pi-types.js";

export function projectContext(
	ctx: PiExtensionContext,
	env: NodeJS.ProcessEnv,
): PiExtensionContext {
	if (!ctx || typeof ctx.cwd !== "string") return ctx;
	const project = runProject(ctx.cwd, env);
	if (project === ctx.cwd) return ctx;
	return Object.create(ctx, {
		cwd: { value: project, enumerable: true },
	}) as PiExtensionContext;
}

/** `pi` with every registered handler given projectContext(ctx). */
export function withProjectContext(
	pi: PiExtensionApi,
	env: NodeJS.ProcessEnv,
): PiExtensionApi {
	const map = (ctx: PiExtensionContext) => projectContext(ctx, env);
	return new Proxy(pi, {
		get(target, property) {
			if (property === "on")
				return (
					event: string,
					handler: (event: unknown, ctx: PiExtensionContext) => unknown,
				) =>
					(target.on as (event: string, handler: unknown) => () => void)(
						event,
						(payload: unknown, ctx: PiExtensionContext) =>
							handler(payload, map(ctx)),
					);
			if (property === "registerCommand")
				return (name: string, options: PiCommandOptions) =>
					target.registerCommand(name, {
						...options,
						handler: (args, ctx) => options.handler(args, map(ctx)),
					});
			if (property === "registerTool")
				return (tool: PiToolDefinition) =>
					target.registerTool({
						...tool,
						execute: (id, params, signal, onUpdate, ctx) =>
							tool.execute(id, params, signal, onUpdate, map(ctx)),
					});
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
