/**
 * unsloth-sync — live model discovery for Unsloth Studio, part of pi-on-the-go.
 *
 * Pi never refreshes static `models.json` provider entries by itself, so a new model
 * loaded in Unsloth Studio (or a new context size) is invisible until you edit
 * `models.json` by hand. This extension replaces that manual step:
 *
 *   GET /v1/models        → id, display_name, quant, loaded,
 *                           context_length / max_context_length / native_context_length
 *   GET /api/models/list  → is_vision (→ input: ["text", "image"])
 *
 * Mapping used (generic discovery extensions do NOT map these field names):
 *   contextWindow = first present of contextPreference (default:
 *                   context_length → native_context_length → max_context_length)
 *   input         = ["text","image"] when is_vision, else ["text"]
 *   reasoning     = cfg.defaultReasoning (false by default: GGUF chat endpoints do not
 *                   expose a thinking block unless the model is a reasoning model)
 *   maxTokens     = cfg.maxTokens (capped to contextWindow)
 *
 * Manual entries already present in `models.json` always win for the same model ID —
 * pi composes models.json overrides above extension-registered models, so this file
 * only adds new models and fills missing metadata.
 *
 * Reachable WITHOUT slash commands (Telegram has no command palette):
 *   - natural language: "aggiornamento unsloth", "aggiorna i modelli unsloth",
 *     "refresh unsloth", "unsloth sync" … intercepted in the `input` event, the sync
 *     runs deterministically and the result is reported back;
 *   - `/unsloth [refresh|list|status]` for TUI use;
 *   - LLM tool `unsloth_sync`.
 *
 * Config (optional): ~/.pi/agent/pi-on-the-go.json — see README.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(AGENT_DIR, "pi-on-the-go.json");
const DEFAULT_CACHE_FILE = path.join(AGENT_DIR, "pi-on-the-go-cache.json");
const DEFAULT_KEY_FILE = path.join(AGENT_DIR, "skills", "unsloth-rag", "api_key.txt");

interface Cfg {
	provider: string;
	baseUrl: string;
	apiKey: string;
	keyFile: string;
	cacheFile: string;
	autoRefreshOnStart: boolean;
	defaultReasoning: boolean;
	maxTokens: number;
	contextPreference: string[];
}

interface StudioModel {
	id: string;
	object?: string;
	owned_by?: string;
	display_name?: string;
	quant?: string;
	loaded?: boolean;
	context_length?: number;
	max_context_length?: number;
	native_context_length?: number;
}

interface Capabilities {
	vision: boolean;
	embedding: boolean;
	lora: boolean;
}

interface Stats {
	total: number;
	withContext: number;
	vision: number;
	loaded: number;
}

interface DiscoveryResult {
	models: ProviderModelConfig[];
	source: "live" | "cache";
	updatedAt?: string;
	stats: Stats;
}

const DEFAULTS: Cfg = {
	provider: "unsloth",
	baseUrl: "http://127.0.0.1:8888/v1",
	apiKey: "",
	keyFile: DEFAULT_KEY_FILE,
	cacheFile: DEFAULT_CACHE_FILE,
	autoRefreshOnStart: true,
	defaultReasoning: false,
	maxTokens: 8192,
	contextPreference: ["context_length", "native_context_length", "max_context_length", "max_position_embeddings"],
};

// Natural-language triggers (Telegram has no slash commands). Matched only on short
// messages so normal conversation is never hijacked.
const EXACT_TRIGGERS = new Set([
	"aggiornamento unsloth",
	"aggiorna unsloth",
	"aggiorna i modelli unsloth",
	"aggiorna modelli unsloth",
	"aggiorna i modelli di unsloth",
	"sincronizza unsloth",
	"unsloth aggiornato",
	"refresh unsloth",
	"unsloth refresh",
	"sync unsloth",
	"unsloth sync",
	"update unsloth models",
	"unsloth model update",
]);

const TRIGGER_WORDS = ["aggiorna", "aggiornamento", "sincronizza", "refresh", "sync", "update"];

function expand(p: string): string {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function readJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function basename(p: string): string {
	return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function loadConfig(): Cfg {
	const cfg: Cfg = { ...DEFAULTS };

	const userCfg = readJson(CONFIG_FILE) || {};
	if (typeof userCfg.provider === "string") cfg.provider = userCfg.provider;

	// models.json provider entry can supply baseUrl/key when no config file exists.
	const modelsJson = readJson(path.join(AGENT_DIR, "models.json"));
	const providerEntry = modelsJson?.providers?.[cfg.provider];
	if (providerEntry?.baseUrl) cfg.baseUrl = providerEntry.baseUrl;
	if (typeof userCfg.baseUrl === "string") cfg.baseUrl = userCfg.baseUrl;
	if (typeof userCfg.apiKey === "string" && userCfg.apiKey) cfg.apiKey = userCfg.apiKey;
	if (typeof userCfg.keyFile === "string") cfg.keyFile = expand(userCfg.keyFile);
	if (typeof userCfg.cacheFile === "string") cfg.cacheFile = expand(userCfg.cacheFile);
	if (typeof userCfg.autoRefreshOnStart === "boolean") cfg.autoRefreshOnStart = userCfg.autoRefreshOnStart;
	if (typeof userCfg.defaultReasoning === "boolean") cfg.defaultReasoning = userCfg.defaultReasoning;
	if (typeof userCfg.maxTokens === "number") cfg.maxTokens = userCfg.maxTokens;
	if (Array.isArray(userCfg.contextPreference)) cfg.contextPreference = userCfg.contextPreference;

	// Env overrides the config file.
	if (process.env.UNSLOTH_BASE_URL) cfg.baseUrl = process.env.UNSLOTH_BASE_URL;
	if (process.env.UNSLOTH_API_KEY) cfg.apiKey = process.env.UNSLOTH_API_KEY;

	if (!cfg.apiKey) {
		// key file → models.json apiKey → literal "none" (some Studio builds accept it).
		try {
			cfg.apiKey = fs.readFileSync(cfg.keyFile, "utf8").trim();
		} catch {
			cfg.apiKey = providerEntry?.apiKey || "none";
		}
	}
	return cfg;
}

function normalizeModelKey(id: string): string {
	const withoutQuant = id.includes(":") ? id.slice(0, id.lastIndexOf(":")) : id;
	return withoutQuant.toLowerCase().trim();
}

async function fetchJson(url: string, apiKey: string, signal?: AbortSignal): Promise<any> {
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: signal ?? AbortSignal.timeout(10000),
	});
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
	return res.json();
}

function buildCapabilitiesMap(list: any[]): Map<string, Capabilities> {
	const map = new Map<string, Capabilities>();
	for (const m of list) {
		if (!m || typeof m.id !== "string") continue;
		const caps: Capabilities = { vision: !!m.is_vision, embedding: !!m.is_embedding, lora: !!m.is_lora };
		map.set(m.id.toLowerCase().trim(), caps);
		if (m.name) map.set(String(m.name).toLowerCase().trim(), caps);
	}
	return map;
}

function lookupCaps(map: Map<string, Capabilities>, id: string): Capabilities | undefined {
	const candidates = [
		normalizeModelKey(id),
		basename(normalizeModelKey(id)).toLowerCase().trim(),
		basename(id).toLowerCase().trim(),
	];
	for (const key of candidates) {
		const hit = map.get(key);
		if (hit) return hit;
	}
	return undefined;
}

function pickContext(m: StudioModel, cfg: Cfg): number | undefined {
	for (const field of cfg.contextPreference) {
		const v = (m as any)[field];
		if (typeof v === "number" && v > 0) return v;
	}
	return undefined;
}

function toModelConfig(m: StudioModel, caps: Capabilities | undefined, cfg: Cfg): ProviderModelConfig {
	const ctx = pickContext(m, cfg);
	const input = caps?.vision ? ["text", "image"] : ["text"];
	return {
		id: m.id,
		name: m.display_name || basename(normalizeModelKey(m.id)) || m.id,
		reasoning: cfg.defaultReasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: ctx ?? 32768,
		maxTokens: Math.min(cfg.maxTokens, ctx ?? cfg.maxTokens),
	};
}

function readCache(cfg: Cfg): DiscoveryResult | null {
	const raw = readJson(cfg.cacheFile);
	if (!raw || !Array.isArray(raw.models)) return null;
	return {
		models: raw.models as ProviderModelConfig[],
		source: "cache",
		updatedAt: raw.updatedAt,
		stats: raw.stats ?? { total: raw.models.length, withContext: 0, vision: 0, loaded: 0 },
	};
}

function writeCache(cfg: Cfg, result: DiscoveryResult): void {
	try {
		fs.writeFileSync(cfg.cacheFile, JSON.stringify(result, null, 2));
	} catch {
		/* non-fatal: cache is only an offline fallback */
	}
}

