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
 *                   context_length → native_context_length → max_context_length),
 *                   then cfg.contextOverrides[matchKey]; NO fabricated fallback — a
 *                   model with no real context info is skipped, never shown as 32768.
 *   input         = ["text","image"] when is_vision, else ["text"]
 *   reasoning     = cfg.defaultReasoning (false by default: GGUF chat endpoints do not
 *                   expose a thinking block unless the model is a reasoning model)
 *   maxTokens     = cfg.maxTokens (capped to contextWindow)
 *
 * Every live row is registered in a DEDICATED provider section (`liveProvider`, default
 * `unsloth_live`) so a model loaded in Studio with custom parameters is selectable next to
 * its manual `models.json` entry, distinguished by section rather than by name. The clone
 * keeps the real server id as `id` — pi sends `model: model.id`, so suffixing the ID would
 * break requests; ids can be identical across the two sections while the provider differs,
 * which is what makes them distinguishable in /model.
 *
 * The manual section contains only the entries declared in `models.json` for this provider
 * (own block + entries that resolve to it via "provider"); a model with no manual entry shows
 * up only in the live section. Duplicate live rows ("X" vs "X/file") collapse to one entry.
 * The extension never writes `models.json`: everything lives in the runtime registry (session).
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
	contextOverrides: Record<string, number>;
	liveProvider: string;
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
	skipped: number;
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
	contextOverrides: {},
	liveProvider: "unsloth_live",
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

// Key used to match live rows against models.json manual entries (pi merges by exact
// id, so "X", "X/Y" and "X:quant" must collapse to the same key for dedup).
function matchKey(id: string): string {
	return basename(normalizeModelKey(id)).toLowerCase().trim();
}

// Key used to collapse duplicate live rows of the same model ("X" vs "X/file") and to
// look up contextOverrides. Manual entries are NOT skipped anymore: a live row is always
// registered as a `_live` clone so custom Studio values stay selectable in the session.
function dedupe(models: ProviderModelConfig[]): ProviderModelConfig[] {
	const seen = new Map<string, ProviderModelConfig>();
	for (const m of models) {
		const k = matchKey(m.id);
		if (!seen.has(k)) seen.set(k, m);
	}
	return [...seen.values()];
}

// Manual entries from models.json for this provider (own block OR entries in other blocks
// that resolve to it via "provider"). pi's applyExtension replaces the whole provider list
// with what the extension returns, so these must be re-included or they disappear.
function manualModels(cfg: Cfg): ProviderModelConfig[] {
	const modelsJson = readJson(path.join(AGENT_DIR, "models.json"));
	const providers = (modelsJson?.providers ?? {}) as Record<string, unknown>;
	const out: ProviderModelConfig[] = [];
	for (const [pname, block] of Object.entries(providers)) {
		if (!block || typeof block !== "object") continue;
		const list = (block as { models?: unknown }).models;
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			if (!raw || typeof raw !== "object") continue;
			const entry = raw as ProviderModelConfig & { provider?: string };
			if (typeof entry.id !== "string") continue;
			if (pname === cfg.provider || entry.provider === cfg.provider) {
				out.push({
					...entry,
					provider: cfg.provider,
					input: entry.input ?? ["text"],
					cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				});
			}
		}
	}
	return out;
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
	if (typeof userCfg.liveProvider === "string") cfg.liveProvider = userCfg.liveProvider;
	if (userCfg.contextOverrides && typeof userCfg.contextOverrides === "object") {
		const ov: Record<string, number> = {};
		for (const [k, v] of Object.entries(userCfg.contextOverrides)) {
			if (typeof v === "number" && v > 0) ov[String(k).toLowerCase().trim()] = v;
		}
		cfg.contextOverrides = ov;
	}

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
	return cfg.contextOverrides[matchKey(m.id)];
}

function toModelConfig(m: StudioModel, caps: Capabilities | undefined, cfg: Cfg): ProviderModelConfig | null {
	const ctx = pickContext(m, cfg);
	if (!ctx) return null; // no invented context size: skipped, not defaulted
	const input = caps?.vision ? ["text", "image"] : ["text"];
	return {
		id: m.id,
		name: m.display_name || basename(normalizeModelKey(m.id)) || m.id,
		reasoning: cfg.defaultReasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: ctx,
		maxTokens: Math.min(cfg.maxTokens, ctx),
	};
}

