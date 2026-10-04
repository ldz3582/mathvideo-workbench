/**
 * BYOK 模型配置。
 *
 * 工作台自己维护一份 Pi agent 目录（web/.agent），里面的 models.json / settings.json
 * 由本模块生成。API Key 只写在本机这个目录里（权限 600），既不上传，也不回显给浏览器。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const API_TYPES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const KEYLESS_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"]);

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

function trimSlash(url) {
	return String(url || "").trim().replace(/\/+$/, "");
}

function clampInt(value, min, max, fallback) {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export function maskKey(key) {
	const text = String(key || "");
	if (!text) return "";
	if (text.length <= 8) return "•".repeat(text.length);
	return `${text.slice(0, 4)}${"•".repeat(Math.min(12, text.length - 8))}${text.slice(-4)}`;
}

/** 根据模型名猜一套合理默认值，用户可以在高级选项里改。 */
export function guessMeta(modelId) {
	const id = String(modelId || "").toLowerCase();
	const reasoning = /(^|\/)(o[1-9]|o4-mini)|gpt-5|thinking|reasoner|qwq|glm-z1|r1|k2-thinking|grok-[3-9]/.test(id);
	const images = /gpt-4o|gpt-4\.1|gpt-5|claude|gemini|qwen-?vl|grok-[2-9]|glm-4v|kimi.*(vision|vl)|pixtral|llava/.test(id);
	let contextWindow = DEFAULT_CONTEXT;
	if (/claude|gemini|gpt-4\.1|gpt-5|o[1-9]/.test(id)) contextWindow = 200_000;
	if (/kimi|moonshot/.test(id)) contextWindow = 256_000;
	if (/glm-4\.6|deepseek-v3|qwen-max|qwen3/.test(id)) contextWindow = 128_000;
	let maxTokens = DEFAULT_MAX_TOKENS;
	if (/claude/.test(id)) maxTokens = 32_000;
	if (/gpt-5|o[1-9]/.test(id)) maxTokens = 32_000;
	return { reasoning, images, contextWindow, maxTokens };
}