async function discover(cfg: Cfg, signal?: AbortSignal): Promise<DiscoveryResult> {
	let origin = "http://127.0.0.1:8888";
	let pathName = "/v1";
	try {
		const url = new URL(cfg.baseUrl);
		origin = url.origin;
		pathName = url.pathname.replace(/\/+$/, "") || "/v1";
	} catch {
		/* invalid baseUrl — keep the local Studio defaults */
	}
	const modelsUrl = `${origin}${pathName.startsWith("/v1") ? pathName : "/v1"}/models`;

	const catalog = await fetchJson(modelsUrl, cfg.apiKey, signal);
	let list: any = null;
	try {
		list = await fetchJson(`${origin}/api/models/list`, cfg.apiKey, signal);
	} catch {
		/* vision metadata is best-effort */
	}

	const all: StudioModel[] = Array.isArray(catalog?.data) ? catalog.data : [];
	const caps = buildCapabilitiesMap(Array.isArray(list?.models) ? list.models : []);

	// GGUF shard rows ("...-00001-of-00002") and LoRA adapters are not chat models.
	const raw = all.filter((m) => {
		if (/[-_]\d{4,6}-of-\d{4,6}$/i.test(m.id)) return false;
		return !lookupCaps(caps, m.id)?.lora;
	});
	const models = raw.map((m) => toModelConfig(m, lookupCaps(caps, m.id), cfg));

	const stats: Stats = {
		total: models.length,
		withContext: raw.filter((m) => pickContext(m, cfg) !== undefined).length,
		vision: models.filter((m) => m.input.includes("image")).length,
		loaded: raw.filter((m) => m.loaded).length,
	};

	const result: DiscoveryResult = { models, source: "live", updatedAt: new Date().toISOString(), stats };
	writeCache(cfg, result);
	return result;
}

