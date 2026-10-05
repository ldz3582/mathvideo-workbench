#!/usr/bin/env node
/**
 * 数学视频工作台的 Web 服务端。
 *
 * 三层结构：
 *   浏览器  ──SSE──▶  本服务  ──JSONL(stdin/stdout)──▶  pi --mode rpc   （决策层：模型 + 工具 + 技能）
 *                          └────子进程────▶  videoctl.py            （执行层：渲染/配音/拼接）
 *
 * 本文件只做三件事：转发事件、代理文件、把确定性命令做成 HTTP 接口。
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createModelStore, discoverModels } from "./model-config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(HERE, "public");
const SESSION_DIR = path.join(HERE, ".sessions");
// 工作台自己的 Pi agent 目录：模型与 Key 都在这里，不动用户全局的 ~/.pi
const AGENT_DIR = process.env.MATHVIDEO_AGENT_DIR || path.join(HERE, ".agent");
const modelStore = createModelStore(AGENT_DIR);
const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || "127.0.0.1";

// ---------------------------------------------------------------- 配置
function readWorkbenchConfig() {
	try {
		return JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "workbench.json"), "utf8"));
	} catch {
		return {};
	}
}
const WORKBENCH = readWorkbenchConfig();
const SKILL_ROOT = path.resolve(
	process.env.MATHVIDEO_SKILL_ROOT || WORKBENCH.skill_root || path.join(ROOT, "..", "Mathvideo-skill"),
);
const PROJECTS_DIR = path.join(SKILL_ROOT, "projects");
/** 优先用技能仓库自带的虚拟环境，保证 manim / edge-tts 一定在；没有才退回系统 python3。 */
function findPython() {
	const explicit = process.env.MATHVIDEO_PYTHON3 || process.env.MATHVIDEO_PYTHON;
	if (explicit) return explicit;
	const venv = path.join(SKILL_ROOT, ".venv", "bin", "python");
	try {
		fs.accessSync(venv, fs.constants.X_OK);
		return venv;
	} catch {
		return "python3";
	}
}
const PYTHON = findPython();
const VIDEOCTL = path.join(ROOT, "tools", "videoctl.py");

function findPiBinary() {
	const candidates = [
		process.env.PI_BIN,
		path.join(process.env.HOME || "", ".local", "bin", "pi"),
		"/opt/homebrew/bin/pi",
		"/usr/local/bin/pi",
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			/* 继续找 */
		}
	}
	return "pi";
}
const PI_BIN = findPiBinary();

