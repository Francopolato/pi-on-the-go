/**
 * tg-session-ctl — session control callable from Telegram (or TUI).
 *
 * Registers:
 * - /new-chat       → new empty session PRESERVING the active model + thinking level
 *                    of the previous chat (pi's newSession() otherwise resets to the
 *                    process launch-time --model). Primary source: ctx.model (live);
 *                    fallback: last model_change entry of the current session file.
 * - /reload-runtime → ctx.reload() preserving model + thinking level: state is saved to a
 *                    transient file before the rebuild, then re-applied on the
 *                    session_start(reason=reload) event (the rebuild otherwise resets
 *                    both to the process launch-time values).
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COMMANDS = {
	new: "/new-chat",
	reload: "/reload-runtime",
	"apply-models": "/apply-models",
} as const;

// Stato transitorio per preservare modello + thinking level attraverso il /reload-runtime:
// il rebuild del runtime riporta i valori a quelli di avvio (--model del bat), quindi
// salviamo lo stato prima del reload e lo riapplichiamo in session_start(reason=reload).
const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "tg-session-ctl-state.json");

function writeState(ctx: any): void {
	try {
		const m = ctx.model;
		fs.writeFileSync(
			STATE_FILE,
			JSON.stringify({
				pid: process.pid,
				provider: m?.provider,
				modelId: m?.id,
				thinking: ctx.thinkingLevel ?? null,
			}),
		);
	} catch (e) {
		console.error("[tg-session-ctl] scrittura stato fallita:", e);
	}
}

export default function (pi: ExtensionAPI) {
	// Dopo /reload-runtime il runtime viene ricostruito e riporta modello/thinking ai
	// valori di avvio: qui riapplichiamo quelli salvati da writeState() prima del reload.
	pi.on("session_start", (event, ctx) => {
		// reason=new: rete di sicurezza per /new-chat (se withSession() non bastasse);
		// reason=reload: riapplicazione dopo il rebuild del runtime.
		if (event.reason !== "reload" && event.reason !== "new") return;
		try {
			const raw = fs.readFileSync(STATE_FILE, "utf8");
			fs.unlinkSync(STATE_FILE);
			const st = JSON.parse(raw) as { pid?: number; provider?: string; modelId?: string; thinking?: string | null };
			if (!st || st.pid !== process.pid || !st.provider || !st.modelId) return;
			const m = ctx.modelRegistry.getModel(st.provider, st.modelId);
			if (m && ctx.model?.id !== st.modelId) {
				ctx.setModel(m).catch((e: unknown) => console.error("[tg-session-ctl] setModel post-reload fallito:", e));
			}
			if (st.thinking && ctx.thinkingLevel !== st.thinking) {
				ctx.setThinkingLevel(st.thinking as Parameters<typeof ctx.setThinkingLevel>[0]);
			}
		} catch {
			/* nessun stato salvato: nient'altro da fare */
		}
	});

	pi.registerCommand("new-chat", {
		description: "Start a new empty session (preserva modello e thinking level della chat precedente)",
		handler: async (_args, ctx) => {
			// 1) Stato da preservare (modello attivo + thinking level della chat corrente).
			const prevModel = (ctx as any).model; // Model<any> | undefined (getter live)
			const prevThinking = (ctx as any).thinkingLevel as string | undefined;

			// Fallback: ultimo model_change nel file di sessione corrente.
			let fb: { provider: string; modelId: string } | undefined;
			try {
				const entries = (ctx.sessionManager as any).getEntries() as Array<{
					type?: string;
					provider?: string;
					modelId?: string;
				}>;
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "model_change" && e.provider && e.modelId) {
						fb = { provider: e.provider, modelId: e.modelId };
						break;
					}
				}
			} catch {
				/* non fatale: solo fallback */
			}

			// 2) Marker forense sulla vecchia sessione (entry custom, NON inviata al LLM).
			try {
				ctx.appendEntry("tg-session-ctl-preserve", {
					model: prevModel ? `${prevModel.provider}/${prevModel.id}` : undefined,
					fallback: fb ? `${fb.provider}/${fb.modelId}` : undefined,
					thinking: prevThinking ?? null,
				});
			} catch {
				/* non fatale */
			}

			// 3) Nuova sessione; withSession() è legato alla NUOVA sessione → lì riapplico
			//    modello e thinking level (pi's newSession resetta al --model di avvio).
			//    writeState = rete di sicurezza: se withSession non bastasse, l'evento
			//    session_start(reason=new) riapplica lo stesso stato salvato qui.
			writeState(ctx);
			await ctx.newSession({
				withSession: async (nctx: any) => {
					try {
						if (prevModel) {
							const ok = await nctx.setModel(prevModel);
							if (!ok) console.error("[tg-session-ctl] setModel(prevModel) ha restituito false");
					} else if (fb) {
							const m = nctx.modelRegistry?.getModel?.(fb.provider, fb.modelId);
							if (m) {
								await nctx.setModel(m);
						} else {
							console.error(`[tg-session-ctl] fallback model non in registry: ${fb.provider}/${fb.modelId}`);
						}
					}
					if (prevThinking) nctx.setThinkingLevel(prevThinking);
				} catch (e) {
					console.error("[tg-session-ctl] preserve model/thinking fallita:", e);
				}
			},
		});
			return;
		},
	});

	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files (preserva modello e thinking level)",
		handler: async (_args, ctx) => {
			writeState(ctx);
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
