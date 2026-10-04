/**
 * video-workbench 扩展
 *
 * 把「Pi 智能体框架」与「manim-video 技能仓库」连起来：
 *  - 通过 resources_discover 把技能仓库里的 manim-video 技能直接挂进 Pi
 *  - 把确定性流水线 videoctl 暴露成 7 个原生工具，模型只需决策、不必手敲命令
 *  - 提供 /video 等斜杠命令做一键全自动生产
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_TIMEOUT_MS = 45 * 60 * 1000;

function workbenchRoot(): string {
	const fromEnv = process.env.MATHVIDEO_WORKBENCH_ROOT;
	if (fromEnv && fs.existsSync(path.join(fromEnv, "tools", "videoctl.py"))) return fromEnv;
	try {
		const here = path.dirname(new URL(import.meta.url).pathname);
		const root = path.resolve(here, "..");
		if (fs.existsSync(path.join(root, "tools", "videoctl.py"))) return root;
	} catch {
		// fall through to cwd search
	}
	let dir = process.cwd();
	for (let i = 0; i < 8; i += 1) {
		if (fs.existsSync(path.join(dir, "tools", "videoctl.py"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("找不到 mathvideo-workbench 根目录：请设置 MATHVIDEO_WORKBENCH_ROOT");
}

function readConfig(): Record<string, string> {
	try {
		const file = path.join(workbenchRoot(), "tools", "workbench.json");
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

function skillRoot(): string | undefined {
	const configured = (process.env.MATHVIDEO_SKILL_ROOT || readConfig().skill_root || "").trim();
	if (configured && fs.existsSync(path.join(configured, "skills", "manim-video", "SKILL.md"))) return configured;
	const repo = path.resolve(workbenchRoot(), "..", "Mathvideo-skill");
	if (fs.existsSync(path.join(repo, "skills", "manim-video", "SKILL.md"))) return repo;
	return undefined;
}

interface RunResult {
	ok: boolean;
	code: number | null;
	json: Record<string, unknown> | null;
	stdout: string;
	stderr: string;
}

function runVideoctl(
	args: string[],
	onProgress?: (line: string) => void,
): Promise<RunResult> {
	const root = workbenchRoot();
	const python = process.env.MATHVIDEO_PYTHON3 || "python3";
	const argv = [path.join(root, "tools", "videoctl.py"), ...args];
	return new Promise((resolve) => {
		const child = spawn(python, argv, {
			cwd: process.env.MATHVIDEO_CWD || process.cwd(),
			env: { ...process.env, MATHVIDEO_WORKBENCH_ROOT: root, PYTHONUNBUFFERED: "1" },
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), TOOL_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderr += text;
			if (onProgress) for (const line of text.split("\n")) if (line.trim()) onProgress(line.trim());
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ok: false, code: null, json: null, stdout, stderr: `${stderr}\n${err.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			let parsed: Record<string, unknown> | null = null;
			const start = stdout.indexOf("{");
			if (start >= 0) {
				try {
					parsed = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
				} catch {
					parsed = null;
				}
			}
			resolve({ ok: code === 0, code, json: parsed, stdout, stderr });
		});
	});
}

function summarize(result: RunResult): string {
	if (result.json) return JSON.stringify(result.json, null, 2);
	return [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-4000) || "(无输出)";
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function imageResult(text: string, imagePath: string, details: Record<string, unknown> = {}, maxBytes = 4_000_000) {
	try {
		const stat = fs.statSync(imagePath);
		if (stat.size <= maxBytes) {
			const data = fs.readFileSync(imagePath).toString("base64");
			return {
				content: [{ type: "text" as const, text }, { type: "image" as const, data, mimeType: "image/png" }],
				details,
			};
		}
	} catch {
		// fall back to text-only
	}
	return textResult(text, details);
}

export default function videoWorkbench(pi: ExtensionAPI) {
	pi.on("resources_discover", () => {
		const root = skillRoot();
		if (!root) return;
		return { skillPaths: [path.join(root, "skills", "manim-video")] };
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		const root = skillRoot();
		ctx.ui.notify(
			root ? `数学视频工作台已就绪（技能仓库：${root}）` : "数学视频工作台：未找到 manim-video 技能仓库，请检查 tools/workbench.json",
			root ? "info" : "warning",
		);
	});

	// ---------------------------------------------------------------- 工具
	pi.registerTool({
		name: "video_env_check",
		label: "Video: 环境自检",
		description: "检查 manim / ffmpeg / LaTeX / 中文字体 / 技能仓库是否就绪，返回 JSON 报告。生产前先跑一次。",
		promptSnippet: "检查数学视频生产环境（manim/ffmpeg/LaTeX/中文字体）是否就绪",
		promptGuidelines: ["开始任何数学视频生产前，先调用 video_env_check 确认环境。"],
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_id, _params) {
			const res = await runVideoctl(["check", "--json"]);
			return textResult(summarize(res), { ok: res.ok });
		},
	});

	pi.registerTool({
		name: "video_new",
		label: "Video: 新建项目",
		description:
			"创建一个新的数学视频项目骨架（brief、时间轴脚本模板、theme_config），返回项目绝对路径。主题用自然语言描述即可。",
		promptSnippet: "新建数学视频项目骨架",
		parameters: Type.Object({
			topic: Type.String({ description: "视频主题，例如：圆的面积为什么是 πr²" }),
			slug: Type.Optional(Type.String({ description: "项目目录名（英文/数字/下划线），省略则自动生成" })),
			theme: Type.Optional(Type.String({ description: "美学主题，如 claude_light / 3b1b_dark / chalkboard" })),
			audience: Type.Optional(Type.String({ description: "目标受众" })),
			minutes: Type.Optional(Type.Number({ description: "预估时长（分钟）" })),
		}),
		annotations: { destructiveHint: false, openWorldHint: false },
		async execute(_id, params) {
			const args = ["new", params.topic, "--json"];
			if (params.slug) args.push("--slug", params.slug);
			if (params.theme) args.push("--theme", params.theme);
			if (params.audience) args.push("--audience", params.audience);
			if (typeof params.minutes === "number") args.push("--minutes", String(params.minutes));
			const res = await runVideoctl(args);
			return textResult(summarize(res), { ok: res.ok, project: (res.json?.project as string) ?? null });
		},
	});

	pi.registerTool({
		name: "video_lint",
		label: "Video: 静态检查",
		description: "对项目内 scene_*.py 做静态检查：中文进 LaTeX、硬编码字体、视口越界、配音时间轴缺失等。",
		promptSnippet: "对分幕代码做静态检查",
		parameters: Type.Object({ project: Type.String({ description: "项目目录（绝对路径或相对路径）" }) }),
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			const res = await runVideoctl(["lint", params.project, "--json"]);
			return textResult(summarize(res), { ok: res.ok });
		},
	});

	pi.registerTool({
		name: "video_qa",
		label: "Video: 单帧质检",
		description:
			"逐幕渲染末帧并拼成一张总览图，同时返回图片本体供你直接查看排版。这是修改画面后必须走的一步。",
		promptSnippet: "渲染每幕关键帧拼图，用于检查排版",
		promptGuidelines: ["写完或修改任何 scene 代码后，必须调用 video_qa 看图确认排版，再进入正式渲染。"],
		parameters: Type.Object({
			project: Type.String({ description: "项目目录" }),
			only: Type.Optional(Type.Array(Type.String(), { description: "只检查指定场景类名" })),
		}),
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			const args = ["qa", params.project, "--json"];
			if (params.only?.length) args.push("--only", ...params.only);
			const res = await runVideoctl(args);
			const sheet = res.json?.contact_sheet as string | null;
			const text = summarize(res);
			if (sheet) {
				return imageResult(`${text}\n\n总览图：${sheet}`, sheet, { ok: res.ok, contact_sheet: sheet });
			}
			return textResult(text, { ok: res.ok });
		},
	});

	pi.registerTool({
		name: "video_build",
		label: "Video: 渲染出片",
		description:
			"正式渲染全部分幕：高清渲染 → 逐幕混入配音 → 无损拼接成完整成片，返回成片路径、时长与体积。耗时较长。",
		promptSnippet: "高清渲染并合成最终成片（含配音）",
		parameters: Type.Object({
			project: Type.String({ description: "项目目录" }),
			quality: Type.Optional(Type.String({ description: "l/480p, m/720p, h/1080p, k/4K，默认 h" })),
			voice: Type.Optional(Type.Boolean({ description: "是否混入配音，默认 true" })),
		}),
		annotations: { destructiveHint: false, openWorldHint: false },
		async execute(_id, params, _signal, onUpdate) {
			const args = ["build", params.project, "--json"];
			if (params.quality) args.push("--quality", params.quality);
			if (params.voice === false) args.push("--no-voice");
			const res = await runVideoctl(args, (line) => onUpdate?.(textResult(line)));
			return textResult(summarize(res), { ok: res.ok, output: (res.json?.output as string) ?? null });
		},
	});

	pi.registerTool({
		name: "video_storyboard",
		label: "Video: 故事板",
		description: "扫描项目生成可离线浏览的 HTML 故事板看板（每幕标题、台词、关键帧）。",
		promptSnippet: "生成 HTML 故事板看板",
		parameters: Type.Object({ project: Type.String({ description: "项目目录" }) }),
		annotations: { readOnlyHint: false },
		async execute(_id, params) {
			const res = await runVideoctl(["storyboard", params.project, "--json"]);
			return textResult(summarize(res), { ok: res.ok });
		},
	});

	pi.registerTool({
		name: "video_report",
		label: "Video: 产物汇总",
		description: "汇总项目当前状态：分幕清单、配音段数、成片路径/时长/体积，用于回答「做到哪一步了」。",
		promptSnippet: "汇总项目产物与进度",
		parameters: Type.Object({ project: Type.String({ description: "项目目录" }) }),
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			const res = await runVideoctl(["report", params.project, "--json"]);
			return textResult(summarize(res), { ok: res.ok });
		},
	});

	// ---------------------------------------------------------------- 命令
	pi.registerCommand("video", {
		description: "一键全自动制作数学视频：/video <主题>",
		handler: async (args: string, ctx: ExtensionContext) => {
			const topic = args.trim();
			if (!topic) {
				ctx.ui.notify("用法：/video <主题>，例如 /video 欧拉公式的几何本质", "warning");
				return;
			}
			pi.sendUserMessage(
				[
					`请用数学视频工作台全自动制作一支关于「${topic}」的数学科普视频。`,
					"",
					"严格按 mathvideo-autopilot 技能执行：",
					"1. video_env_check 确认环境；",
					"2. 写好 script_and_timeline.md 后，把脚本要点直接呈现给我确认（我若已在命令里说明免确认，则直接继续）；",
					"3. video_new 建项目 → 按技能规范编写 scene_*.py；",
					"4. video_lint → video_qa，看图自查排版并迭代修正；",
					"5. video_build 出片，最后 video_report 汇报成片路径与时长。",
				].join("\n"),
			);
		},
	});

	pi.registerCommand("video-build", {
		description: "直接渲染出片：/video-build <项目目录> [--quality h] [--no-voice]",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (!parts.length) {
				ctx.ui.notify("用法：/video-build <项目目录> [--quality h] [--no-voice]", "warning");
				return;
			}
			ctx.ui.notify("开始渲染，请稍候…", "info");
			const res = await runVideoctl(["build", ...parts, "--json"], (line) => ctx.ui.notify(line, "info"));
			const output = (res.json?.output as string) ?? "";
			ctx.ui.notify(res.ok ? `成片完成：${output}` : `渲染失败：${summarize(res).slice(-500)}`, res.ok ? "info" : "error");
		},
	});

	pi.registerCommand("video-qa", {
		description: "跑一遍单帧质检：/video-qa <项目目录>",
		handler: async (args: string, ctx: ExtensionContext) => {
			const project = args.trim();
			if (!project) {
				ctx.ui.notify("用法：/video-qa <项目目录>", "warning");
				return;
			}
			const res = await runVideoctl(["qa", project, "--json"]);
			const sheet = (res.json?.contact_sheet as string) ?? "";
			ctx.ui.notify(res.ok ? `质检完成，总览图：${sheet}` : `质检失败：${summarize(res).slice(-500)}`, res.ok ? "info" : "error");
		},
	});

	pi.registerCommand("video-status", {
		description: "查看项目进度：/video-status [项目目录]",
		handler: async (args: string, ctx: ExtensionContext) => {
			const project = args.trim();
			const cmd = project ? ["report", project, "--json"] : ["list", "--json"];
			const res = await runVideoctl(cmd);
			ctx.ui.notify(summarize(res).slice(0, 1500), res.ok ? "info" : "error");
		},
	});
}
