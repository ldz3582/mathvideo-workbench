#!/usr/bin/env node
/**
 * 工作台冒烟测试：用 Pi 自己的扩展加载器（jiti + 官方别名）真实加载 extensions/video-workbench.ts，
 * 用桩对象接收注册结果，然后顺着扩展 -> videoctl -> manim 技能仓库 这条链路跑一次真实调用。
 *
 * 用法： node tools/verify_workbench.mjs [--offline]
 *   --offline  跳过真实调用（只验证注册与技能发现）
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OFFLINE = process.argv.includes("--offline");

function findPiPackage() {
	const candidates = [
		process.env.PI_CODING_AGENT_DIR,
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
		path.join(process.env.HOME ?? "", ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent"),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(path.join(candidate, "package.json"))) return candidate;
	}
	// 从全局 npm 根目录兜底查找
	const globalRoot = spawnSyncSafe("npm", ["root", "-g"]);
	if (globalRoot) {
		const guess = path.join(globalRoot, "@earendil-works/pi-coding-agent");
		if (fs.existsSync(path.join(guess, "package.json"))) return guess;
	}
	throw new Error("找不到已安装的 @earendil-works/pi-coding-agent，请先安装 Pi");
}


const piPackage = findPiPackage();
const requireFromPi = createRequire(path.join(piPackage, "package.json"));
console.log(`Pi 安装位置: ${piPackage}`);

const { createJiti } = await import(requireFromPi.resolve("jiti"));

// Pi 在加载扩展时会给这些宿主包做别名（见 coding-agent/src/core/extensions/loader.ts）
const aliases = {
	typebox: requireFromPi.resolve("typebox"),
	"typebox/value": requireFromPi.resolve("typebox/value"),
	"@earendil-works/pi-coding-agent": requireFromPi.resolve(piPackage),
};

const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });

const tools = new Map();
const commands = new Map();
const handlers = new Map();
const notifications = [];

const mockPi = {
	on(event, handler) {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
	sendUserMessage(content) {
		notifications.push(`[sendUserMessage] ${String(content).slice(0, 60)}…`);
	},
};

const mockCtx = {
	ui: {
		notify: (message, type) => notifications.push(`[${type ?? "info"}] ${message}`),
		setStatus: () => {},
		confirm: async () => true,
		input: async () => undefined,
		select: async () => undefined,
	},
};

const extensionPath = path.join(ROOT, "extensions", "video-workbench.ts");
const factory = await jiti.import(extensionPath, { default: true });
if (typeof factory !== "function") throw new Error("扩展没有导出默认工厂函数");
await factory(mockPi);

const failures = [];
const report = { ok: true, piPackage, tools: [...tools.keys()], commands: [...commands.keys()], checks: {} };

// --- 1. 技能发现 ----------------------------------------------------------
const discover = handlers.get("resources_discover");
if (!discover) failures.push("未注册 resources_discover 事件，manim-video 技能不会被挂载");
else {
	const result = await discover({ type: "resources_discover", cwd: ROOT, reason: "startup" }, mockCtx);
	const skillPaths = result?.skillPaths ?? [];
	const ok = skillPaths.some((p) => fs.existsSync(path.join(p, "SKILL.md")));
	report.checks.skill_discovery = { skillPaths, ok };
	if (!ok) failures.push("resources_discover 没有返回可用的 manim-video 技能目录");
}

// --- 2. session_start 通知 ------------------------------------------------
const onStart = handlers.get("session_start");
if (onStart) await onStart({ type: "session_start" }, mockCtx);
report.checks.session_notice = notifications.slice();

// --- 3. 工具与命令数量 ----------------------------------------------------
const expectedTools = ["video_env_check", "video_new", "video_lint", "video_qa", "video_build", "video_storyboard", "video_report"];
const missingTools = expectedTools.filter((name) => !tools.has(name));
if (missingTools.length) failures.push(`缺少工具：${missingTools.join(", ")}`);
const missingCommands = ["video", "video-build", "video-qa", "video-status"].filter((name) => !commands.has(name));
if (missingCommands.length) failures.push(`缺少命令：${missingCommands.join(", ")}`);

// --- 4. 真实调用 video_env_check -----------------------------------------
if (!OFFLINE) {
	const tool = tools.get("video_env_check");
	const result = await tool.execute("smoke-1", {}, undefined, undefined, mockCtx);
	const text = result.content?.[0]?.text ?? "";
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	report.checks.env_check = { ok: parsed?.ok ?? null, checks: parsed ? Object.keys(parsed.checks ?? {}) : null };
	if (!parsed?.ok) failures.push(`video_env_check 未通过：${text.slice(0, 400)}`);
}

report.ok = failures.length === 0;
report.failures = failures;
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