function formatReport(cfg: Cfg, result: DiscoveryResult, limit = 12): string {
	const lines: string[] = [];
	lines.push(
		`${cfg.provider} (${result.source}${result.updatedAt ? ` @ ${result.updatedAt}` : ""}) — ` +
			`${result.stats.total} modelli, ${result.stats.withContext} con contesto rilevato, ` +
			`${result.stats.vision} vision, ${result.stats.loaded} caricati.`,
	);
	const ranked = [...result.models].sort((a, b) => b.contextWindow - a.contextWindow).slice(0, limit);
	for (const m of ranked) {
		lines.push(`- ${m.name || m.id} — ctx ${m.contextWindow}${m.input.includes("image") ? " +vision" : ""}`);
	}
	if (result.models.length > limit) lines.push(`… altri ${result.models.length - limit} modelli`);
	return lines.join("\n");
}

// Last discovery result kept for the command/tool/trigger reporting path.
let last: DiscoveryResult | null = null;
let busy = false;

async function runSync(cfg: Cfg): Promise<DiscoveryResult> {
	if (busy) return last ?? readCache(cfg) ?? { models: [], source: "cache", stats: { total: 0, withContext: 0, vision: 0, loaded: 0 } };
	busy = true;
	try {
		const result = await discover(cfg);
		last = result;
		return result;
	} catch (err) {
		const cached = readCache(cfg);
		if (cached) {
			last = cached;
			return cached;
		}
		throw err;
	} finally {
		busy = false;
	}
}