function readCache(cfg: Cfg): DiscoveryResult | null {
	const raw = readJson(cfg.cacheFile);
	if (!raw || !Array.isArray(raw.models)) return null;
	return {
		models: raw.models as ProviderModelConfig[],
		source: "cache",
		updatedAt: raw.updatedAt,
		stats: raw.stats ?? { total: raw.models.length, withContext: 0, vision: 0, loaded: 0, skipped: 0 },
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
	const byKey = new Map<string, StudioModel>();
	for (const m of all) {
		if (/[-_]\d{4,6}-of-\d{4,6}$/i.test(m.id)) continue;
		if (lookupCaps(caps, m.id)?.lora) continue;
		const k = matchKey(m.id);
		const prev = byKey.get(k);
		if (!prev || (prev.id.includes("/") && !m.id.includes("/"))) byKey.set(k, m);
	}

	const models: ProviderModelConfig[] = [];
	let skipped = 0;
	for (const m of byKey.values()) {
		const mc = toModelConfig(m, lookupCaps(caps, m.id), cfg);
		if (!mc) {
			skipped++;
			continue;
		}
		models.push(mc);
	}

	const stats: Stats = {
		total: models.length,
		withContext: models.length,
		vision: models.filter((m) => m.input.includes("image")).length,
		loaded: [...byKey.values()].filter((m) => m.loaded).length,
		skipped,
	};

	const result: DiscoveryResult = { models, source: "live", updatedAt: new Date().toISOString(), stats };
	writeCache(cfg, result);
	return result;
}

function formatReport(cfg: Cfg, result: DiscoveryResult, limit = 12): string {
	const lines: string[] = [];
	const models = dedupe(result.models);
	lines.push(
		`sezione "${cfg.liveProvider}" (${result.source}${result.updatedAt ? ` @ ${result.updatedAt}` : ""}) — ` +
			`${models.length} cloni live + ${manualModels(cfg).length} entry manuali in "${cfg.provider}", ` +
			`${result.stats.vision} vision, ` +
			`${result.stats.loaded} caricati, ${result.stats.skipped ?? 0} saltati (nessun ctx: ` +
			`aggiungi contextOverrides o entry in models.json).`,
	);
	const ranked = [...models].sort((a, b) => b.contextWindow - a.contextWindow).slice(0, limit);
	for (const m of ranked) {
		lines.push(`- ${m.name || m.id} — ctx ${m.contextWindow}${m.input.includes("image") ? " +vision" : ""}`);
	}
	if (models.length > limit) lines.push(`… altri ${models.length - limit} modelli`);
	return lines.join("\n");
}

// Last discovery result kept for the command/tool/trigger reporting path.
let last: DiscoveryResult | null = null;
let busy = false;

async function runSync(cfg: Cfg): Promise<DiscoveryResult> {
	if (busy) return last ?? readCache(cfg) ?? { models: [], source: "cache", stats: { total: 0, withContext: 0, vision: 0, loaded: 0, skipped: 0 } };
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

	// Manual section: exactly the entries declared in models.json for this provider.
	pi.registerProvider(cfg.provider, {
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		api: "openai-completions",
		models: manualModels(cfg),
		refreshModels: () => manualModels(cfg),
	});

	// Live section: clones of the rows Studio exposes, with the values the server reports.
	pi.registerProvider(cfg.liveProvider, {
		name: `${cfg.provider} (live)`,
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		api: "openai-completions",
		models: dedupe(readCache(cfg)?.models ?? []),
		async refreshModels(context: { allowNetwork?: boolean; signal?: AbortSignal }) {
			if (!context?.allowNetwork) return dedupe(readCache(cfg)?.models ?? []);
			try {
				const result = await discover(cfg, context?.signal);
				last = result;
				return dedupe(result.models);
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
				// refresh must hit the live server; only status may answer from cache.
			result = mode === "status" && last ? last : await runSync(cfg);
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
			// refresh must hit the live server; only status may answer from cache.
			const result = params.action === "status" && last ? last : await runSync(cfg);
			return { content: [{ type: "text", text: formatReport(cfg, result, 20) }], details: {} };
		},
	});
}