if (!process.env.PATH?.includes("/opt/homebrew/bin")) {
	process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`;
}

function findBinary(name, explicit) {
	if (explicit) return explicit;
	const candidates = [
		path.join("/opt/homebrew/bin", name),
		path.join("/usr/local/bin", name),
		path.join("/usr/bin", name),
		name,
	];
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			/* 继续找 */
		}
	}
	return name;
}
const FFMPEG = findBinary("ffmpeg", process.env.FFMPEG_BIN);
const FFPROBE = findBinary("ffprobe", process.env.FFPROBE_BIN);

// ---------------------------------------------------------------- 事件总线
const sseClients = new Set();

function broadcast(payload) {
	const frame = `data: ${JSON.stringify(payload)}\n\n`;
	for (const client of sseClients) {
		try {
			client.write(frame);
		} catch {
			sseClients.delete(client);
		}
	}
}

// ---------------------------------------------------------------- Pi RPC 客户端
class PiRpc {
	constructor() {
		this.proc = null;
		this.buffer = "";
		this.seq = 0;
		this.pending = new Map();
		this.busy = false;
		this.handshake = null;
		this.lastError = null;
	}

	start() {
		if (this.proc) return;
		fs.mkdirSync(SESSION_DIR, { recursive: true });

		const args = [
			"--mode",
			"rpc",
			"--approve",
			"--session-dir",
			SESSION_DIR,
			// 服务重启后接着上次的会话聊，不让「服务挂了」变成「上下文没了」
			"--continue",
			// 显式加载工作台资源，即使使用者没跑过 `pi install` 也能用
			"--extension",
			path.join(ROOT, "extensions", "video-workbench.ts"),
			"--skill",
			path.join(ROOT, "skills"),
			"--prompt-template",
			path.join(ROOT, "prompts"),
		];

		this.proc = spawn(PI_BIN, args, {
			cwd: ROOT,
			env: {
				...process.env,
				MATHVIDEO_WORKBENCH_ROOT: ROOT,
				MATHVIDEO_SKILL_ROOT: SKILL_ROOT,
				PYTHONUNBUFFERED: "1",
				PI_CODING_AGENT_DIR: AGENT_DIR,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.on("error", (err) => {
			this.lastError = `无法启动 pi：${err.message}`;
			broadcast({ t: "error", v: `无法启动 pi（${PI_BIN}）：${err.message}` });
			this.proc = null;
		});

		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk) => this.onData(chunk));

		this.proc.stderr.setEncoding("utf8");
		this.proc.stderr.on("data", (chunk) => {
			const text = chunk.toString().trim();
			console.error("[pi stderr]", text);
			if (text) broadcast({ t: "log", v: text.slice(0, 600) });
		});

		this.proc.on("close", (code) => {
			console.error("[pi closed] code:", code);
			this.busy = false;
			broadcast({ t: "status", running: false, reason: `pi 进程退出（code ${code}）` });
			this.proc = null;
			for (const [, entry] of this.pending) entry.reject(new Error("pi 进程已退出"));
			this.pending.clear();
		});
	}

	onData(chunk) {
		this.buffer += chunk;
		// 严格按 LF 切分：不能用 readline（它会在 U+2028/U+2029 上误切）
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			let line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) {
				try {
					this.handleRecord(JSON.parse(line));
				} catch {
					/* 非协议行，忽略 */
				}
			}
			index = this.buffer.indexOf("\n");
		}
	}

	handleRecord(record) {
		if (record.type === "response") {
			const entry = this.pending.get(record.id);
			if (entry) {
				this.pending.delete(record.id);
				entry.resolve(record);
			}
			return;
		}
		normalizeEvent(record);
	}

	send(command, { timeoutMs = 120_000 } = {}) {
		this.start();
		if (!this.proc) return Promise.reject(new Error(this.lastError || "pi 未运行"));
		const id = command.id || `c${++this.seq}`;
		const payload = { ...command, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`命令超时：${command.type}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	/** 改完模型配置要重启子进程：Pi 只在启动与 /model 时读 models.json。 */
	async restart(reason = "模型配置已更新") {
		if (this.busy) throw new Error("正在生产中，等这一步跑完再改模型");
		const old = this.proc;
		this.proc = null;
		this.buffer = "";
		for (const [, entry] of this.pending) entry.reject(new Error(reason));
		this.pending.clear();
		if (old) {
			await new Promise((resolve) => {
				const done = () => resolve();
				old.removeAllListeners("close");
				old.once("exit", done);
				try {
					old.kill("SIGTERM");
				} catch {
					done();
				}
				setTimeout(() => {
					try {
						old.kill("SIGKILL");
					} catch {
						/* 已经退出了 */
					}
					done();
				}, 3000).unref();
			});
		}
		this.lastError = null;
		this.start();
	}
}

const pi = new PiRpc();

// ---------------------------------------------------------------- 事件归一化
function contentParts(result) {
	const parts = result?.content ?? [];
	const text = parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
	const images = parts
		.filter((p) => p?.type === "image" && p.data)
		.map((p) => `data:${p.mimeType || "image/png"};base64,${p.data}`);
	return { text, images };
}

const MAX_HISTORY_TEXT = 20_000;

function messageText(content) {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p?.type === "text" && p.text)
		.map((p) => p.text)
		.join("\n")
		.trim();
}

function messageImages(content) {
	if (!Array.isArray(content)) return [];
	return content
		.filter((p) => p?.type === "image" && p.data)
		.map((p) => `data:${p.mimeType || "image/png"};base64,${p.data}`);
}

function truncate(text) {
	return text.length > MAX_HISTORY_TEXT ? `${text.slice(0, MAX_HISTORY_TEXT)}\n…（已截断）` : text;
}

