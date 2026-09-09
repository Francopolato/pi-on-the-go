/**
 * tg-session-ctl — session control callable from Telegram (or TUI).
 *
 * Registers:
 * - /new-chat       → ctx.newSession()            (start a brand-new empty session)
 * - /reload-runtime → ctx.reload()                (same flow as built-in /reload)
 * - /apply-models   → ctx.modelRegistry.refresh() (re-read models.json, e.g. after editing contextWindow)
 *
 * Plus an LLM-callable tool `session_ctl`. Its execute() dispatches the matching
 * command IMMEDIATELY via pi.sendUserMessage(cmd, { expandPromptTemplates: true }):
 * with expandPromptTemplates=true, session.prompt() routes any "/command" text
 * through _tryExecuteExtensionCommand() (full command context) even while the
 * agent is streaming — so no follow-up queueing and no LLM round-trip are needed.
 *
 * IMPORTANT for the model: after calling session_ctl do NOT call any other tools;
 * finish the turn with a plain text reply (the runtime may be replaced mid-turn).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const COMMANDS = {
	new: "/new-chat",
	reload: "/reload-runtime",
	"apply-models": "/apply-models",
} as const;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("new-chat", {
		description: "Start a new empty session",
		handler: async (_args, ctx) => {
			await ctx.newSession();
			return;
		},
	});

	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	pi.registerCommand("apply-models", {
		description: "Re-read models.json (apply contextWindow/model changes without restarting pi)",
		handler: async (_args, ctx) => {
			const result = await ctx.modelRegistry.refresh({ allowNetwork: false });
			let errors: string[] = [];
			try {
				if (result?.errors instanceof Map) {
					errors = [...result.errors.entries()].map(([p, e]) => `${p}: ${e instanceof Error ? e.message : String(e)}`);
				}
			} catch {
				// non-fatal: reporting only
			}
			if (errors.length > 0) {
				ctx.ui.notify(`models.json reloaded with errors: ${errors.join("; ")}`, "warning");
			} else {
				ctx.ui.notify("models.json reloaded", "info");
			}
			return;
		},
	});

	pi.registerTool({
		name: "session_ctl",
		label: "Session Control",
		description:
			"Execute a session-control command immediately (works mid-turn). Actions: new = start a brand-new empty session (nuova chat); reload = same as /reload (reloads extensions, skills, prompts, themes, context files); apply-models = re-read models.json so contextWindow/model edits take effect without restarting pi. Use when the user asks to start a new chat/session, reload pi, or apply model-config changes. After calling this tool do NOT call any other tools in the same turn — finish with a plain text reply.",
		promptSnippet:
			"Execute session-control commands immediately (new empty chat, reload, re-read models.json) — use for 'nuova chat/nuova sessione', 'reload', or context-window/model config changes",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("new"), Type.Literal("reload"), Type.Literal("apply-models")], {
				description: "Which session-control command to execute",
			}),
		}),
		async execute(_toolCallId, params) {
			const cmd = COMMANDS[params.action];
			// expandPromptTemplates=true makes session.prompt() dispatch the text as a
			// real extension command (full command ctx) instead of sending it to the LLM.
			await pi.sendUserMessage(cmd, { expandPromptTemplates: true } as Parameters<typeof pi.sendUserMessage>[1]);
			return {
				content: [{ type: "text", text: `${cmd} executed.` }],
				details: {},
			};
		},
	});
}