function isTrigger(text: string): boolean {
	const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
	if (!t || t.startsWith("/") || t.length > 80) return false;
	if (EXACT_TRIGGERS.has(t)) return true;
	return t.includes("unsloth") && TRIGGER_WORDS.some((w) => t.includes(w));
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();

	// Live catalog from the running Studio server; cache used when offline.
	pi.registerProvider(cfg.provider, {
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		api: "openai-completions",
		models: readCache(cfg)?.models ?? [],
		async refreshModels(context: { allowNetwork?: boolean; signal?: AbortSignal }) {
			if (!context?.allowNetwork) return readCache(cfg)?.models ?? [];
			try {
				const result = await discover(cfg, context?.signal);
				last = result;
				return result.models;
			} catch (err) {
				console.error("[unsloth-sync] refreshModels:", err instanceof Error ? err.message : String(err));
				return readCache(cfg)?.models ?? [];
			}
		},
	});

	if (cfg.autoRefreshOnStart) {
		pi.on("session_start", (_event, ctx) => {
			void (async () => {
				try {
					await ctx.modelRegistry.refresh({ allowNetwork: true, force: true });
				} catch {
					/* non-fatal */
				}
			})();
		});
	}

	// Natural-language trigger path (Telegram). The sync itself runs here, without an
	// LLM round-trip; the prompt is rewritten so the agent just reports the result.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || busy || !isTrigger(event.text)) return { action: "continue" };
		let report: string;
		try {
			const result = await runSync(cfg);
			report = formatReport(cfg, result);
		} catch (err) {
			report = `Unsloth sync fallito (${cfg.baseUrl}): ${err instanceof Error ? err.message : String(err)}`;
		}
		void ctx;
		return {
			action: "transform",
			text: `[unsloth-sync] Sync eseguito. Rispondi con esattamente questo riassunto e nient'altro:\n${report}`,
		};
	});

	pi.registerCommand("unsloth", {
		description: "Unsloth Studio model sync (refresh | list | status)",
		handler: async (args, ctx) => {
			const mode = (args || "").trim().toLowerCase();
			let result: DiscoveryResult;
			try {
				result = mode === "status" && last ? last : readCache(cfg) ?? (await runSync(cfg));
			} catch (err) {
				ctx.ui.notify(`unsloth sync fallito: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			ctx.ui.notify(formatReport(cfg, result, mode === "list" ? 40 : 12), "info");
		},
	});

	pi.registerTool({
		name: "unsloth_sync",
		label: "Unsloth Sync",
		description:
			"Discover Unsloth Studio models live (/v1/models + /api/models/list) and map context_length/native_context_length/is_vision to pi model settings. Use when the user asks to refresh/update/sync Unsloth models (e.g. 'aggiornamento unsloth'). After calling it, just report the returned summary.",
		promptSnippet:
			"Live Unsloth Studio model discovery (context window + vision) — use for 'aggiornamento unsloth' / 'refresh unsloth'",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("refresh"), Type.Literal("status")], {
				description: "refresh = query the live server; status = last known result (cache)",
			}),
		}),
		async execute(_toolCallId, params) {
			const result = params.action === "status" && last ? last : readCache(cfg) ?? (await runSync(cfg));
			return { content: [{ type: "text", text: formatReport(cfg, result, 20) }], details: {} };
		},
	});
}