function clip(text, limit = 240) {
	const value = String(text || "").trim();
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 把模型/网络报错翻译成用户能照着做的一句话。 */
function friendlyError(raw) {
	const text = String(raw || "").trim();
	if (!text) return "模型没有返回结果，检查一下模型配置。";
	if (/401|invalid.?api.?key|unauthorized|incorrect api key|authentication/i.test(text)) {
		return "API Key 不对或已失效，去「⚙ 模型」里重新填一次。";
	}
	if (/403|forbidden|permission|not in plan|no access/i.test(text)) return `这个 Key 没有该模型的权限：${clip(text)}`;
	if (/404|not supported|model_not_found|does not exist|unknown model/i.test(text)) return `这个地址上没有该模型：${clip(text)}`;
	if (/429|rate.?limit|quota|insufficient|balance/i.test(text)) return "触发限流或额度不足，稍后再试，或换一个模型。";
	if (/ENOTFOUND|ECONNREFUSED|fetch failed|socket hang up|ETIMEDOUT|network/i.test(text)) {
		return "连不上这个 API 地址，检查地址有没有写错、本机网络是否通。";
	}
	return clip(text);
}

/** 把 Pi 的会话条目折成前端能直接画的一维列表：用户发言 / AI 发言 / 工具卡片。 */
function toHistory(entries) {
	const items = [];
	const pending = new Map();
	for (const entry of entries || []) {
		if (entry?.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = messageText(message.content);
			if (text) items.push({ kind: "user", text: truncate(text) });
			continue;
		}
		if (message.role === "assistant") {
			if (message.stopReason === "error" && message.errorMessage) {
				items.push({ kind: "error", text: friendlyError(message.errorMessage) });
			}
			const parts = Array.isArray(message.content) ? message.content : [];
			for (const part of parts) {
				if (part?.type === "text" && part.text?.trim()) {
					items.push({ kind: "assistant", text: truncate(part.text.trim()) });
				} else if (part?.type === "toolCall") {
					const item = { kind: "tool", id: part.id, name: part.name, args: part.arguments ?? {}, ok: null, text: "" };
					items.push(item);
					pending.set(part.id, item);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const item = pending.get(message.toolCallId);
			if (!item) continue;
			item.ok = !message.isError;
			item.text = truncate(messageText(message.content));
			item.images = messageImages(message.content);
			pending.delete(message.toolCallId);
		}
	}
	return items;
}

let lastErrorText = "";
let lastErrorAt = 0;

/** 同一条错误（message_start 与 turn_end 都会带）只说一次。 */
function broadcastError(message) {
	const now = Date.now();
	if (message === lastErrorText && now - lastErrorAt < 8000) return;
	lastErrorText = message;
	lastErrorAt = now;
	broadcast({ t: "error", v: message });
}

function normalizeEvent(record) {
	switch (record.type) {
		case "agent_start":
			pi.busy = true;
			broadcast({ t: "status", running: true });
			break;
		case "agent_settled":
			pi.busy = false;
			broadcast({ t: "status", running: false });
			broadcast({ t: "projects_stale" });
			break;
		case "message_update": {
			const evt = record.assistantMessageEvent || {};
			if (evt.type === "text_delta") broadcast({ t: "text", v: evt.delta });
			else if (evt.type === "thinking_delta") broadcast({ t: "thinking", v: evt.delta });
			else if (evt.type === "error") broadcast({ t: "error", v: String(evt.error || evt.reason || "模型返回错误") });
			break;
		}
			case "message_start":
				if (record.message?.role === "assistant") {
					// 模型调用失败时 Pi 不发 error 事件，只把原因写在消息里
					if (record.message.stopReason === "error") broadcastError(friendlyError(record.message.errorMessage));
					else broadcast({ t: "assistant_start" });
				}
				break;
			case "turn_end":
				if (record.message?.role === "assistant" && record.message.stopReason === "error") {
					broadcastError(friendlyError(record.message.errorMessage));
				}
				break;
		case "tool_execution_start":
			broadcast({
				t: "tool_start",
				id: record.toolCallId,
				name: record.toolName,
				args: record.args ?? {},
			});
			break;
		case "tool_execution_update": {
			const { text } = contentParts(record.partialResult);
			if (text) broadcast({ t: "tool_progress", id: record.toolCallId, v: text });
			break;
		}
		case "tool_execution_end": {
			const { text, images } = contentParts(record.result);
			broadcast({
				t: "tool_end",
				id: record.toolCallId,
				ok: !record.isError,
				v: text,
				images,
			});
			break;
		}
		case "extension_ui_request": {
			if (record.method === "notify") {
				broadcast({ t: "notice", level: record.notifyType || "info", v: record.message });
			} else if (["select", "confirm", "input", "editor"].includes(record.method)) {
				// 本工作台的工具不弹对话框；收到就立刻取消，避免 Pi 侧阻塞
				pi.proc?.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
			}
			break;
		}
		case "extension_error":
			broadcast({ t: "error", v: `扩展报错（${path.basename(record.extensionPath || "")}）：${record.error}` });
			break;
		case "compaction_start":
			broadcast({ t: "notice", level: "info", v: "上下文过长，正在压缩历史…" });
			break;
		default:
			break;
	}
}

// ---------------------------------------------------------------- 文件与安全
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".mp4": "video/mp4",
	".mp3": "audio/mpeg",
	".webm": "video/webm",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".md": "text/markdown; charset=utf-8",
};

function isInside(root, target) {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 只允许访问 <技能仓库>/projects 与工作台自身目录，防止路径穿越读任意文件。 */
function resolveSafe(candidate) {
	if (!candidate) return null;
	const abs = path.resolve(candidate);
	for (const root of [PROJECTS_DIR, ROOT]) {
		if (isInside(root, abs)) return abs;
	}
	return null;
}

function serveFile(req, res, filePath) {
	let stat;
	try {
		stat = fs.statSync(filePath);
	} catch {
		res.writeHead(404).end("Not found");
		return;
	}
	if (stat.isDirectory()) {
		res.writeHead(403).end("Directory");
		return;
	}
	const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
	// 视频拖动进度条依赖 Range
	const range = req.headers.range;
	if (range) {
		const match = /bytes=(\d*)-(\d*)/.exec(range);
		let start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
		let end = match?.[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
		if (!Number.isFinite(start) || start >= stat.size) {
			res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
			return;
		}
		end = Math.min(end, stat.size - 1);
		res.writeHead(206, {
			"Content-Type": type,
			"Content-Length": end - start + 1,
			"Content-Range": `bytes ${start}-${end}/${stat.size}`,
			"Accept-Ranges": "bytes",
			"Cache-Control": "no-cache",
		});
		fs.createReadStream(filePath, { start, end }).pipe(res);
		return;
	}
	res.writeHead(200, {
		"Content-Type": type,
		"Content-Length": stat.size,
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
		"Pragma": "no-cache",
		"Expires": "0",
	});
	fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------- videoctl
/** 同一个项目同时只允许一个确定性任务：qa 和 build 抢同一个项目会把产物搅乱。 */
const activeTasks = new Map();

function runVideoctl(args, onLine) {
	return new Promise((resolve) => {
		const child = spawn(PYTHON, [VIDEOCTL, ...args], {
			cwd: ROOT,
			env: { ...process.env, MATHVIDEO_WORKBENCH_ROOT: ROOT, MATHVIDEO_SKILL_ROOT: SKILL_ROOT, PYTHONUNBUFFERED: "1" },
		});
		let stdout = "";
		let stderr = "";
		const emitLines = (chunk) => {
			for (const line of chunk.toString().split("\n")) {
				if (line.trim() && onLine) onLine(line.trim());
			}
		};
		child.stdout.on("data", (c) => {
			stdout += c.toString();
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString();
			emitLines(c);
		});
		child.on("error", (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
		child.on("close", (code) => {
			let json = null;
			const start = stdout.indexOf("{");
			if (start >= 0) {
				try {
					json = JSON.parse(stdout.slice(start));
				} catch {
					json = null;
				}
			}
			resolve({ ok: code === 0, code, json, stdout, stderr });
		});
	});
}

// ---------------------------------------------------------------- HTTP
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
	res.end(payload);
}

async function readBody(req, limit = 12 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > limit) reject(new Error("请求体过大"));
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const route = url.pathname;

	try {
		// ---- 静态资源
		if (route === "/" || route === "/index.html") {
			serveFile(req, res, path.join(PUBLIC_DIR, "index.html"));
			return;
		}
		if (route.startsWith("/static/")) {
			const target = resolveWithin(PUBLIC_DIR, route.slice("/static/".length));
			if (!target) return res.writeHead(403).end("Forbidden");
			serveFile(req, res, target);
			return;
		}
		if (route === "/favicon.ico") {
			res.writeHead(204).end();
			return;
		}

		// ---- 事件流
		if (route === "/api/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(`data: ${JSON.stringify({ t: "hello", pid: process.pid })}\n\n`);
			sseClients.add(res);
			const ping = setInterval(() => {
				try {
					res.write(": ping\n\n");
				} catch {
					/* 忽略 */
				}
			}, 25_000);
			req.on("close", () => {
				clearInterval(ping);
				sseClients.delete(res);
			});
			return;
		}

		// ---- 状态
		if (route === "/api/status") {
			let state = null;
			let piReady = true;
			let piError = null;
			try {
				const response = await pi.send({ type: "get_state" }, { timeoutMs: 25_000 });
				state = response.data ?? null;
				if (!response.success) {
					piReady = false;
					piError = response.error;
				}
			} catch (err) {
				piReady = false;
				piError = err.message;
			}
				json(res, 200, {
					pi: { binary: PI_BIN, ready: piReady, error: piError, busy: pi.busy },
					model: state?.model ?? null,
					modelConfig: modelStore.status(),
					sessionId: state?.sessionId ?? null,
				sessionName: state?.sessionName ?? null,
				messageCount: state?.messageCount ?? 0,
				skillRoot: SKILL_ROOT,
				projectsDir: PROJECTS_DIR,
				python: PYTHON,
			});
			return;
		}

		// ---- 对话
		if (route === "/api/prompt" && req.method === "POST") {
			const body = await readBody(req);
			const message = String(body.message || "").trim();
			if (!message) return json(res, 400, { ok: false, error: "消息为空" });
			const command = { type: "prompt", message };
			if (pi.busy) command.streamingBehavior = "followUp";
			try {
				const response = await pi.send(command, { timeoutMs: 60_000 });
				json(res, response.success ? 200 : 400, {
					ok: response.success,
					queued: pi.busy || response.data?.disposition === "queued",
					disposition: response.data?.disposition,
					error: response.error,
				});
			} catch (err) {
				json(res, 500, { ok: false, error: err.message });
			}
			return;
		}

		if (route === "/api/abort" && req.method === "POST") {
			try {
				const response = await pi.send({ type: "abort" }, { timeoutMs: 60_000 });
				json(res, 200, { ok: response.success, error: response.error });
			} catch (err) {
				json(res, 500, { ok: false, error: err.message });
			}
			return;
		}

		if (route === "/api/new-session" && req.method === "POST") {
			try {
				const response = await pi.send({ type: "new_session" }, { timeoutMs: 60_000 });
				json(res, 200, { ok: response.success, error: response.error });
			} catch (err) {
				json(res, 500, { ok: false, error: err.message });
			}
			return;
		}

		/** 刷新页面后把会话历史还回来，前端不用重新问一遍。 */
		if (route === "/api/history") {
			try {
				const response = await pi.send({ type: "get_entries" }, { timeoutMs: 30_000 });
				if (!response.success) return json(res, 200, { ok: false, error: response.error, items: [] });
				json(res, 200, { ok: true, items: toHistory(response.data?.entries), sessionId: response.data?.leafId });
			} catch (err) {
				json(res, 200, { ok: false, error: err.message, items: [] });
			}
			return;
		}

			// ---- 模型配置（BYOK）
			if (route === "/api/model" && req.method === "GET") {
				json(res, 200, { ok: true, config: modelStore.status(), agentDir: AGENT_DIR });
				return;
			}

			if (route === "/api/model" && req.method === "POST") {
				if (pi.busy) return json(res, 409, { ok: false, error: "正在生产中，等这一步跑完再改模型" });
				const body = await readBody(req);
				try {
					const config = await modelStore.save(body);
					await pi.restart();
					const probe = await pi
						.send({ type: "get_state" }, { timeoutMs: 30_000 })
						.catch((err) => ({ success: false, error: err.message }));
					json(res, 200, {
						ok: true,
						config,
						model: probe.data?.model ?? null,
						warning: probe.success ? null : probe.error,
					});
				} catch (err) {
					json(res, 400, { ok: false, error: err.message });
				}
				return;
			}

			if (route === "/api/model" && req.method === "DELETE") {
				if (pi.busy) return json(res, 409, { ok: false, error: "正在生产中，等这一步跑完再清空配置" });
				try {
					const config = await modelStore.clear();
					await pi.restart();
					json(res, 200, { ok: true, config });
				} catch (err) {
					json(res, 500, { ok: false, error: err.message });
				}
				return;
			}

			if (route === "/api/model/discover" && req.method === "POST") {
				const body = await readBody(req);
				const result = await discoverModels({
					api: body.api,
					baseUrl: body.baseUrl,
					apiKey: String(body.apiKey || "").trim() || modelStore.storedKey(),
				});
				json(res, 200, result);
				return;
			}

			if (route === "/api/model/import" && req.method === "POST") {
				if (pi.busy) return json(res, 409, { ok: false, error: "正在生产中，等这一步跑完再导入" });
				try {
					const config = await modelStore.importFromGlobal();
					await pi.restart();
					json(res, 200, { ok: true, config });
				} catch (err) {
					json(res, 400, { ok: false, error: err.message });
				}
				return;
			}

			// ---- 项目
			if (route === "/api/projects") {
			const result = await runVideoctl(["list", "--json"]);
			json(res, result.ok ? 200 : 500, result.json ?? { ok: false, error: result.stderr.slice(-800) });
			return;
		}

			if (route === "/api/report") {
			const project = url.searchParams.get("project");
			const target = resolveSafe(project);
			if (!target) return json(res, 400, { ok: false, error: "项目路径不合法" });
			const result = await runVideoctl(["report", target, "--json"]);
			json(res, result.ok ? 200 : 500, result.json ?? { ok: false, error: result.stderr.slice(-800) });
				return;
			}

			if (route === "/api/tasks") {
				json(res, 200, {
					ok: true,
					tasks: [...activeTasks.entries()].map(([project, task]) => ({
						project,
						name: path.basename(project),
						cmd: task.cmd,
						id: task.id,
					})),
				});
				return;
			}

		// ---- 确定性操作（不经过模型，按钮直接触发）
		if (route === "/api/run" && req.method === "POST") {
			const body = await readBody(req);
			const command = String(body.cmd || "");
			const target = resolveSafe(body.project);
			const allowed = { lint: "lint", qa: "qa", build: "build", preview: "preview", storyboard: "storyboard" };
			if (!allowed[command]) return json(res, 400, { ok: false, error: `不支持的命令：${command}` });
			if (!target) return json(res, 400, { ok: false, error: "项目路径不合法" });
			const running = activeTasks.get(target);
			if (running) {
				return json(res, 409, {
					ok: false,
					error: `「${path.basename(target)}」正在跑「${running.cmd}」，等它结束再试。`,
				});
			}

			const taskId = randomUUID();
			activeTasks.set(target, { id: taskId, cmd: command });
			const args = [allowed[command], target, "--json"];
			if (command === "build" || command === "preview") {
				const quality = ["l", "m", "h", "k"].includes(body.quality) ? body.quality : "h";
				args.push("--quality", quality);
				args.push(body.voice === false ? "--no-voice" : "--voice");
			}
			broadcast({ t: "task_start", id: taskId, cmd: command, project: path.basename(target) });
			runVideoctl(args, (line) => broadcast({ t: "task_progress", id: taskId, v: line })).then((result) => {
				activeTasks.delete(target);
				broadcast({
					t: "task_end",
					id: taskId,
					cmd: command,
					ok: result.ok,
					payload: result.json,
					error: result.ok ? null : (result.json?.error || result.stderr.slice(-500)),
				});
			});
			return json(res, 202, { ok: true, id: taskId });
		}

		// ---- 逐帧视频处理（OpenCut 引擎支持）
		if (route === "/api/video/probe") {
			const target = resolveSafe(url.searchParams.get("path"));
			if (!target) return json(res, 400, { ok: false, error: "视频路径不合法" });

			const probeChild = spawn(FFPROBE, [
				"-v", "error",
				"-select_streams", "v:0",
				"-show_entries", "stream=width,height,r_frame_rate,duration,nb_frames",
				"-of", "json",
				target,
			]);
			let stdout = "";
			let stderr = "";
			probeChild.stdout.on("data", (c) => (stdout += c));
			probeChild.stderr.on("data", (c) => (stderr += c));
			probeChild.on("close", (code) => {
				if (code !== 0) {
					return json(res, 200, {
						ok: true,
						fps: 60,
						r_frame_rate: "60/1",
						width: 1920,
						height: 1080,
						duration: null,
						nb_frames: null,
						fallback: true,
						error: stderr,
					});
				}
				try {
					const data = JSON.parse(stdout);
					const stream = data.streams?.[0] || {};
					let fps = 60;
					if (stream.r_frame_rate) {
						const parts = stream.r_frame_rate.split("/").map(Number);
						if (parts.length === 2 && parts[1] > 0) {
							fps = Math.round((parts[0] / parts[1]) * 100) / 100;
						} else if (parts[0] > 0) {
							fps = parts[0];
						}
					}
					const duration = stream.duration ? Number.parseFloat(stream.duration) : null;
					const nb_frames = stream.nb_frames ? Number.parseInt(stream.nb_frames, 10) : (duration ? Math.round(duration * fps) : null);
					return json(res, 200, {
						ok: true,
						fps,
						r_frame_rate: stream.r_frame_rate || `${fps}/1`,
						width: stream.width || 1920,
						height: stream.height || 1080,
						duration,
						nb_frames,
					});
				} catch (err) {
					return json(res, 200, { ok: true, fps: 60, width: 1920, height: 1080, fallback: true, error: err.message });
				}
			});
			return;
		}

		if (route === "/api/video/cut" && req.method === "POST") {
			const body = await readBody(req);
			const target = resolveSafe(body.path);
			if (!target) return json(res, 400, { ok: false, error: "视频路径不合法" });

			const startTime = Math.max(0, Number(body.startTime || 0));
			const endTime = Math.max(startTime + 0.05, Number(body.endTime || 0));
			if (endTime <= startTime) return json(res, 400, { ok: false, error: "裁剪起止时间无效" });

			const cutsDir = path.join(path.dirname(target), "cuts");
			await fsp.mkdir(cutsDir, { recursive: true });
			const basename = path.basename(target, path.extname(target));
			const outName = body.outName || `${basename}_cut_${Math.round(startTime * 1000)}_${Math.round(endTime * 1000)}.mp4`;
			const outPath = path.join(cutsDir, outName);

			const ffmpegArgs = [
				"-ss", startTime.toFixed(4),
				"-to", endTime.toFixed(4),
				"-i", target,
				"-c:v", "libx264",
				"-c:a", "aac",
				"-avoid_negative_ts", "make_zero",
				"-y",
				outPath,
			];
			const cutChild = spawn(FFMPEG, ffmpegArgs);
			let stderr = "";
			cutChild.stderr.on("data", (c) => (stderr += c));
			cutChild.on("close", (code) => {
				if (code === 0) {
					json(res, 200, {
						ok: true,
						path: outPath,
						filename: outName,
						duration: Math.round((endTime - startTime) * 1000) / 1000,
					});
				} else {
					json(res, 500, { ok: false, error: stderr.slice(-600) || "裁剪失败" });
				}
			});
			return;
		}

		if (route === "/api/video/extract-frame" && req.method === "POST") {
			const body = await readBody(req);
			const target = resolveSafe(body.path);
			if (!target) return json(res, 400, { ok: false, error: "视频路径不合法" });

			const time = Math.max(0, Number(body.time || 0));
			const snapsDir = path.join(path.dirname(target), "snapshots");
			await fsp.mkdir(snapsDir, { recursive: true });
			const basename = path.basename(target, path.extname(target));
			const outName = `${basename}_frame_${Math.round(time * 1000)}.png`;
			const outPath = path.join(snapsDir, outName);

			const ffmpegArgs = [
				"-ss", time.toFixed(4),
				"-i", target,
				"-vframes", "1",
				"-q:v", "2",
				"-y",
				outPath,
			];
			const frameChild = spawn(FFMPEG, ffmpegArgs);
			let stderr = "";
			frameChild.stderr.on("data", (c) => (stderr += c));
			frameChild.on("close", (code) => {
				if (code === 0) {
					json(res, 200, {
						ok: true,
						path: outPath,
						filename: outName,
						time,
					});
				} else {
					json(res, 500, { ok: false, error: stderr.slice(-600) || "抓取单帧失败" });
				}
			});
			return;
		}

		if (route === "/api/video/render-stickers" && req.method === "POST") {
			const body = await readBody(req);
			const target = resolveSafe(body.path);
			if (!target) return json(res, 400, { ok: false, error: "视频路径不合法" });

			const stickers = Array.isArray(body.stickers) ? body.stickers : [];
			if (stickers.length === 0) {
				return json(res, 200, { ok: true, path: target, filename: path.basename(target) });
			}

			const cutsDir = path.join(path.dirname(target), "cuts");
			await fsp.mkdir(cutsDir, { recursive: true });
			const tmpDir = path.join(cutsDir, `.tmp_stickers_${Date.now()}`);
			await fsp.mkdir(tmpDir, { recursive: true });

			const basename = path.basename(target, path.extname(target));
			const outName = `${basename}_with_stickers_${Date.now()}.mp4`;
			const outPath = path.join(cutsDir, outName);

			try {
				const inputs = ["-i", target];
				const filterParts = [];
				let lastOutput = "0:v";

				for (let i = 0; i < stickers.length; i++) {
					const s = stickers[i];
					const imgPath = path.join(tmpDir, `stk_${i}.png`);
					const base64Data = (s.dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
					await fsp.writeFile(imgPath, Buffer.from(base64Data, "base64"));
					inputs.push("-i", imgPath);

					const inputIdx = i + 1;
					const scaledLabel = `s${i}`;
					const outLabel = i === stickers.length - 1 ? "vfinal" : `tmp${i}`;

					const w = Math.max(16, Math.round(s.width || 120));
					const h = Math.max(16, Math.round(s.height || 120));
					const x = Math.max(0, Math.round(s.x || 0));
					const y = Math.max(0, Math.round(s.y || 0));
					const start = Math.max(0, Number(s.startTime || 0)).toFixed(3);
					const end = Math.max(Number(s.startTime || 0) + 0.1, Number(s.endTime || 9999)).toFixed(3);

					filterParts.push(`[${inputIdx}:v]scale=${w}:${h}[${scaledLabel}]`);
					filterParts.push(
						`[${lastOutput}][${scaledLabel}]overlay=x=${x}:y=${y}:enable='between(t,${start},${end})'[${outLabel}]`
					);
					lastOutput = outLabel;
				}

				const ffmpegArgs = [
					...inputs,
					"-filter_complex",
					filterParts.join(";"),
					"-map",
					`[${lastOutput}]`,
					"-map",
					"0:a?",
					"-c:v",
					"libx264",
					"-c:a",
					"aac",
					"-avoid_negative_ts",
					"make_zero",
					"-y",
					outPath,
				];

				const renderChild = spawn(FFMPEG, ffmpegArgs);
				let stderr = "";
				renderChild.stderr.on("data", (c) => (stderr += c));
				renderChild.on("close", async (code) => {
					try {
						await fsp.rm(tmpDir, { recursive: true, force: true });
					} catch {}
					if (code === 0) {
						json(res, 200, {
							ok: true,
							path: outPath,
							filename: outName,
						});
					} else {
						json(res, 500, { ok: false, error: stderr.slice(-600) || "贴纸合成渲染失败" });
					}
				});
			} catch (err) {
				try {
					await fsp.rm(tmpDir, { recursive: true, force: true });
				} catch {}
				json(res, 500, { ok: false, error: err.message });
			}
			return;
		}

		// ---- 文件（视频/图片/故事板）
		if (route === "/api/file") {
			const target = resolveSafe(url.searchParams.get("path"));
			if (!target) return json(res, 403, { ok: false, error: "路径不合法" });
			serveFile(req, res, target);
			return;
		}

		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
	} catch (err) {
		json(res, 500, { ok: false, error: err?.message || String(err) });
	}
});

function resolveWithin(root, relative) {
	const target = path.resolve(root, relative);
	return isInside(root, target) ? target : null;
}

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") {
		console.error(`端口 ${PORT} 已被占用：可能已经开着一个工作台窗口了。`);
		console.error(`换个端口：PORT=5181 bin/web`);
	} else {
		console.error(`服务启动失败：${err.message}`);
	}
	process.exit(1);
});

server.listen(PORT, HOST, () => {
	console.log(`Animath Studio（幻数工坊）已启动：http://${HOST}:${PORT}`);
	console.log(`  技能仓库：${SKILL_ROOT}`);
	console.log(`  项目目录：${PROJECTS_DIR}`);
	console.log(`  Pi 可执行：${PI_BIN}`);
	const missing = [];
	if (!fs.existsSync(PROJECTS_DIR)) missing.push(`项目目录不存在：${PROJECTS_DIR}`);
	if (!fs.existsSync(VIDEOCTL)) missing.push(`找不到 ${VIDEOCTL}`);
	if (missing.length) console.warn(`警告：${missing.join("；")}`);
	pi.start();
});

function shutdown() {
	console.log("\n正在关闭…");
	for (const client of sseClients) {
		try {
			client.end();
		} catch {
			/* 忽略 */
		}
	}
	pi.proc?.stdin.end();
	setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { server, pi, runVideoctl, resolveSafe, SKILL_ROOT, PROJECTS_DIR, ROOT };
