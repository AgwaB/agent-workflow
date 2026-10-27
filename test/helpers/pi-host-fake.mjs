// New in agent-workflow (WP16): a fake Pi ExtensionAPI / ExtensionContext for the Pi host tests that
// need the WP16 surfaces: `pi.sendMessage` (recorded), `ctx.ui.setStatus` (recorded, with the
// current footer state) and `ctx.sessionManager.getSessionId()`.

/** Fake ExtensionAPI: commands, tools, event handlers and sent custom messages. */
export function fakePi() {
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	const messages = [];
	return {
		commands,
		tools,
		handlers,
		messages,
		sendFailures: 0,
		registerCommand(name, options) {
			if (commands.has(name)) throw new Error(`duplicate command ${name}`);
			commands.set(name, options);
		},
		registerTool(tool) {
			if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
			tools.set(tool.name, tool);
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		getThinkingLevel: () => "medium",
		sendMessage(message, options) {
			if (this.sendFailures > 0) {
				this.sendFailures -= 1;
				throw new Error("sendMessage failed (test)");
			}
			messages.push({ message, options });
		},
	};
}

/** Fake ExtensionContext with a dialog UI (rpc) or none (json), a session id and a footer. */
export function fakeCtx(
	cwd,
	{ hasUI = true, sessionId = "session-a", select, mode } = {},
) {
	const notes = [];
	const statuses = [];
	const selects = [];
	const footer = new Map();
	return {
		cwd,
		hasUI,
		mode: mode ?? (hasUI ? "rpc" : "json"),
		model: { provider: "anthropic", id: "claude-test" },
		modelRegistry: { getAvailable: () => [] },
		sessionManager:
			sessionId === undefined ? undefined : { getSessionId: () => sessionId },
		notes,
		statuses,
		selects,
		footer,
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			confirm: async () => true,
			select: async (title, options) => {
				selects.push({ title, options });
				return select ? select(options) : undefined;
			},
			setStatus: (key, text) => {
				statuses.push({ key, text });
				if (text === undefined) footer.delete(key);
				else footer.set(key, text);
			},
		},
	};
}

export async function eventually(check, what, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}