export function createModelStore(agentDir) {
	const uiFile = path.join(agentDir, "byok.json");
	const modelsFile = path.join(agentDir, "models.json");
	const settingsFile = path.join(agentDir, "settings.json");

	function readJson(file) {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			return null;
		}
	}

	function activeProvider() {
		const models = readJson(modelsFile);
		const ui = readJson(uiFile);
		if (!models?.providers) return null;
		const name = ui?.provider && models.providers[ui.provider] ? ui.provider : Object.keys(models.providers)[0];
		if (!name) return null;
		return { name, config: models.providers[name] };
	}

	/** 给前端看的状态：有 Key 但只给掩码。 */
	function status() {
		const ui = readJson(uiFile);
		const active = activeProvider();
		const apiKey = active?.config?.apiKey || "";
		if (!ui && !active) return { configured: false, presets: API_TYPES };
		const model = active?.config?.models?.find((m) => m.id === ui?.modelId) || active?.config?.models?.[0] || {};
		return {
			configured: Boolean(active && ui?.modelId),
			provider: active?.name || ui?.provider || "byok",
			api: active?.config?.api || ui?.api || "openai-completions",
			baseUrl: active?.config?.baseUrl || ui?.baseUrl || "",
			modelId: ui?.modelId || model.id || "",
			modelName: model.name || model.id || "",
			thinking: ui?.thinking || "medium",
			contextWindow: model.contextWindow ?? ui?.contextWindow ?? DEFAULT_CONTEXT,
			maxTokens: model.maxTokens ?? ui?.maxTokens ?? DEFAULT_MAX_TOKENS,
			images: Array.isArray(model.input) ? model.input.includes("image") : Boolean(ui?.images),
			reasoning: Boolean(model.reasoning ?? ui?.reasoning),
			hasKey: Boolean(apiKey),
			keyMask: maskKey(apiKey),
			keylessOk: true,
			updatedAt: ui?.updatedAt || null,
			setupHint: ui?.setupHint || null,
		};
	}

	function validate(input, { storedKey = "" } = {}) {
		const provider = String(input.provider || "byok").trim() || "byok";
		if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(provider)) throw new Error("服务商标识只能包含字母、数字和 . _ -");

		const api = String(input.api || "openai-completions").trim();
		if (!API_TYPES.includes(api)) throw new Error(`不支持的接口类型：${api}`);

		const baseUrl = trimSlash(input.baseUrl);
		let parsed;
		try {
			parsed = new URL(baseUrl);
		} catch {
			throw new Error("API 地址要写成完整网址，例如 https://api.deepseek.com/v1");
		}
		if (!/^https?:$/.test(parsed.protocol)) throw new Error("API 地址必须以 http:// 或 https:// 开头");

		const modelId = String(input.modelId || "").trim();
		if (!modelId) throw new Error("请填写模型 ID（可以点「拉取模型列表」挑一个）");

		const typedKey = input.apiKey === undefined || input.apiKey === null ? "" : String(input.apiKey).trim();
		const apiKey = typedKey || storedKey;
		const keyless = KEYLESS_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".local");
		if (!apiKey && !keyless) throw new Error("请填写 API Key（地址是本机时才可以留空）");

		const thinking = THINKING_LEVELS.includes(input.thinking) ? input.thinking : "medium";
		const guess = guessMeta(modelId);
		const images = input.images === undefined ? guess.images : Boolean(input.images);
		const reasoning = input.reasoning === undefined ? guess.reasoning : Boolean(input.reasoning);
		const contextWindow = clampInt(input.contextWindow ?? guess.contextWindow, 1_000, 10_000_000, guess.contextWindow);
		const maxTokens = clampInt(input.maxTokens ?? guess.maxTokens, 128, 200_000, guess.maxTokens);
		const displayName = String(input.displayName || "").trim() || modelId;

		return { provider, api, baseUrl, modelId, apiKey, thinking, images, reasoning, contextWindow, maxTokens, displayName };
	}

	async function write(config) {
		await fsp.mkdir(agentDir, { recursive: true, mode: 0o700 });

		const model = {
			id: config.modelId,
			name: config.displayName,
			input: config.images ? ["text", "image"] : ["text"],
			contextWindow: config.contextWindow,
			maxTokens: config.maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		if (config.reasoning) model.reasoning = true;

		const provider = { baseUrl: config.baseUrl, api: config.api, models: [model] };
		if (config.apiKey) provider.apiKey = config.apiKey;

		const modelsJson = { providers: { [config.provider]: provider } };
		const settingsJson = {
			defaultModel: `${config.provider}/${config.modelId}`,
			defaultThinkingLevel: config.thinking === "off" ? "medium" : config.thinking,
		};
		const uiJson = {
			provider: config.provider,
			api: config.api,
			baseUrl: config.baseUrl,
			modelId: config.modelId,
			displayName: config.displayName,
			thinking: config.thinking,
			contextWindow: config.contextWindow,
			maxTokens: config.maxTokens,
			images: config.images,
			reasoning: config.reasoning,
			updatedAt: new Date().toISOString(),
		};

		await fsp.writeFile(modelsFile, `${JSON.stringify(modelsJson, null, 2)}\n`, { mode: 0o600 });
		await fsp.writeFile(settingsFile, `${JSON.stringify(settingsJson, null, 2)}\n`, { mode: 0o600 });
		await fsp.writeFile(uiFile, `${JSON.stringify(uiJson, null, 2)}\n`, { mode: 0o600 });
		return uiJson;
	}

	async function save(input) {
		const stored = activeProvider()?.config?.apiKey || "";
		const config = validate(input, { storedKey: stored });
		await write(config);
		return status();
	}

	async function clear() {
		for (const file of [uiFile, modelsFile, settingsFile]) {
			await fsp.rm(file, { force: true });
		}
		return status();
	}

	/** 把本机 ~/.pi 里已经在用的 provider 原样搬进来（本机代理 / 已登录的 Key 都能复用）。 */
	async function importFromGlobal(globalDir = path.join(os.homedir(), ".pi", "agent")) {
		const globalModels = readJson(path.join(globalDir, "models.json"));
		const globalSettings = readJson(path.join(globalDir, "settings.json"));
		if (!globalModels?.providers || !Object.keys(globalModels.providers).length) {
			throw new Error(`本机没有可导入的配置（${globalDir}/models.json）`);
		}
		const wanted = String(globalSettings?.defaultModel || "").split("/")[0];
		const name = wanted && globalModels.providers[wanted] ? wanted : Object.keys(globalModels.providers)[0];
		const provider = globalModels.providers[name];
		const firstModel = provider.models?.[0];
		if (!firstModel?.id) throw new Error("本机配置里没有可用的模型");

		await fsp.mkdir(agentDir, { recursive: true, mode: 0o700 });
		await fsp.writeFile(modelsFile, `${JSON.stringify({ providers: { [name]: provider } }, null, 2)}\n`, { mode: 0o600 });

		const uiJson = {
			provider: name,
			api: provider.api || "openai-completions",
			baseUrl: provider.baseUrl || "",
			modelId: firstModel.id,
			displayName: firstModel.name || firstModel.id,
			thinking: ["off", ...THINKING_LEVELS].includes(globalSettings?.defaultThinkingLevel) ? globalSettings.defaultThinkingLevel : "medium",
			contextWindow: firstModel.contextWindow ?? DEFAULT_CONTEXT,
			maxTokens: firstModel.maxTokens ?? DEFAULT_MAX_TOKENS,
			images: Array.isArray(firstModel.input) ? firstModel.input.includes("image") : false,
			reasoning: Boolean(firstModel.reasoning),
			updatedAt: new Date().toISOString(),
			setupHint: `已从 ${globalDir} 导入 ${name}`,
		};
		await fsp.writeFile(uiFile, `${JSON.stringify(uiJson, null, 2)}\n`, { mode: 0o600 });
		await fsp.writeFile(
			settingsFile,
			`${JSON.stringify({ defaultModel: `${name}/${firstModel.id}`, defaultThinkingLevel: uiJson.thinking }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		return status();
	}

	return {
		status,
		save,
		clear,
		importFromGlobal,
		validate,
		storedKey: () => activeProvider()?.config?.apiKey || "",
		paths: { agentDir, uiFile, modelsFile, settingsFile },
	};
}

/** 拉取可用模型列表：按接口类型拼不同的 URL 和鉴权头。 */
export async function discoverModels({ api, baseUrl, apiKey }, { timeoutMs = 20_000 } = {}) {
	const base = trimSlash(baseUrl);
	const key = String(apiKey || "").trim();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let url;
		let headers = {};
		if (api === "anthropic-messages") {
			url = `${base}/v1/models`;
			headers = key ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { "anthropic-version": "2023-06-01" };
		} else if (api === "google-generative-ai") {
			url = `${base}/v1beta/models${key ? `?key=${encodeURIComponent(key)}` : ""}`;
		} else {
			url = base.endsWith("/v1") || /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
			headers = key ? { authorization: `Bearer ${key}` } : {};
		}

		let response = await fetch(url, { headers, signal: controller.signal });
		if (response.status === 404 && !/\/v\d+\/models$/.test(url)) {
			response = await fetch(`${base}/v1/models`, { headers, signal: controller.signal });
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const hint = response.status === 401 || response.status === 403 ? "Key 可能不对或没有权限" : body.slice(0, 200).trim();
			throw new Error(`接口返回 ${response.status}${hint ? `：${hint}` : ""}`);
		}
		const data = await response.json();
		const raw = Array.isArray(data) ? data : data.data || data.models || [];
		const models = raw
			.map((item) => {
				const id = typeof item === "string" ? item : item.id || String(item.name || "").replace(/^models\//, "");
				return { id, contextWindow: item.context_length || item.context_window || item.inputTokenLimit || null };
			})
			.filter((m) => m.id);
		if (!models.length) throw new Error("接口通了，但没返回模型列表，手动填模型 ID 即可");
		models.sort((a, b) => a.id.localeCompare(b.id));
		return { ok: true, models };
	} catch (err) {
		if (err.name === "AbortError") return { ok: false, error: "请求超时，检查地址或网络" };
		return { ok: false, error: err.message };
	} finally {
		clearTimeout(timer);
	}
}
