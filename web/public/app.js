/* 数学视频工作台 · 前端
   只做三件事：把 SSE 事件画成对话、把项目画成列表、把成片画成播放器。 */
(() => {
	"use strict";

	const $ = (sel) => document.querySelector(sel);
	const messagesEl = $("#messages");
	const outputEl = $("#output");
	const projectListEl = $("#project-list");
	const projectSearchEl = $("#project-search");
	const projectCountEl = $("#project-count");
	const inputEl = $("#input");
	const sendBtn = $("#send");
	const chipsEl = $("#chips");

	let projectSearchQuery = "";

	const state = {
		running: false,
		assistant: null,
		tools: new Map(),
		projects: [],
		selected: null,
		tasks: new Map(),
		busyTask: false,
		liveEvents: 0,
	};

	const TOOL_LABELS = {
		video_env_check: "环境自检",
		video_new: "新建项目",
		video_lint: "静态检查",
		video_qa: "单帧质检",
		video_build: "渲染出片",
		video_storyboard: "生成故事板",
		video_report: "产物汇总",
	};

	const TOOL_ICONS = {
		video_env_check: "🛠️",
		video_new: "📁",
		video_lint: "🔍",
		video_qa: "👁️",
		video_build: "🎬",
		video_storyboard: "📋",
		video_report: "📊",
	};

	const ENV_LABELS = {
		skill_root: "技能仓库",
		python: "Python / Manim",
		ffmpeg: "ffmpeg",
		latex: "LaTeX",
		dvisvgm: "dvisvgm",
		projects_dir: "项目目录",
	};

	// 这几类工具的结果自带画面（成片、质检拼图），展开才看得见价值
	const AUTO_OPEN = new Set(["video_build", "video_qa", "video_report", "video_storyboard"]);

	// ------------------------------------------------------------ 工具函数
	const esc = (s) =>
		String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

	const TRAILING = /[，。；：、）)】」'".,;:]+$/;

	/** 把成片/质检图这类绝对路径变成可点开的链接，省得用户自己找文件。 */
	function linkPath(path) {
		const trail = TRAILING.exec(path)?.[0] || "";
		const clean = trail ? path.slice(0, -trail.length) : path;
		if (!clean.startsWith("/")) return path;
		return `<a class="file-link" href="${fileUrl(clean)}" target="_blank" rel="noopener">${clean}</a>${trail}`;
	}

	function inline(text) {
		return esc(text)
			.replace(/`([^`\n]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\/[^\s<>"'`，。；：、）)】」]*\.(?:mp4|png|jpe?g|html|md|json|srt|wav|mp3)/g, linkPath);
	}

	/** 轻量 markdown：标题、无序/有序列表、段落，够把脚本要点读清楚。
	 *  连续行合成一个 <p>（靠 pre-wrap 保留换行），这样跨行的 \[ ... \] 公式仍是一个文本节点，KaTeX 才认得出。 */
	function formatText(text) {
		const out = [];
		let list = null;
		let para = [];
		let quote = [];
		const closeList = () => {
			if (list) {
				out.push(`</${list}>`);
				list = null;
			}
		};
		const flushPara = () => {
			if (para.length) {
				out.push(`<p>${inline(para.join("\n"))}</p>`);
				para = [];
			}
		};
		const flushQuote = () => {
			if (quote.length) {
				out.push(`<blockquote>${inline(quote.join("\n"))}</blockquote>`);
				quote = [];
			}
		};
		for (const raw of String(text ?? "").split("\n")) {
			const line = raw.replace(/\s+$/, "");
			const quoted = /^\s*>\s?(.*)$/.exec(line);
			if (quoted) {
				flushPara();
				closeList();
				quote.push(quoted[1]);
				continue;
			}
			flushQuote();
			const bullet = /^\s*[-*·]\s+(.*)$/.exec(line);
			const numbered = /^\s*\d+[.)、]\s+(.*)$/.exec(line);
			const heading = /^\s*(#{1,4})\s+(.*)$/.exec(line);
			if (bullet) {
				flushPara();
				if (list !== "ul") {
					closeList();
					out.push("<ul>");
					list = "ul";
				}
				out.push(`<li>${inline(bullet[1])}</li>`);
				continue;
			}
			if (numbered) {
				flushPara();
				if (list !== "ol") {
					closeList();
					out.push("<ol>");
					list = "ol";
				}
				out.push(`<li>${inline(numbered[1])}</li>`);
				continue;
			}
			closeList();
			if (heading) {
				flushPara();
				out.push(`<h4>${inline(heading[2])}</h4>`);
				continue;
			}
			if (!line.trim()) {
				flushPara();
				continue;
			}
			para.push(line);
		}
		closeList();
		flushQuote();
		flushPara();
		return out.join("");
	}

	/** 公式渲染：KaTeX 本地打包，没网也能用；渲染失败就保留原文，不影响阅读。 */
	function renderMath(el) {
		if (!window.renderMathInElement || !el || el.dataset.mathDone === "1") return;
		el.dataset.mathDone = "1";
		try {
			window.renderMathInElement(el, {
				delimiters: [
					{ left: "$$", right: "$$", display: true },
					{ left: "\\[", right: "\\]", display: true },
					{ left: "\\(", right: "\\)", display: false },
					{ left: "$", right: "$", display: false },
				],
				throwOnError: false,
			});
		} catch {
			/* 渲染不了就算了，原文还在 */
		}
	}

	const fileUrl = (p) => `/api/file?path=${encodeURIComponent(p)}`;
	const basename = (p) => String(p || "").split("/").pop();

	function scrollToBottom(force = false) {
		// 宽屏时消息区自己滚；窄屏/手机时三栏堆叠，滚的是整页
		if (messagesEl.scrollHeight > messagesEl.clientHeight + 4) {
			const near = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 220;
			if (force || near) messagesEl.scrollTop = messagesEl.scrollHeight;
			return;
		}
		const doc = document.scrollingElement || document.documentElement;
		const rect = messagesEl.getBoundingClientRect();
		const gap = rect.bottom - window.innerHeight;
		if (!force && gap < -320) return;
		if (gap > -16) doc.scrollTop = Math.max(doc.scrollTop, doc.scrollTop + gap + 16);
	}

	function showLightbox(src) {
		const box = document.createElement("div");
		box.className = "lightbox";
		box.innerHTML = `<img src="${esc(src)}" alt="预览" />`;
		box.addEventListener("click", () => box.remove());
		document.body.appendChild(box);
	}

	function emptyState() {
		messagesEl.innerHTML = `
			<div class="empty-state">
				<div class="empty-logo-wrap">
					<img src="/static/favicon.svg?v=300" alt="Animath" class="empty-logo" width="48" height="48" />
				</div>
				<h2 class="empty-title">开启一部数学微电影</h2>
				<p class="empty-desc">输入任意数学定理或几何直觉，AI 自动完成分幕脚本、Manim 矢量动效渲染与逐帧音画对齐。</p>
				
				<div class="pipeline-grid">
					<div class="pipeline-card" data-prompt="请为我制作一部关于「圆的面积为什么是 πr²」的微电影，先输出分幕脚本">
						<div class="card-head">
							<span class="card-icon">📐</span>
							<span class="card-title">1. 脚本编排</span>
						</div>
						<div class="card-detail">拆解直觉主线与代数推导，生成生动拟人化分幕解说台词。</div>
					</div>
					<div class="pipeline-card" data-prompt="请为我制作一部关于「勾股定理的可视化几何证明」的微电影，先输出分幕脚本">
						<div class="card-head">
							<span class="card-icon">⚡</span>
							<span class="card-title">2. 矢量动效</span>
						</div>
						<div class="card-detail">自动编写 Manim 代码，精准控制几何坐标、曲线与变换。</div>
					</div>
					<div class="pipeline-card" data-prompt="请为我制作一部关于「欧拉公式与复平面旋转」的微电影，先输出分幕脚本">
						<div class="card-head">
							<span class="card-icon">🔍</span>
							<span class="card-title">3. 视觉质检</span>
						</div>
						<div class="card-detail">多角度自查画面排版与公式重叠，保证母带级观感。</div>
					</div>
					<div class="pipeline-card" data-prompt="请为我制作一部关于「傅里叶变换与圆周运动」的微电影，先输出分幕脚本">
						<div class="card-head">
							<span class="card-icon">🎬</span>
							<span class="card-title">4. 音画成片</span>
						</div>
						<div class="card-detail">逐帧音画同步配音，并支持 OpenCut 逐帧剪辑与贴纸。</div>
					</div>
				</div>
			</div>`;

		const cards = messagesEl.querySelectorAll(".pipeline-card");
		cards.forEach((card) => {
			card.addEventListener("click", () => {
				const prompt = card.dataset.prompt;
				if (prompt && inputEl) {
					inputEl.value = prompt;
					inputEl.focus();
				}
			});
		});
	}

	function notice(text, level = "info") {
		const div = document.createElement("div");
		div.className = `notice${level === "error" || level === "warning" ? " error" : ""}`;
		div.textContent = text;
		messagesEl.appendChild(div);
		scrollToBottom(true);
	}

	function apiKeyCard() {
		notice("模型没有连上：检查 API Key 与接口地址，或换一个模型。", "error");
		openModelDialog();
	}

	/** 出错时除了说原因，还给一个直接去改配置的按钮。 */
	function errorNotice(text) {
		const div = document.createElement("div");
		div.className = "notice error";
		div.textContent = text;
		if (/key|模型|401|403|404|429|权限|限流|连不上|地址|not supported/i.test(text)) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "mini";
			btn.style.marginLeft = "10px";
			btn.textContent = "检查模型配置";
			btn.addEventListener("click", openModelDialog);
			div.appendChild(btn);
		}
		messagesEl.appendChild(div);
		scrollToBottom(true);
	}

	// ------------------------------------------------------------ 对话渲染
	function addUser(text) {
		const el = document.createElement("div");
		el.className = "msg msg-user";
		el.textContent = text;
		messagesEl.appendChild(el);
		scrollToBottom(true);
	}

	function ensureAssistant() {
		if (state.assistant) return state.assistant;
		const el = document.createElement("div");
		el.className = "msg msg-ai";
		messagesEl.appendChild(el);
		state.assistant = el;
		return el;
	}

	function addAssistantText(text) {
		const el = document.createElement("div");
		el.className = "msg msg-ai";
		el.dataset.raw = text;
		el.innerHTML = formatText(text);
		messagesEl.appendChild(el);
		return el;
	}

	/** 刷新页面后把上一次的对话按原样画回来（含工具卡片与质检图）。 */
	async function loadHistory() {
		const before = state.liveEvents;
		let data;
		try {
			const res = await fetch("/api/history");
			data = await res.json();
		} catch {
			return;
		}
		// 拉取期间已经有实时事件进来了，就让实时流负责画面，别两套内容打架
		if (state.liveEvents !== before || !data?.items?.length) return;

		messagesEl.innerHTML = "";
		state.tools.clear();
		for (const item of data.items) {
			if (item.kind === "user") {
				addUser(item.text);
			} else if (item.kind === "assistant") {
				addAssistantText(item.text);
			} else if (item.kind === "error") {
				errorNotice(item.text);
			} else if (item.kind === "tool") {
				const tool = toolCard(item.id, item.name, item.args);
				const ok = item.ok !== false;
				markToolDone(tool, ok);
				tool.head.querySelector(".tool-arg").textContent = summarizeTool(item.name, item.text, ok);
				renderToolResult(tool, ok, item.text, item.images || []);
				if (!ok) openBody(tool);
			}
		}
		for (const el of messagesEl.querySelectorAll(".msg-ai")) renderMath(el);
		scrollToBottom(true);
		// 浏览器会在加载后自行恢复滚动位置，可能晚于这一帧，所以分几次拉到底
		for (const delay of [0, 200, 600, 1200]) setTimeout(() => scrollToBottom(true), delay);
	}

	// ------------------------------------------------------------ 工具卡片
	function toolCard(id, name, args) {
		const el = document.createElement("div");
		el.className = "tool";
		const argText = args?.project ? basename(args.project) : args?.topic ? args.topic : "";
		const icon = TOOL_ICONS[name] || "⚡";
		el.innerHTML = `
			<div class="tool-head">
				<span class="tool-icon">${icon}</span>
				<span class="spinner"></span>
				<span class="tick"></span>
				<span class="tool-name">${esc(TOOL_LABELS[name] || name)}</span>
				<span class="tool-arg">${esc(argText)}</span>
				<span class="chev">▾</span>
			</div>
			<div class="tool-body" hidden>
				<div class="tool-progress"></div>
			</div>`;
		const head = el.querySelector(".tool-head");
		const body = el.querySelector(".tool-body");
		head.addEventListener("click", () => {
			body.hidden = !body.hidden;
			body.classList.toggle("open", !body.hidden);
		});
		messagesEl.appendChild(el);

		const entry = { el, head, body, name, progress: el.querySelector(".tool-progress") };
		state.tools.set(id, entry);
		scrollToBottom(true);
		return entry;
	}

	function openBody(tool) {
		tool.body.hidden = false;
		tool.body.classList.add("open");
	}

	/** 工具结果的统一画法：实时流和历史回放走同一条路，避免两边长得不一样。 */
	function renderToolResult(tool, ok, text, images = []) {
		const detail = ok ? toolDetail(tool.name, parseJSON(text)) : "";
		if (detail) {
			const box = document.createElement("div");
			box.className = "detail-wrap";
			box.innerHTML = detail;
			tool.body.appendChild(box);
			for (const img of box.querySelectorAll("img[data-zoom]")) {
				img.addEventListener("click", () => showLightbox(img.src));
			}
			const raw = document.createElement("details");
			raw.className = "raw";
			raw.innerHTML = `<summary>运行日志与原始输出</summary>`;
			raw.appendChild(tool.progress);
			tool.progress.textContent += text ? `${text}\n` : "";
			tool.body.appendChild(raw);
			if (AUTO_OPEN.has(tool.name)) openBody(tool);
		} else if (text) {
			tool.progress.textContent += `${text}\n`;
		}
		for (const image of images) {
			const img = document.createElement("img");
			img.className = "tool-image";
			img.src = image;
			img.addEventListener("click", () => showLightbox(image));
			tool.body.appendChild(img);
			openBody(tool);
		}
	}

	function markToolDone(tool, ok) {
		tool.head.classList.add("done", ok ? "ok" : "bad");
		tool.head.querySelector(".spinner")?.remove();
		tool.head.querySelector(".tick").textContent = ok ? "✓" : "✗";
	}

	function summarizeTool(name, text, ok) {
		const data = parseJSON(text);
		if (!ok) return "失败";
		if (!data) return "完成";
		if (name === "video_build") return data.output ? basename(data.output) : "完成";
		if (name === "video_new") return data.slug || "已创建";
		if (name === "video_qa") return data.failed?.length ? `${data.failed.length} 幕需修正` : `通过 ${data.scenes?.length ?? ""} 幕`;
		if (name === "video_lint") return data.error_count ? `${data.error_count} 个问题` : "无问题";
		if (name === "video_env_check") return data.ok ? "全部就绪" : "有缺失项";
		if (name === "video_report") return data.artifacts?.length ? `${data.artifacts.length} 个产物` : "无产物";
		return data.ok === false ? "有问题" : "完成";
	}

	function parseJSON(text) {
		const raw = String(text ?? "");
		try {
			return JSON.parse(raw);
		} catch {
			/* 输出后面常常还跟一句人话（例如“总览图：/…png”），退一步取中间的 JSON 对象 */
		}
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(raw.slice(start, end + 1));
			} catch {
				return null;
			}
		}
		return null;
	}

	const num = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : (n ?? "—"));
	const fileLink = (p, label) => `<a href="${fileUrl(p)}" target="_blank" rel="noopener">${esc(label || basename(p))}</a>`;
	const detailRow = (key, value, cls = "") =>
		`<div class="detail-row"><span class="k">${esc(key)}</span><span class="v ${cls}">${value}</span></div>`;

	function toolDetail(name, data) {
		if (!data || typeof data !== "object") return "";

		if (name === "video_env_check" && data.checks) {
			const rows = Object.entries(data.checks).map(([key, check]) =>
				detailRow(ENV_LABELS[key] || key, check.ok ? "就绪" : esc(check.path || "缺失"), check.ok ? "ok" : "bad")
			);
			return `<div class="detail">${rows.join("")}</div>`;
		}

		if (name === "video_report") {
			const artifacts = data.artifacts || [];
			const rows = artifacts
				.map(
					(a) =>
						`<li><span>${fileLink(a.path)}</span><span class="badge">${num(a.size_mb)} MB${
							a.duration_sec ? ` · ${num(a.duration_sec)}s` : ""
						}</span></li>`
				)
				.join("");
			const voice = Object.values(data.voiceover_segments || {}).reduce((a, b) => a + (b || 0), 0);
			return `<div class="detail">
				${detailRow("分幕", `${data.scenes?.length ?? 0} 幕`)}
				${detailRow("配音", `${voice} 段`)}
				${detailRow("状态", data.finished ? "已有成片" : "尚未出片", data.finished ? "ok" : "bad")}
				${rows ? `<ul class="detail-list">${rows}</ul>` : `<p class="detail-note">还没有产物</p>`}
			</div>`;
		}

		if (name === "video_build") {
			if (!data.output) return "";
			return `<div class="detail">
				${detailRow("成片", fileLink(data.output))}
				${detailRow("时长", `${num(data.duration_sec)} 秒 · ${num(data.size_mb)} MB`)}
				${detailRow("配音", `${data.voice_tracks ?? 0} 段`)}
				<video class="detail-video" src="${fileUrl(data.output)}#t=2" controls preload="metadata"></video>
			</div>`;
		}

		if (name === "video_qa") {
			const rows = (data.scenes || [])
				.map(
					(s) =>
						`<li><span>${esc(s.scene)}</span><span class="badge ${s.ok ? "ok" : "bad"}">${
							s.ok ? `${num(s.seconds)}s` : "渲染失败"
						}</span></li>`
				)
				.join("");
			const note = data.failed?.length
				? `<p class="detail-note">${data.failed.map((x) => esc(x)).join("、")} 需要调整后重跑质检</p>`
				: "";
			const sheet = data.contact_sheet
				? `<img class="detail-video" src="${fileUrl(data.contact_sheet)}?t=${Date.now()}" alt="质检总览" data-zoom="1" />`
				: "";
			return `<div class="detail">${rows ? `<ul class="detail-list">${rows}</ul>` : ""}${note}${sheet}</div>`;
		}

		if (name === "video_lint") {
			const problems = [];
			for (const r of data.results || []) {
				for (const e of r.errors || []) problems.push(`<li class="bad-text">${esc(r.scene)} · ${esc(e)}</li>`);
				for (const w of r.warnings || []) problems.push(`<li>${esc(r.scene)} · ${esc(w)}</li>`);
			}
			return `<div class="detail">
				${detailRow("分幕", `${data.scene_count ?? 0} 个`)}
				${detailRow("错误", `${data.error_count ?? 0} 个`, data.error_count ? "bad" : "ok")}
				${detailRow("提醒", `${data.warning_count ?? 0} 个`)}
				${
					problems.length
						? `<ul class="detail-list">${problems.slice(0, 8).join("")}</ul>`
						: `<p class="detail-note">没有发现问题</p>`
				}
			</div>`;
		}

		if (name === "video_new") {
			return `<div class="detail">
				${detailRow("项目", esc(data.slug || basename(data.project || "")))}
				${detailRow("主题", esc(data.theme || "—"))}
				${detailRow("文件", `${(data.files || []).length} 个`)}
			</div>`;
		}

		if (name === "video_storyboard" && data.storyboard) {
			return `<div class="detail">${detailRow("故事板", fileLink(data.storyboard, "在浏览器里打开"))}</div>`;
		}

		return "";
	}

	// ------------------------------------------------------------ SSE
	function connect() {
		const source = new EventSource("/api/events");
		source.onmessage = (event) => {
			let payload;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}
			handle(payload);
		};
		source.onerror = () => {
			setStatus("error", "与后台失联，重连中…");
		};
		source.onopen = () => {
			setStatus(state.running ? "busy" : "online", state.running ? "生产中…" : "已就绪");
		};
	}

	function setStatus(kind, text) {
		const box = $("#status");
		box.className = `status ${kind}`;
		$("#status-text").textContent = text;
	}

	function handle(payload) {
		if (payload.t === "text" || payload.t === "assistant_start" || payload.t === "tool_start" || payload.t === "tool_end") {
			state.liveEvents += 1;
		}
		switch (payload.t) {
			case "text": {
				const el = ensureAssistant();
				el.dataset.raw = (el.dataset.raw || "") + payload.v;
				delete el.dataset.mathDone;
				el.innerHTML = `${formatText(el.dataset.raw)}<span class="caret"></span>`;
				scrollToBottom();
				break;
			}
			case "thinking":
				break;
			case "assistant_start":
				state.assistant = null;
				break;
			case "tool_start":
				state.assistant = null;
				toolCard(payload.id, payload.name, payload.args);
				break;
			case "tool_progress": {
				const tool = state.tools.get(payload.id);
				if (tool) {
					tool.progress.textContent += `${payload.v}\n`;
					tool.progress.scrollTop = tool.progress.scrollHeight;
					scrollToBottom();
				}
				break;
			}
			case "tool_end": {
				const tool = state.tools.get(payload.id);
				if (!tool) break;
				markToolDone(tool, payload.ok);
				tool.head.querySelector(".tool-arg").textContent = summarizeTool(tool.name, payload.v, payload.ok);
				renderToolResult(tool, payload.ok, payload.v, payload.images || []);
				if (!payload.ok) openBody(tool);
				scrollToBottom();
				break;
			}
			case "notice":
				notice(payload.v, payload.level);
				if (/no api key/i.test(payload.v)) apiKeyCard();
				break;
			case "error":
				if (/no api key|api key found|未配置/i.test(payload.v)) apiKeyCard();
				else errorNotice(payload.v);
				break;
			case "status":
				state.running = payload.running;
				sendBtn.disabled = false;
				$("#btn-abort").hidden = !payload.running;
				setStatus(payload.running ? "busy" : "online", payload.running ? "生产中…" : "已就绪");
				if (!payload.running) state.assistant = null;
				for (const el of messagesEl.querySelectorAll(".msg-ai")) renderMath(el);
				break;
			case "projects_stale":
				refreshProjects();
				break;
			case "task_start":
				state.busyTask = true;
				renderTaskLog(payload.id, `${payload.cmd} · ${payload.project}`);
				break;
			case "task_progress":
				appendTaskLog(payload.id, payload.v);
				break;
			case "task_end":
				state.busyTask = false;
				finishTaskLog(payload.id, payload);
				refreshProjects();
				if (state.selected) openProject(state.selected, { silent: true });
				break;
			default:
				break;
		}
	}

	// ------------------------------------------------------------ 项目列表
	async function refreshProjects() {
		try {
			const res = await fetch("/api/projects");
			const data = await res.json();
			state.projects = data.projects || [];
			renderProjects();
		} catch {
			/* 忽略 */
		}
	}

	function renderProjects() {
		if (projectCountEl) {
			projectCountEl.textContent = state.projects.length;
		}

		const list = projectSearchQuery
			? state.projects.filter((p) => p.project.toLowerCase().includes(projectSearchQuery))
			: state.projects;

		if (!list.length) {
			projectListEl.innerHTML = `<p class="empty">${projectSearchQuery ? "未找到匹配项目" : "还没有项目"}</p>`;
			return;
		}
		projectListEl.innerHTML = list
			.map((p) => {
				const active = state.selected === p.path ? " active" : "";
				const tag = p.final ? `<span class="tag">🎬 已成片</span>` : `<span class="tag none">📝 制作中</span>`;
				return `<div class="project${active}" data-path="${esc(p.path)}" title="${esc(p.project)}">
					<div class="project-header">
						<span class="project-icon">${p.final ? "🎬" : "📐"}</span>
						<div class="name">${esc(p.project)}</div>
					</div>
					<div class="meta">
						<span class="badge-scenes">${p.scenes} 幕</span>
						${tag}
					</div>
				</div>`;
			})
			.join("");
		for (const el of projectListEl.querySelectorAll(".project")) {
			el.addEventListener("click", () => openProject(el.dataset.path));
		}
	}

	async function openProject(projectPath, options = {}) {
		state.selected = projectPath;
		renderProjects();
		// 把选中的项目写进地址栏，刷新后还停在这儿
		try {
			history.replaceState(null, "", `?project=${encodeURIComponent(projectPath)}`);
		} catch {
			/* 忽略 */
		}
		if (!options.silent) outputEl.innerHTML = `<p class="empty">正在读取产物…</p>`;
		try {
			const res = await fetch(`/api/report?project=${encodeURIComponent(projectPath)}`);
			const data = await res.json();
			renderOutput(projectPath, data);
		} catch (err) {
			outputEl.innerHTML = `<p class="empty">读取失败：${esc(err.message)}</p>`;
		}
	}

	function renderOutput(projectPath, data) {
		const name = basename(projectPath);
		$("#output-title").textContent = name;
		const metaTag = $("#output-meta-tag");
		const artifacts = data.artifacts || [];
		const videos = artifacts.filter((a) => a.path.endsWith(".mp4"));
		const sheet = artifacts.find((a) => a.path.endsWith("contact_sheet.png"));
		const board = artifacts.find((a) => a.path.endsWith(".html"));

		if (metaTag) {
			metaTag.textContent = videos.length ? "已成片 · 1080P" : "制作中";
			metaTag.className = videos.length ? "badge-soft success" : "badge-soft";
		}

		let html = "";
		if (videos.length) {
			const final = videos.find((v) => v.path.includes("voiced")) || videos[0];
			html += `<div class="artifact video-artifact">
				<div class="artifact-head">
					<span class="artifact-icon">🎬</span>
					<h3>成片母带预览</h3>
					<span class="artifact-pill">${final.duration_sec ?? "—"}s · ${final.size_mb} MB</span>
				</div>
				<div class="video-card-body">
					<video id="output-video-player" src="${fileUrl(final.path)}#t=2" controls preload="metadata"></video>
				</div>
				<button class="btn-opencut-open" id="btn-open-editor" data-video="${esc(final.path)}" data-project="${esc(name)}">
					<span class="btn-opencut-icon">✂️</span>
					<span>开启 OpenCut 逐帧编辑 (步进/剪切/贴纸/质检)</span>
				</button>
				<div class="mini-stepper-row">
					<button class="mini-stepper-btn" id="mini-prev-frame" title="精准上一帧 [←]">◀ 上一帧</button>
					<div class="mini-stepper-display">
						<span class="mini-stepper-lbl">TIMECODE</span>
						<span class="mini-stepper-timecode" id="mini-timecode">00:00:00:00</span>
					</div>
					<button class="mini-stepper-btn" id="mini-next-frame" title="精准下一帧 [→]">下一帧 ▶</button>
				</div>
				<div class="artifact-actions">
					<a href="${fileUrl(final.path)}" download class="btn-action-link">⬇ 下载 MP4</a>
					<a href="${fileUrl(final.path)}" target="_blank" rel="noopener" class="btn-action-link">↗ 新窗口打开</a>
					${videos.length > 1 ? `<span class="artifact-extra">另有 ${videos.length - 1} 个预览版本</span>` : ""}
				</div>
			</div>`;
		} else {
			html += `<div class="artifact video-artifact">
				<div class="artifact-head">
					<span class="artifact-icon">🎬</span>
					<h3>成片产物</h3>
				</div>
				<p class="empty">还没有成片。可以让 AI 继续生成，或在下方直接发起构建。</p>
			</div>`;
		}

		html += `<div class="artifact qa-artifact">
			<div class="artifact-head">
				<span class="artifact-icon">🔍</span>
				<h3>排版与视觉质检</h3>
			</div>
			${
				sheet
					? `<div class="artifact-preview-wrap"><img src="${fileUrl(sheet.path)}?t=${Date.now()}" alt="质检总览" data-zoom="1" /></div>`
					: `<p class="empty">暂无质检切片图</p>`
			}
			<div class="artifact-actions">
				<button class="mini" data-run="qa">⚡ 重新质检</button>
				${board ? `<a href="${fileUrl(board.path)}" target="_blank" rel="noopener" class="btn-action-link">📖 打开故事板</a>` : `<button class="mini" data-run="storyboard">生成故事板</button>`}
			</div>
		</div>`;

		html += `<div class="artifact build-artifact">
			<div class="artifact-head">
				<span class="artifact-icon">⚙️</span>
				<h3>渲染与产物控制</h3>
			</div>
			<div class="artifact-actions">
				<button class="mini primary" data-run="build" data-quality="h">🎬 母带渲染 1080p60</button>
				<button class="mini" data-run="build" data-quality="l">⚡ 快速预览 (480p)</button>
				<button class="mini" data-run="lint">🔍 代码检查</button>
			</div>
			<div class="facts">分幕 ${data.scenes?.length ?? 0} 个 · 配音 ${
				Object.values(data.voiceover_segments || {}).reduce((a, b) => a + (b || 0), 0)
			} 段</div>
		</div>`;

		outputEl.innerHTML = html;

		for (const img of outputEl.querySelectorAll("img[data-zoom]")) {
			img.addEventListener("click", () => showLightbox(img.src));
		}
		for (const btn of outputEl.querySelectorAll("button[data-run]")) {
			btn.addEventListener("click", () => runTask(btn.dataset.run, btn.dataset.quality));
		}

		const openEditorBtn = outputEl.querySelector("#btn-open-editor");
		if (openEditorBtn) {
			openEditorBtn.addEventListener("click", () => {
				openFrameEditor(openEditorBtn.dataset.video, openEditorBtn.dataset.project);
			});
		}

		const outVid = outputEl.querySelector("#output-video-player");
		const miniPrev = outputEl.querySelector("#mini-prev-frame");
		const miniNext = outputEl.querySelector("#mini-next-frame");
		const miniTc = outputEl.querySelector("#mini-timecode");
		if (outVid && miniPrev && miniNext) {
			const fps = 60;
			const updateMini = () => {
				if (miniTc) miniTc.textContent = formatSMPTE(outVid.currentTime, fps);
			};
			outVid.addEventListener("timeupdate", updateMini);
			miniPrev.addEventListener("click", () => {
				outVid.pause();
				outVid.currentTime = Math.max(0, outVid.currentTime - 1 / fps);
				updateMini();
			});
			miniNext.addEventListener("click", () => {
				outVid.pause();
				outVid.currentTime = Math.min(outVid.duration || 9999, outVid.currentTime + 1 / fps);
				updateMini();
			});
		}
	}

	// ------------------------------------------------------------ 确定性任务
	async function runTask(cmd, quality) {
		if (!state.selected) return;
		if (state.busyTask) {
			notice("有一个任务正在跑，等它结束再试。", "warning");
			return;
		}
		const res = await fetch("/api/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cmd, project: state.selected, quality: quality || "h", voice: true }),
		});
		const data = await res.json();
		if (!data.ok) notice(data.error || "任务启动失败", "error");
	}

	function renderTaskLog(id, title) {
		const box = document.createElement("div");
		box.className = "artifact";
		box.dataset.task = id;
		box.innerHTML = `<h3>${esc(title)}</h3><div class="task-log"></div>`;
		outputEl.prepend(box);
	}

	function appendTaskLog(id, line) {
		const box = outputEl.querySelector(`[data-task="${id}"] .task-log`);
		if (!box) return;
		box.textContent += `${line}\n`;
		box.scrollTop = box.scrollHeight;
	}

	function finishTaskLog(id, payload) {
		const box = outputEl.querySelector(`[data-task="${id}"] .task-log`);
		if (!box) return;
		box.textContent += payload.ok ? "\n✅ 完成\n" : `\n❌ ${payload.error || "失败"}\n`;
		box.scrollTop = box.scrollHeight;
	}

	// ------------------------------------------------------------ 发送
	async function send() {
		const text = inputEl.value.trim();
		if (!text) return;
		if (!state.modelConfig?.configured) {
			notice("先配置一个模型（填自己的 API Key），再开始制作。", "warning");
			openModelDialog();
			return;
		}
		inputEl.value = "";
		inputEl.style.height = "auto";
		addUser(text);
		state.liveEvents += 1;
		state.assistant = null;
		sendBtn.disabled = true;
		try {
			const res = await fetch("/api/prompt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: text }),
			});
			const data = await res.json();
			if (!data.ok) notice(data.error || "发送失败", "error");
			else if (data.queued) notice("已排队：等当前这一步做完就处理。", "info");
		} catch (err) {
			notice(`发送失败：${err.message}`, "error");
		} finally {
			sendBtn.disabled = false;
			inputEl.focus();
		}
	}

	// ------------------------------------------------------------ 状态
	// ------------------------------------------------------------ 模型配置（BYOK）
	const PRESETS = [
		{ key: "openai", label: "OpenAI", api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
		{ key: "anthropic", label: "Claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
		{ key: "deepseek", label: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" },
		{ key: "moonshot", label: "Kimi", api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" },
		{ key: "zhipu", label: "智谱 GLM", api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
		{ key: "dashscope", label: "通义千问", api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
		{ key: "siliconflow", label: "硅基流动", api: "openai-completions", baseUrl: "https://api.siliconflow.cn/v1" },
		{ key: "openrouter", label: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
		{ key: "gemini", label: "Gemini", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com" },
		{ key: "ollama", label: "本机 Ollama", api: "openai-completions", baseUrl: "http://localhost:11434/v1" },
		{ key: "lmstudio", label: "本机 LM Studio", api: "openai-completions", baseUrl: "http://localhost:1234/v1" },
	];

	const modal = $("#model-modal");
	let metaTouched = false;
	let setupShown = false;

	function setModelStatus(text, kind = "") {
		const box = $("#model-status");
		box.hidden = !text;
		box.className = `model-status ${kind}`;
		box.innerHTML = text;
	}

	function guessFor(id) {
		const s = String(id || "").toLowerCase();
		const big = /claude|gemini|gpt-4\.1|gpt-5|(^|\/)o[1-9]/.test(s);
		return {
			reasoning: /(^|\/)(o[1-9])|gpt-5|thinking|reasoner|qwq|(^|[-/])r1|glm-z1/.test(s),
			images: /gpt-4o|gpt-4\.1|gpt-5|claude|gemini|vl|vision|glm-4v/.test(s),
			contextWindow: /kimi|moonshot/.test(s) ? 256000 : big ? 200000 : 128000,
			maxTokens: big ? 32000 : 8192,
		};
	}

	function applyGuess() {
		const guess = guessFor($("#model-id").value);
		$("#model-images").checked = guess.images;
		$("#model-reasoning").checked = guess.reasoning;
		$("#model-context").value = guess.contextWindow;
		$("#model-maxtokens").value = guess.maxTokens;
	}

	function renderPresets() {
		$("#model-presets").innerHTML =
			PRESETS.map((p) => `<button type="button" class="preset" data-preset="${p.key}">${esc(p.label)}</button>`).join("") +
			`<button type="button" class="preset" data-preset="custom">自定义</button>`;
	}

	async function openModelDialog() {
		// 每次打开都拉一次最新配置，避免显示过期的掩码或模型
		try {
			const res = await fetch("/api/model");
			const data = await res.json();
			if (data.ok && data.config) state.modelConfig = data.config;
		} catch {
			/* 用现有状态兜底 */
		}
		fillModelForm(state.modelConfig || {});
	}

	function fillModelForm(cfg) {
		$("#model-api").value = cfg.api || "openai-completions";
		$("#model-baseurl").value = cfg.baseUrl || "";
		$("#model-id").value = cfg.modelId || "";
		$("#model-name").value = cfg.modelName && cfg.modelName !== cfg.modelId ? cfg.modelName : "";
		$("#model-key").value = "";
		$("#model-key").placeholder = cfg.hasKey ? `已保存 ${cfg.keyMask}，留空表示不改` : "sk-…（地址是本机时可以留空）";
		$("#model-key-hint").textContent = cfg.hasKey ? `当前已保存：${cfg.keyMask}` : "填了才会写到本机，保存后不回显。";
		$("#model-context").value = cfg.contextWindow || "";
		$("#model-maxtokens").value = cfg.maxTokens || "";
		$("#model-images").checked = Boolean(cfg.images);
		$("#model-reasoning").checked = Boolean(cfg.reasoning);
		$("#model-thinking").value = cfg.thinking || "medium";
		metaTouched = Boolean(cfg.configured);
		renderPresets();
		setModelStatus("");
		modal.hidden = false;
		$("#model-baseurl").focus();
	}

	function closeModelDialog() {
		modal.hidden = true;
	}

	function collectModel() {
		const key = $("#model-key").value.trim();
		const contextWindow = Number($("#model-context").value);
		const maxTokens = Number($("#model-maxtokens").value);
		return {
			provider: state.modelConfig?.provider || "byok",
			api: $("#model-api").value,
			baseUrl: $("#model-baseurl").value.trim(),
			apiKey: key || undefined,
			modelId: $("#model-id").value.trim(),
			displayName: $("#model-name").value.trim(),
			contextWindow: contextWindow > 0 ? contextWindow : undefined,
			maxTokens: maxTokens > 0 ? maxTokens : undefined,
			images: $("#model-images").checked,
			reasoning: $("#model-reasoning").checked,
			thinking: $("#model-thinking").value,
		};
	}

	async function discoverModelList() {
		const body = collectModel();
		if (!body.baseUrl) return setModelStatus("先填 API 地址。", "bad");
		const btn = $("#model-discover");
		btn.disabled = true;
		setModelStatus("正在拉取模型列表…");
		try {
			const res = await fetch("/api/model/discover", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ api: body.api, baseUrl: body.baseUrl, apiKey: body.apiKey }),
			});
			const data = await res.json();
			if (!data.ok) return setModelStatus(esc(data.error || "拉取失败"), "bad");
			$("#model-options").innerHTML = data.models.map((m) => `<option value="${esc(m.id)}"></option>`).join("");
			if (!$("#model-id").value.trim()) {
				$("#model-id").value = data.models[0].id;
				if (!metaTouched) applyGuess();
			}
			const hinted = data.models[0].contextWindow;
			if (hinted && !$("#model-context").value) $("#model-context").value = hinted;
			setModelStatus(`拉到 ${data.models.length} 个模型，在「模型」输入框里点一下就能挑。`, "ok");
		} catch (err) {
			setModelStatus(`拉取失败：${esc(err.message)}`, "bad");
		} finally {
			btn.disabled = false;
		}
	}

	async function saveModel() {
		const btn = $("#model-save");
		btn.disabled = true;
		setModelStatus("正在写入配置，重启模型连接…");
		try {
			const res = await fetch("/api/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(collectModel()),
			});
			const data = await res.json();
			if (!data.ok) return setModelStatus(esc(data.error || "保存失败"), "bad");
			state.modelConfig = data.config;
			const name = data.model?.name || data.model?.id || data.config.modelId;
			setModelStatus(`已生效：${esc(name)}${data.warning ? `<br>注意：${esc(data.warning)}` : ""}`, "ok");
			notice(`模型已切换为 ${name}。`, "info");
			await loadStatus();
			setTimeout(() => {
				if (!modal.hidden) closeModelDialog();
			}, 900);
		} catch (err) {
			setModelStatus(`保存失败：${esc(err.message)}`, "bad");
		} finally {
			btn.disabled = false;
		}
	}

	async function importModel() {
		setModelStatus("正在读取本机 Pi 配置…");
		try {
			const res = await fetch("/api/model/import", { method: "POST" });
			const data = await res.json();
			if (!data.ok) return setModelStatus(esc(data.error || "导入失败"), "bad");
			state.modelConfig = data.config;
			setModelStatus(`已导入：${esc(data.config.provider)} / ${esc(data.config.modelId)}`, "ok");
			notice("已沿用本机 Pi 里的模型配置。", "info");
			await loadStatus();
		} catch (err) {
			setModelStatus(`导入失败：${esc(err.message)}`, "bad");
		}
	}

	async function clearModel() {
		if (!window.confirm("清空工作台的模型配置？（只影响工作台，不动你的 ~/.pi）")) return;
		try {
			const res = await fetch("/api/model", { method: "DELETE" });
			const data = await res.json();
			if (!data.ok) return setModelStatus(esc(data.error || "清空失败"), "bad");
			state.modelConfig = data.config;
			setModelStatus("已清空，填一个 Key 就能重新开始。");
			notice("模型配置已清空。", "warning");
			await loadStatus();
		} catch (err) {
			setModelStatus(`清空失败：${esc(err.message)}`, "bad");
		}
	}

	function modelSetupCard() {
		const div = document.createElement("div");
		div.className = "notice setup";
		div.innerHTML =
			`<b>先配置一个模型（BYOK）</b>` +
			`这是自带 Key 的工作台：填你自己的 API Key 就行 —— OpenAI、Claude、DeepSeek、Kimi、通义、智谱、` +
			`OpenRouter，或者本机的 Ollama / LM Studio。Key 只写在你自己的电脑上。`;
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = "去配置模型";
		btn.addEventListener("click", openModelDialog);
		div.appendChild(btn);
		messagesEl.appendChild(div);
		scrollToBottom(true);
	}

	/** 刷新页面时把「正在跑的任务」也找回来，别让用户以为任务丢了。 */
	async function syncTasks() {
		try {
			const res = await fetch("/api/tasks");
			const data = await res.json();
			const tasks = data.tasks || [];
			state.busyTask = tasks.length > 0;
			for (const task of tasks) {
				if (!outputEl.querySelector(`[data-task="${task.id}"]`)) {
					renderTaskLog(task.id, `${task.cmd} · ${task.name}`);
				}
			}
		} catch {
			/* 忽略 */
		}
	}

	async function loadStatus() {
		try {
			const res = await fetch("/api/status");
			const data = await res.json();
			const cfg = data.modelConfig || {};
			state.modelConfig = cfg;
			const model = data.model ? `${data.model.name || data.model.id} · ${data.model.provider}` : "未选择模型";
			$("#model-name").textContent = model;
			if (!cfg.configured) {
				setStatus("error", "未配置模型");
				$("#model-name").textContent = "BYOK · 点右上「⚙ 模型」填 Key";
				if (!setupShown) {
					setupShown = true;
					modelSetupCard();
					openModelDialog();
				}
			} else {
				setStatus(data.pi.ready ? (data.pi.busy ? "busy" : "online") : "error",
					data.pi.ready ? (data.pi.busy ? "生产中…" : "已就绪") : "后台未就绪");
			}
			state.running = !!data.pi.busy;
			$("#btn-abort").hidden = !state.running;
			const ok = (v) => (v ? `<b>就绪</b>` : `<i>缺失</i>`);
			$("#env-info").innerHTML =
				`技能仓库 ${ok(data.skillRoot)}<br>` +
				`<span style="opacity:.7">${esc(data.skillRoot)}</span><br>` +
				`Python ${ok(data.python)}`;
		} catch {
			setStatus("error", "无法连接后台");
		}
	}

	// ------------------------------------------------------------ 事件绑定
	$("#btn-model").addEventListener("click", openModelDialog);
	$("#model-close").addEventListener("click", closeModelDialog);
	$("#model-discover").addEventListener("click", discoverModelList);
	$("#model-save").addEventListener("click", saveModel);
	$("#model-import").addEventListener("click", importModel);
	$("#model-clear").addEventListener("click", clearModel);
	modal.addEventListener("click", (e) => {
		if (e.target === modal) closeModelDialog();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !modal.hidden) closeModelDialog();
	});
	$("#model-presets").addEventListener("click", (e) => {
		const btn = e.target.closest("button[data-preset]");
		if (!btn) return;
		for (const el of $("#model-presets").querySelectorAll(".preset")) el.classList.remove("active");
		btn.classList.add("active");
		if (btn.dataset.preset === "custom") {
			$("#model-baseurl").focus();
			return;
		}
		const preset = PRESETS.find((p) => p.key === btn.dataset.preset);
		if (!preset) return;
		$("#model-api").value = preset.api;
		$("#model-baseurl").value = preset.baseUrl;
		$("#model-id").value = "";
		$("#model-options").innerHTML = "";
		metaTouched = false;
		setModelStatus(`已填入 ${preset.label} 的地址，点「拉取模型列表」或直接填模型 ID。`);
	});
	$("#model-id").addEventListener("input", () => {
		if (!metaTouched) applyGuess();
	});
	for (const id of ["#model-images", "#model-reasoning"]) {
		$(id).addEventListener("change", () => {
			metaTouched = true;
		});
	}

	$("#composer").addEventListener("submit", (e) => {
		e.preventDefault();
		send();
	});
	inputEl.addEventListener("input", () => {
		inputEl.style.height = "auto";
		inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
	});
	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	});
	chipsEl.addEventListener("click", (e) => {
		const btn = e.target.closest("button[data-topic]");
		if (!btn) return;
		inputEl.value = btn.dataset.topic;
		inputEl.focus();
	});
	$("#btn-new").addEventListener("click", async () => {
		await fetch("/api/new-session", { method: "POST" });
		messagesEl.innerHTML = "";
		state.assistant = null;
		state.tools.clear();
		emptyState();
		notice("已开始新对话。", "info");
	});
	// ============================================================
	// OpenCut 逐帧视频编辑器 (Frame-by-Frame Video Editor Engine)
	// ============================================================
	function formatSMPTE(seconds, fps = 60) {
		if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
		const rate = Math.max(1, Math.round(fps));
		const totalFrames = Math.floor(seconds * rate + 0.0001);
		const ff = totalFrames % rate;
		const totalSec = Math.floor(totalFrames / rate);
		const ss = totalSec % 60;
		const mm = Math.floor(totalSec / 60) % 60;
		const hh = Math.floor(totalSec / 3600);
		const pad2 = (n) => String(n).padStart(2, "0");
		return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
	}

	function parseSMPTE(str, fps = 60) {
		const rate = Math.max(1, Math.round(fps));
		if (!str || typeof str !== "string") return 0;
		const trimmed = str.trim();
		if (/^\d+$/.test(trimmed)) {
			return Number.parseInt(trimmed, 10) / rate;
		}
		const parts = trimmed.split(":").map((p) => Number.parseFloat(p));
		if (parts.some((p) => Number.isNaN(p))) return 0;
		if (parts.length === 4) {
			return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / rate;
		}
		if (parts.length === 3) {
			return parts[0] * 60 + parts[1] + parts[2] / rate;
		}
		if (parts.length === 2) {
			return parts[0] + parts[1] / rate;
		}
		return Number.parseFloat(trimmed) || 0;
	}

	const ve = {
		modal: $("#video-editor-modal"),
		video: $("#ve-video"),
		projectName: $("#ve-project-name"),
		resolutionTag: $("#ve-resolution"),
		timecodeInput: $("#ve-timecode-input"),
		currentFrameEl: $("#ve-current-frame"),
		totalFramesEl: $("#ve-total-frames"),
		hudTimecode: $("#ve-hud-timecode"),
		hudFps: $("#ve-hud-fps"),
		speedSelect: $("#ve-speed-select"),
		playBtn: $("#ve-btn-play"),
		zoomSlider: $("#ve-zoom-slider"),
		rulerCanvas: $("#ve-ruler-canvas"),
		rulerContainer: $("#ve-ruler-container"),
		trackContainer: $("#ve-track-container"),
		filmstrip: $("#ve-filmstrip"),
		rangeHighlight: $("#ve-range-highlight"),
		rangeInfo: $("#ve-range-info"),
		splitMarkers: $("#ve-split-markers"),
		playhead: $("#ve-playhead"),
		playheadBadge: $("#ve-playhead-badge"),
		hoverIndicator: $("#ve-hover-indicator"),
		hoverTooltip: $("#ve-hover-tooltip"),
		clipsList: $("#ve-clips-list"),
		clipCount: $("#ve-clip-count"),
		snapshotsList: $("#ve-snapshots-list"),
		snapCount: $("#ve-snap-count"),
		annotateCanvas: $("#ve-annotate-canvas"),
		annotateToolbar: $("#ve-annotate-toolbar"),
		btnAnnotate: $("#ve-btn-annotate"),

		// Stickers DOM
		stickerLayer: $("#ve-sticker-layer"),
		stickerTrackBar: $("#ve-sticker-track-bar"),
		stickersList: $("#ve-stickers-list"),
		stickerCount: $("#ve-sticker-count"),
		stickerPickerModal: $("#ve-sticker-picker-modal"),
		stickerGrid: $("#ve-sticker-grid"),
		stickerDropzone: $("#ve-sticker-dropzone"),
		stickerFileInput: $("#ve-sticker-file-input"),
		stickerDurationSelect: $("#ve-sticker-default-duration"),

		// State
		activeVideoPath: null,
		activeProject: null,
		fps: 60,
		duration: 0,
		totalFrames: 0,
		zoom: 1.0,
		inPoint: null,
		outPoint: null,
		splits: [],
		clips: [],
		snapshots: [],
		stickers: [],
		selectedStickerId: null,
		isDraggingPlayhead: false,
		isAnnotating: false,
		isDrawing: false,
		annotateCtx: null,
		filmstripAbort: null,
	};

	async function openFrameEditor(videoPath, projectName) {
		ve.activeVideoPath = videoPath;
		ve.activeProject = projectName;
		ve.projectName.textContent = projectName || basename(videoPath);
		ve.inPoint = null;
		ve.outPoint = null;
		ve.splits = [];
		ve.clips = [];
		ve.snapshots = [];
		ve.stickers = [];
		ve.selectedStickerId = null;
		ve.stickerCount.textContent = "0";
		ve.stickerLayer.innerHTML = "";
		ve.stickerTrackBar.innerHTML = "";
		ve.renderStickersSidebar();
		ve.zoom = 1.0;
		ve.zoomSlider.value = "1";
		ve.isAnnotating = false;
		ve.annotateCanvas.hidden = true;
		ve.annotateToolbar.hidden = true;
		ve.btnAnnotate.classList.remove("active");
		ve.rangeHighlight.hidden = true;
		ve.splitMarkers.innerHTML = "";
		ve.filmstrip.innerHTML = "";
		ve.modal.hidden = false;
		document.body.style.overflow = "hidden";

		// Probe video metadata from server
		let meta = null;
		try {
			const res = await fetch(`/api/video/probe?path=${encodeURIComponent(videoPath)}`);
			meta = await res.json();
		} catch {
			meta = null;
		}

		ve.fps = meta?.fps || 60;
		ve.hudFps.textContent = `${ve.fps} FPS`;
		ve.resolutionTag.textContent = `${meta?.width || 1920}×${meta?.height || 1080} · ${ve.fps} FPS`;

		ve.video.src = fileUrl(videoPath);
		ve.video.currentTime = 0;

		const onMeta = () => {
			ve.duration = ve.video.duration || meta?.duration || 1;
			ve.totalFrames = meta?.nb_frames || Math.round(ve.duration * ve.fps);
			ve.totalFramesEl.textContent = ve.totalFrames;
			ve.rebuildClips();
			ve.drawRuler();
			ve.updatePlayheadUI();
			ve.updateStickerLayerBounds();
			ve.renderStickerTrack();
			ve.generateFilmstrip();
		};

		if (ve.video.readyState >= 1) {
			onMeta();
		} else {
			ve.video.addEventListener("loadedmetadata", onMeta, { once: true });
		}
	}

	function closeFrameEditor() {
		ve.video.pause();
		if (ve.filmstripAbort) {
			ve.filmstripAbort();
			ve.filmstripAbort = null;
		}
		ve.modal.hidden = true;
		document.body.style.overflow = "";
	}

	ve.seekFrame = function (targetTime) {
		if (!Number.isFinite(targetTime)) return;
		const clamped = Math.max(0, Math.min(ve.duration, targetTime));
		ve.video.currentTime = clamped;
		ve.updatePlayheadUI();
	};

	ve.stepFrame = function (deltaFrames) {
		ve.video.pause();
		ve.playBtn.textContent = "▶ 播放";
		const currentSec = ve.video.currentTime;
		const curFrame = Math.round(currentSec * ve.fps);
		const targetFrame = Math.max(0, Math.min(ve.totalFrames - 1, curFrame + deltaFrames));
		ve.seekFrame((targetFrame + 0.0001) / ve.fps);
	};

	ve.updatePlayheadUI = function () {
		const curTime = ve.video.currentTime || 0;
		const curFrame = Math.min(ve.totalFrames, Math.round(curTime * ve.fps));
		const timecode = formatSMPTE(curTime, ve.fps);

		ve.timecodeInput.value = timecode;
		ve.currentFrameEl.textContent = curFrame;
		ve.hudTimecode.textContent = timecode;
		ve.playheadBadge.textContent = timecode;

		const percent = ve.duration > 0 ? (curTime / ve.duration) * 100 : 0;
		ve.playhead.style.left = `${Math.min(100, Math.max(0, percent))}%`;

		// Update range highlight if set
		if (ve.inPoint !== null && ve.outPoint !== null && ve.outPoint > ve.inPoint) {
			ve.rangeHighlight.hidden = false;
			const inPct = (ve.inPoint / ve.duration) * 100;
			const outPct = (ve.outPoint / ve.duration) * 100;
			ve.rangeHighlight.style.left = `${inPct}%`;
			ve.rangeHighlight.style.width = `${Math.max(0.5, outPct - inPct)}%`;
			const rangeFrames = Math.round((ve.outPoint - ve.inPoint) * ve.fps);
			ve.rangeInfo.textContent = `${(ve.outPoint - ve.inPoint).toFixed(2)}s (${rangeFrames}帧)`;
		} else {
			ve.rangeHighlight.hidden = true;
		}

		ve.updateStickersVisibility();
	};

	ve.drawRuler = function () {
		const canvas = ve.rulerCanvas;
		const container = ve.rulerContainer;
		const width = container.clientWidth;
		const height = container.clientHeight;
		const dpr = window.devicePixelRatio || 1;

		canvas.width = width * dpr;
		canvas.height = height * dpr;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		const ctx = canvas.getContext("2d");
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, width, height);

		if (!ve.duration || ve.duration <= 0) return;

		// Calculate tick steps based on zoom and duration
		const pixelsPerSec = (width / ve.duration) * ve.zoom;
		let majorSec = 1;
		let minorSec = 0.2;
		if (pixelsPerSec < 20) {
			majorSec = 10;
			minorSec = 2;
		} else if (pixelsPerSec < 50) {
			majorSec = 5;
			minorSec = 1;
		} else if (pixelsPerSec < 120) {
			majorSec = 2;
			minorSec = 0.5;
		} else if (pixelsPerSec < 300) {
			majorSec = 1;
			minorSec = 0.2;
		} else {
			majorSec = 0.5;
			minorSec = 1 / ve.fps; // Frame-level precision tick!
		}

		ctx.fillStyle = "#181c24";
		ctx.fillRect(0, 0, width, height);

		ctx.font = '10px "SF Mono", Monaco, Consolas, monospace';
		ctx.textBaseline = "middle";

		// Draw ticks
		const totalTicks = Math.ceil(ve.duration / minorSec) + 1;
		for (let i = 0; i <= totalTicks; i++) {
			const time = i * minorSec;
			if (time > ve.duration) break;
			const x = (time / ve.duration) * width;
			const isMajor = Math.abs(Math.round(time / majorSec) * majorSec - time) < 0.001;

			if (isMajor) {
				ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
				ctx.beginPath();
				ctx.moveTo(x, height - 12);
				ctx.lineTo(x, height);
				ctx.stroke();

				ctx.fillStyle = "#9aa2b1";
				const label = formatSMPTE(time, ve.fps).slice(3, 8); // MM:SS
				ctx.fillText(label, Math.max(2, Math.min(width - 34, x + 3)), height / 2 - 2);
			} else {
				ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
				ctx.beginPath();
				ctx.moveTo(x, height - 6);
				ctx.lineTo(x, height);
				ctx.stroke();
			}
		}
	};

	ve.generateFilmstrip = function () {
		if (ve.filmstripAbort) {
			ve.filmstripAbort();
			ve.filmstripAbort = null;
		}
		ve.filmstrip.innerHTML = "";
		if (!ve.duration || ve.duration <= 0) return;

		let cancelled = false;
		ve.filmstripAbort = () => {
			cancelled = true;
		};

		const numThumbs = Math.max(10, Math.min(24, Math.floor(ve.trackContainer.clientWidth / 65)));
		const step = ve.duration / numThumbs;
		const offscreenVid = document.createElement("video");
		offscreenVid.src = ve.video.src;
		offscreenVid.preload = "auto";
		offscreenVid.muted = true;
		offscreenVid.playsInline = true;

		const offCanvas = document.createElement("canvas");
		offCanvas.width = 120;
		offCanvas.height = 68;
		const offCtx = offCanvas.getContext("2d");

		let idx = 0;
		const grabNext = () => {
			if (cancelled || idx >= numThumbs) return;
			const targetSec = idx * step + step * 0.1;
			offscreenVid.currentTime = targetSec;
		};

		offscreenVid.addEventListener("seeked", () => {
			if (cancelled) return;
			try {
				offCtx.drawImage(offscreenVid, 0, 0, 120, 68);
				const img = document.createElement("img");
				img.className = "filmstrip-thumb";
				img.src = offCanvas.toDataURL("image/jpeg", 0.65);
				const curTime = idx * step;
				img.title = `跳转到 ${formatSMPTE(curTime, ve.fps)}`;
				img.addEventListener("click", (e) => {
					e.stopPropagation();
					ve.seekFrame(curTime);
				});
				ve.filmstrip.appendChild(img);
			} catch {}
			idx++;
			grabNext();
		});

		offscreenVid.addEventListener("loadeddata", () => {
			grabNext();
		});
	};

	ve.markIn = function () {
		ve.inPoint = ve.video.currentTime;
		if (ve.outPoint !== null && ve.outPoint <= ve.inPoint) {
			ve.outPoint = Math.min(ve.duration, ve.inPoint + 1);
		}
		ve.updatePlayheadUI();
		notice(`已设置入点 (In): ${formatSMPTE(ve.inPoint, ve.fps)}`, "info");
	};

	ve.markOut = function () {
		ve.outPoint = ve.video.currentTime;
		if (ve.inPoint !== null && ve.inPoint >= ve.outPoint) {
			ve.inPoint = Math.max(0, ve.outPoint - 1);
		}
		ve.updatePlayheadUI();
		notice(`已设置出点 (Out): ${formatSMPTE(ve.outPoint, ve.fps)}`, "info");
	};

	ve.clearRange = function () {
		ve.inPoint = null;
		ve.outPoint = null;
		ve.updatePlayheadUI();
		notice("已重置出入点选区", "info");
	};

	ve.splitAtPlayhead = function () {
		const curTime = Math.round(ve.video.currentTime * 100) / 100;
		if (curTime <= 0.2 || curTime >= ve.duration - 0.2) {
			notice("切分点过近片头或片尾", "warning");
			return;
		}
		if (ve.splits.some((s) => Math.abs(s - curTime) < 0.2)) {
			notice("该时间点附近已有切分点", "warning");
			return;
		}
		ve.splits.push(curTime);
		ve.splits.sort((a, b) => a - b);
		ve.rebuildClips();
		ve.renderSplitMarkers();
		notice(`在 ${formatSMPTE(curTime, ve.fps)} 切分视频`, "info");
	};

	ve.renderSplitMarkers = function () {
		ve.splitMarkers.innerHTML = "";
		for (const s of ve.splits) {
			const line = document.createElement("div");
			line.className = "split-line";
			line.style.left = `${(s / ve.duration) * 100}%`;
			line.title = `切分点: ${formatSMPTE(s, ve.fps)}`;
			ve.splitMarkers.appendChild(line);
		}
	};

	ve.rebuildClips = function () {
		const points = [0, ...ve.splits, ve.duration];
		ve.clips = [];
		for (let i = 0; i < points.length - 1; i++) {
			ve.clips.push({
				id: `clip_${i + 1}`,
				name: `片段 ${i + 1}`,
				start: points[i],
				end: points[i + 1],
				duration: points[i + 1] - points[i],
			});
		}
		ve.clipCount.textContent = ve.clips.length;
		ve.renderClips();
	};

	ve.renderClips = function () {
		ve.clipsList.innerHTML = "";
		ve.clips.forEach((clip, index) => {
			const card = document.createElement("div");
			card.className = "clip-card";
			const startTc = formatSMPTE(clip.start, ve.fps);
			const endTc = formatSMPTE(clip.end, ve.fps);
			card.innerHTML = `
				<div class="clip-card-header">
					<span>${esc(clip.name)}</span>
					<span class="clip-duration">${clip.duration.toFixed(2)}s</span>
				</div>
				<div class="clip-card-range">${startTc} ~ ${endTc}</div>
				<div class="clip-card-actions">
					<button class="clip-btn" data-act="play">▶ 播放</button>
					<button class="clip-btn" data-act="export">✂️ 导出</button>
					${ve.splits.length > 0 && index < ve.splits.length ? '<button class="clip-btn danger" data-act="del">✕ 删切点</button>' : ""}
				</div>
			`;

			card.querySelector('[data-act="play"]').addEventListener("click", (e) => {
				e.stopPropagation();
				ve.seekFrame(clip.start);
				ve.video.play();
				const checkEnd = () => {
					if (ve.video.currentTime >= clip.end) {
						ve.video.pause();
						ve.video.removeEventListener("timeupdate", checkEnd);
					}
				};
				ve.video.addEventListener("timeupdate", checkEnd);
			});

			card.querySelector('[data-act="export"]').addEventListener("click", (e) => {
				e.stopPropagation();
				ve.exportClip(clip.start, clip.end, `${ve.activeProject}_${clip.name}.mp4`);
			});

			const delBtn = card.querySelector('[data-act="del"]');
			if (delBtn) {
				delBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					ve.splits.splice(index, 1);
					ve.rebuildClips();
					ve.renderSplitMarkers();
				});
			}

			card.addEventListener("click", () => {
				ve.seekFrame(clip.start);
			});
			ve.clipsList.appendChild(card);
		});
	};

	ve.freezeFrame = function () {
		const curTime = ve.video.currentTime;
		const curFrame = Math.round(curTime * ve.fps);
		const tc = formatSMPTE(curTime, ve.fps);

		const capCanvas = document.createElement("canvas");
		capCanvas.width = ve.video.videoWidth || 1920;
		capCanvas.height = ve.video.videoHeight || 1080;
		const capCtx = capCanvas.getContext("2d");

		// Draw video frame
		capCtx.drawImage(ve.video, 0, 0, capCanvas.width, capCanvas.height);

		// If annotations present, overlay them
		if (ve.isAnnotating && ve.annotateCanvas) {
			capCtx.drawImage(ve.annotateCanvas, 0, 0, capCanvas.width, capCanvas.height);
		}

		// Composite visible stickers onto freeze frame
		if (ve.stickers && ve.stickers.length > 0) {
			const videoW = capCanvas.width;
			const videoH = capCanvas.height;
			const previewW = ve.stickerLayer.clientWidth || videoW;
			const previewH = ve.stickerLayer.clientHeight || videoH;
			const scaleX = videoW / previewW;
			const scaleY = videoH / previewH;

			for (const stk of ve.stickers) {
				if (curTime >= stk.startTime && curTime <= stk.endTime) {
					capCtx.save();
					const centerX = (stk.x + stk.width / 2) * scaleX;
					const centerY = (stk.y + stk.height / 2) * scaleY;
					capCtx.translate(centerX, centerY);
					capCtx.rotate((stk.rotation * Math.PI) / 180);

					const destW = stk.width * scaleX;
					const destH = stk.height * scaleY;
					if (stk.type === "image" && stk.imgElement) {
						capCtx.drawImage(stk.imgElement, -destW / 2, -destH / 2, destW, destH);
					} else {
						capCtx.font = `${Math.round(44 * Math.min(scaleX, scaleY))}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
						capCtx.textAlign = "center";
						capCtx.textBaseline = "middle";
						capCtx.fillText(stk.content, 0, 0);
					}
					capCtx.restore();
				}
			}
		}

		const dataUrl = capCanvas.toDataURL("image/png");
		const snapObj = {
			id: `snap_${Date.now()}`,
			time: curTime,
			frame: curFrame,
			timecode: tc,
			dataUrl,
		};
		ve.snapshots.unshift(snapObj);
		ve.snapCount.textContent = ve.snapshots.length;
		ve.renderSnapshots();

		// Also auto-switch to snapshots tab
		document.querySelector('.sidebar-tab[data-tab="snapshots"]')?.click();
		notice(`已定格抓取第 ${curFrame} 帧（${tc}）超清快照（含贴纸与标注）`, "success");
	};

	ve.renderSnapshots = function () {
		if (ve.snapshots.length === 0) {
			ve.snapshotsList.innerHTML = `<p class="empty-hint">点击「❄️ 定格帧抓取」捕获当前帧高分辨率静止图（含贴纸与标注），可直接下载或发给 AI 质检。</p>`;
			return;
		}
		ve.snapshotsList.innerHTML = "";
		ve.snapshots.forEach((snap) => {
			const card = document.createElement("div");
			card.className = "snapshot-card";
			card.innerHTML = `
				<img class="snapshot-thumb" src="${snap.dataUrl}" alt="快照 ${snap.timecode}" />
				<div class="snapshot-meta">
					<span class="snapshot-timecode">${snap.timecode}</span>
					<span>第 ${snap.frame} 帧</span>
				</div>
				<div class="snapshot-actions">
					<button class="snap-btn dl" data-act="dl">⬇️ 下载图片</button>
					<button class="snap-btn ai" data-act="ai">💬 发送给 AI 修正</button>
				</div>
			`;

			card.querySelector(".snapshot-thumb").addEventListener("click", () => {
				showLightbox(snap.dataUrl);
			});

			card.querySelector('[data-act="dl"]').addEventListener("click", () => {
				const a = document.createElement("a");
				a.href = snap.dataUrl;
				a.download = `${ve.activeProject}_frame_${snap.frame}_${snap.timecode.replace(/:/g, "-")}.png`;
				a.click();
			});

			card.querySelector('[data-act="ai"]').addEventListener("click", () => {
				ve.sendFrameToAI(snap.timecode, snap.frame);
			});

			ve.snapshotsList.appendChild(card);
		});
	};

	ve.sendFrameToAI = function (timecode, frameNumber) {
		const prj = ve.activeProject || basename(ve.activeVideoPath || "");
		const promptText = `【逐帧质检反馈】请针对项目「${prj}」在时间点 ${timecode}（第 ${frameNumber} 帧）处的 Manim 动画排版进行修正：\n- 问题描述：\n- 期望调整方案：`;
		closeFrameEditor();
		inputEl.value = promptText;
		inputEl.focus();
		inputEl.selectionStart = promptText.indexOf("问题描述：") + "问题描述：".length;
		inputEl.selectionEnd = inputEl.selectionStart;
		inputEl.dispatchEvent(new Event("input"));
		notice("已将该帧信息填入对话框，请补充修改要求后发送给智能体。", "info");
	};

	ve.exportClip = async function (startTime, endTime, customName) {
		if (!ve.activeVideoPath) return;
		notice("正在通过后台引擎高精度裁剪视频片段…", "info");
		try {
			const res = await fetch("/api/video/cut", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: ve.activeVideoPath,
					startTime: startTime ?? (ve.inPoint || 0),
					endTime: endTime ?? (ve.outPoint || ve.duration),
					outName: customName,
				}),
			});
			const data = await res.json();
			if (data.ok) {
				notice(`裁剪导出成功！产物已就绪：${data.filename}`, "success");
				// Trigger download
				const a = document.createElement("a");
				a.href = fileUrl(data.path);
				a.download = data.filename;
				a.click();
			} else {
				notice(`导出失败：${data.error || "未知错误"}`, "error");
			}
		} catch (err) {
			notice(`导出网络异常：${err.message}`, "error");
		}
	};

	ve.toggleAnnotate = function () {
		ve.isAnnotating = !ve.isAnnotating;
		ve.video.pause();
		ve.playBtn.textContent = "▶ 播放";
		ve.annotateCanvas.hidden = !ve.isAnnotating;
		ve.annotateToolbar.hidden = !ve.isAnnotating;
		ve.btnAnnotate.classList.toggle("active", ve.isAnnotating);

		if (ve.isAnnotating) {
			const rect = ve.video.getBoundingClientRect();
			ve.annotateCanvas.width = rect.width;
			ve.annotateCanvas.height = rect.height;
			ve.annotateCanvas.style.width = `${rect.width}px`;
			ve.annotateCanvas.style.height = `${rect.height}px`;
			ve.annotateCtx = ve.annotateCanvas.getContext("2d");
			ve.annotateCtx.strokeStyle = "#ff4757";
			ve.annotateCtx.lineWidth = 3;
			ve.annotateCtx.lineCap = "round";
			ve.annotateCtx.lineJoin = "round";
		}
	};

	// ------------------------------------------------------------ 贴纸系统 (Sticker System)
	const STICKER_PRESETS = {
		math: [
			{ icon: "π", label: "Pi", type: "text" },
			{ icon: "∑", label: "Sigma", type: "text" },
			{ icon: "∫", label: "积分", type: "text" },
			{ icon: "∞", label: "无穷大", type: "text" },
			{ icon: "√x", label: "根号", type: "text" },
			{ icon: "Δ", label: "Delta", type: "text" },
			{ icon: "θ", label: "Theta", type: "text" },
			{ icon: "α", label: "Alpha", type: "text" },
			{ icon: "β", label: "Beta", type: "text" },
			{ icon: "λ", label: "Lambda", type: "text" },
			{ icon: "≈", label: "约等于", type: "text" },
			{ icon: "≠", label: "不等于", type: "text" },
			{ icon: "≤", label: "小于等于", type: "text" },
			{ icon: "≥", label: "大于等于", type: "text" },
			{ icon: "±", label: "正负号", type: "text" },
			{ icon: "∈", label: "属于", type: "text" },
			{ icon: "⊂", label: "子集", type: "text" },
			{ icon: "⊥", label: "垂直", type: "text" },
			{ icon: "∠", label: "几何角", type: "text" },
			{ icon: "∵", label: "因为", type: "text" },
			{ icon: "∴", label: "所以", type: "text" },
		],
		pointer: [
			{ icon: "➔", label: "红色箭头", type: "text" },
			{ icon: "⬅️", label: "向左箭头", type: "text" },
			{ icon: "⬆️", label: "向上箭头", type: "text" },
			{ icon: "⬇️", label: "向下箭头", type: "text" },
			{ icon: "🔍", label: "局部放大", type: "text" },
			{ icon: "💭", label: "思考", type: "text" },
			{ icon: "💡", label: "灵感核心", type: "text" },
			{ icon: "❓", label: "疑问思考", type: "text" },
			{ icon: "❗️", label: "高能提示", type: "text" },
			{ icon: "⚡", label: "关键转化", type: "text" },
			{ icon: "🎯", label: "核心结论", type: "text" },
			{ icon: "✅", label: "证明成立", type: "text" },
			{ icon: "❌", label: "反例排除", type: "text" },
			{ icon: "⚠️", label: "易错陷阱", type: "text" },
			{ icon: "👉", label: "注意右侧", type: "text" },
			{ icon: "👆", label: "注意上方", type: "text" },
		],
		badge: [
			{ icon: "⭐", label: "重点星标", type: "text" },
			{ icon: "🔥", label: "高频考点", type: "text" },
			{ icon: "💯", label: "完美推导", type: "text" },
			{ icon: "🎓", label: "数学家说", type: "text" },
			{ icon: "🏆", label: "经典定理", type: "text" },
			{ icon: "🚀", label: "降维突破", type: "text" },
			{ icon: "👏", label: "精彩证明", type: "text" },
			{ icon: "🧐", label: "仔细观察", type: "text" },
			{ icon: "🤓", label: "严谨求证", type: "text" },
			{ icon: "🤩", label: "数学之美", type: "text" },
			{ icon: "✨", label: "顿悟瞬间", type: "text" },
			{ icon: "🏷️", label: "核心概念", type: "text" },
		],
	};

	ve.updateStickerLayerBounds = function () {
		const v = ve.video;
		const container = $("#ve-canvas-container");
		if (!v || !container) return;
		const cRect = container.getBoundingClientRect();
		const vW = v.videoWidth || 1920;
		const vH = v.videoHeight || 1080;
		const scale = Math.min((cRect.width - 24) / vW, (cRect.height - 24) / vH);
		const w = vW * scale;
		const h = vH * scale;
		ve.stickerLayer.style.width = `${w}px`;
		ve.stickerLayer.style.height = `${h}px`;
	};

	ve.openStickerPicker = function () {
		const m = ve.stickerPickerModal || $("#ve-sticker-picker-modal");
		if (!m) return;
		m.hidden = false;
		m.style.display = "flex";
		ve.renderStickerGrid("math");
		document.querySelectorAll(".cat-tab").forEach((t) => t.classList.toggle("active", t.dataset.cat === "math"));
		const grid = $("#ve-sticker-grid");
		const uploadArea = $("#ve-sticker-upload-area");
		if (grid) grid.hidden = false;
		if (uploadArea) uploadArea.hidden = true;
	};

	ve.closeStickerPicker = function () {
		const m = ve.stickerPickerModal || $("#ve-sticker-picker-modal");
		if (!m) return;
		m.hidden = true;
		m.style.display = "none";
	};

	ve.renderStickerGrid = function (cat) {
		const grid = ve.stickerGrid;
		grid.innerHTML = "";
		const list = STICKER_PRESETS[cat] || [];
		for (const item of list) {
			const btn = document.createElement("button");
			btn.className = "sticker-item-btn";
			btn.innerHTML = `<span class="sticker-icon">${item.icon}</span><span class="sticker-label">${item.label}</span>`;
			btn.addEventListener("click", () => {
				ve.addSticker(item);
			});
			grid.appendChild(btn);
		}
	};

	ve.addSticker = function (item) {
		const curTime = ve.video.currentTime || 0;
		const durationOption = ve.stickerDurationSelect.value;
		let dur = 3;
		if (durationOption === "all") {
			dur = Math.max(0.5, ve.duration - curTime);
		} else {
			dur = Number.parseFloat(durationOption) || 3;
		}

		const layerW = ve.stickerLayer.clientWidth || 600;
		const layerH = ve.stickerLayer.clientHeight || 340;

		const id = `stk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		const stk = {
			id,
			type: item.type || "text",
			content: item.icon || item.content,
			name: item.label || "贴纸",
			x: Math.round(layerW / 2 - 40),
			y: Math.round(layerH / 2 - 40),
			width: 80,
			height: 80,
			rotation: 0,
			startTime: curTime,
			endTime: Math.min(ve.duration, curTime + dur),
		};

		if (stk.type === "image") {
			const img = new Image();
			img.src = stk.content;
			stk.imgElement = img;
		}

		ve.stickers.push(stk);
		ve.stickerCount.textContent = ve.stickers.length;
		ve.renderStickerElements();
		ve.renderStickerTrack();
		ve.renderStickersSidebar();
		ve.selectSticker(id);
		ve.closeStickerPicker();
		notice(`已在 ${formatSMPTE(curTime, ve.fps)} 添加贴纸：${stk.name}`, "success");
	};

	ve.renderStickerElements = function () {
		ve.stickerLayer.innerHTML = "";
		for (const s of ve.stickers) {
			const el = document.createElement("div");
			el.className = `sticker-element ${s.id === ve.selectedStickerId ? "selected" : ""}`;
			el.id = s.id;
			el.style.left = `${s.x}px`;
			el.style.top = `${s.y}px`;
			el.style.width = `${s.width}px`;
			el.style.height = `${s.height}px`;
			el.style.transform = `rotate(${s.rotation}deg)`;

			let contentHtml = "";
			if (s.type === "image") {
				contentHtml = `<img src="${s.content}" alt="${esc(s.name)}" />`;
			} else {
				contentHtml = `<span class="sticker-text">${s.content}</span>`;
			}

			el.innerHTML = `
				<div class="sticker-element-content">${contentHtml}</div>
				<div class="stk-handle stk-handle-del" title="删除贴纸">✕</div>
				<div class="stk-handle stk-handle-resize" title="拖动缩放大小"></div>
				<div class="stk-handle stk-handle-rotate" title="拖动旋转角度"></div>
			`;

			// Delete button
			el.querySelector(".stk-handle-del").addEventListener("mousedown", (e) => {
				e.stopPropagation();
				ve.deleteSticker(s.id);
			});

			// Resize handle
			const resizeHandle = el.querySelector(".stk-handle-resize");
			resizeHandle.addEventListener("mousedown", (e) => {
				e.stopPropagation();
				const startX = e.clientX;
				const startY = e.clientY;
				const startW = s.width;
				const startH = s.height;

				const onMove = (moveEvt) => {
					const dx = moveEvt.clientX - startX;
					const dy = moveEvt.clientY - startY;
					const newW = Math.max(30, startW + dx);
					const newH = Math.max(30, startH + dy);
					s.width = Math.round(newW);
					s.height = Math.round(newH);
					el.style.width = `${s.width}px`;
					el.style.height = `${s.height}px`;
				};
				const onUp = () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			});

			// Rotate handle
			const rotateHandle = el.querySelector(".stk-handle-rotate");
			rotateHandle.addEventListener("mousedown", (e) => {
				e.stopPropagation();
				const rect = el.getBoundingClientRect();
				const centerX = rect.left + rect.width / 2;
				const centerY = rect.top + rect.height / 2;

				const onMove = (moveEvt) => {
					const rad = Math.atan2(moveEvt.clientY - centerY, moveEvt.clientX - centerX);
					let deg = Math.round((rad * 180) / Math.PI) + 90;
					s.rotation = deg;
					el.style.transform = `rotate(${deg}deg)`;
				};
				const onUp = () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			});

			// Drag move
			el.addEventListener("mousedown", (e) => {
				if (e.target.classList.contains("stk-handle")) return;
				e.stopPropagation();
				ve.selectSticker(s.id);

				const startX = e.clientX;
				const startY = e.clientY;
				const initX = s.x;
				const initY = s.y;
				const maxW = ve.stickerLayer.clientWidth;
				const maxH = ve.stickerLayer.clientHeight;

				const onMove = (moveEvt) => {
					const dx = moveEvt.clientX - startX;
					const dy = moveEvt.clientY - startY;
					s.x = Math.max(-20, Math.min(maxW - s.width + 20, initX + dx));
					s.y = Math.max(-20, Math.min(maxH - s.height + 20, initY + dy));
					el.style.left = `${s.x}px`;
					el.style.top = `${s.y}px`;
				};
				const onUp = () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			});

			ve.stickerLayer.appendChild(el);
		}
		ve.updateStickersVisibility();
	};

	ve.selectSticker = function (id) {
		ve.selectedStickerId = id;
		for (const el of ve.stickerLayer.querySelectorAll(".sticker-element")) {
			el.classList.toggle("selected", el.id === id);
		}
		for (const it of ve.stickerTrackBar.querySelectorAll(".sticker-timeline-item")) {
			it.classList.toggle("selected", it.dataset.id === id);
		}
		for (const card of ve.stickersList.querySelectorAll(".sticker-sidebar-card")) {
			card.classList.toggle("active", card.dataset.id === id);
		}
	};

	ve.deleteSticker = function (id) {
		const idx = ve.stickers.findIndex((s) => s.id === id);
		if (idx >= 0) {
			const name = ve.stickers[idx].name;
			ve.stickers.splice(idx, 1);
			ve.stickerCount.textContent = ve.stickers.length;
			if (ve.selectedStickerId === id) ve.selectedStickerId = null;
			ve.renderStickerElements();
			ve.renderStickerTrack();
			ve.renderStickersSidebar();
			notice(`已删除贴纸：${name}`, "info");
		}
	};

	ve.updateStickersVisibility = function () {
		const cur = ve.video.currentTime || 0;
		for (const s of ve.stickers) {
			const el = document.getElementById(s.id);
			const inRange = cur >= s.startTime && cur <= s.endTime;
			if (el) el.style.display = inRange ? "flex" : "none";
			const trackItem = ve.stickerTrackBar.querySelector(`.sticker-timeline-item[data-id="${s.id}"]`);
			if (trackItem) trackItem.classList.toggle("active", inRange);
		}
	};

	ve.renderStickerTrack = function () {
		ve.stickerTrackBar.innerHTML = "";
		if (!ve.duration || ve.duration <= 0) return;

		for (const s of ve.stickers) {
			const item = document.createElement("div");
			item.className = `sticker-timeline-item ${s.id === ve.selectedStickerId ? "selected" : ""}`;
			item.dataset.id = s.id;
			const inPct = (s.startTime / ve.duration) * 100;
			const durPct = ((s.endTime - s.startTime) / ve.duration) * 100;
			item.style.left = `${Math.max(0, Math.min(100, inPct))}%`;
			item.style.width = `${Math.max(0.8, Math.min(100 - inPct, durPct))}%`;
			item.innerHTML = `
				<div class="stk-time-handle left" title="拖动修改出现时间"></div>
				<span>${s.content} ${esc(s.name)}</span>
				<div class="stk-time-handle right" title="拖动修改消失时间"></div>
			`;

			// Click to select and jump
			item.addEventListener("click", (e) => {
				if (e.target.classList.contains("stk-time-handle")) return;
				e.stopPropagation();
				ve.selectSticker(s.id);
				ve.seekFrame(s.startTime);
			});

			// Left handle drag
			item.querySelector(".stk-time-handle.left").addEventListener("mousedown", (e) => {
				e.stopPropagation();
				const barWidth = ve.stickerTrackBar.clientWidth;
				const startClientX = e.clientX;
				const origStartTime = s.startTime;

				const onMove = (moveEvt) => {
					const dx = moveEvt.clientX - startClientX;
					const dt = (dx / barWidth) * ve.duration;
					s.startTime = Math.max(0, Math.min(s.endTime - 0.2, origStartTime + dt));
					const newInPct = (s.startTime / ve.duration) * 100;
					const newDurPct = ((s.endTime - s.startTime) / ve.duration) * 100;
					item.style.left = `${newInPct}%`;
					item.style.width = `${newDurPct}%`;
					ve.updateStickersVisibility();
					ve.renderStickersSidebar();
				};
				const onUp = () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			});

			// Right handle drag
			item.querySelector(".stk-time-handle.right").addEventListener("mousedown", (e) => {
				e.stopPropagation();
				const barWidth = ve.stickerTrackBar.clientWidth;
				const startClientX = e.clientX;
				const origEndTime = s.endTime;

				const onMove = (moveEvt) => {
					const dx = moveEvt.clientX - startClientX;
					const dt = (dx / barWidth) * ve.duration;
					s.endTime = Math.max(s.startTime + 0.2, Math.min(ve.duration, origEndTime + dt));
					const newDurPct = ((s.endTime - s.startTime) / ve.duration) * 100;
					item.style.width = `${newDurPct}%`;
					ve.updateStickersVisibility();
					ve.renderStickersSidebar();
				};
				const onUp = () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			});

			ve.stickerTrackBar.appendChild(item);
		}
	};

	ve.renderStickersSidebar = function () {
		if (ve.stickers.length === 0) {
			ve.stickersList.innerHTML = `
				<div class="empty-hint-box" style="text-align: center; padding: 28px 14px;">
					<span style="font-size: 32px; display: block; margin-bottom: 8px;">🎭</span>
					<p class="empty-hint" style="margin-bottom: 12px; line-height: 1.5;">当前视频暂无贴纸图层。<br/>可在画面中添加数学公式、指示箭头或自定义贴图。</p>
					<button type="button" class="btn-tool primary" id="ve-btn-inline-add-sticker" style="cursor: pointer; padding: 6px 14px; font-size: 13px;">+ 立即添加贴纸</button>
				</div>
			`;
			$("#ve-btn-inline-add-sticker")?.addEventListener("click", ve.openStickerPicker);
			return;
		}
		ve.stickersList.innerHTML = "";
		for (const s of ve.stickers) {
			const card = document.createElement("div");
			card.className = `sticker-sidebar-card ${s.id === ve.selectedStickerId ? "active" : ""}`;
			card.dataset.id = s.id;

			let prevContent = "";
			if (s.type === "image") {
				prevContent = `<img src="${s.content}" alt="" />`;
			} else {
				prevContent = s.content;
			}

			const startTc = formatSMPTE(s.startTime, ve.fps);
			const endTc = formatSMPTE(s.endTime, ve.fps);

			card.innerHTML = `
				<div class="sticker-sidebar-preview">${prevContent}</div>
				<div class="sticker-sidebar-info">
					<div class="sticker-sidebar-title">${esc(s.name)}</div>
					<div class="sticker-sidebar-time">${startTc} ~ ${endTc} (${(s.endTime - s.startTime).toFixed(1)}s)</div>
				</div>
				<div class="sticker-sidebar-actions">
					<button class="stk-act-btn" data-act="jump" title="跳至出现时间">⏱</button>
					<button class="stk-act-btn del" data-act="del" title="删除贴纸">✕</button>
				</div>
			`;

			card.querySelector('[data-act="jump"]').addEventListener("click", (e) => {
				e.stopPropagation();
				ve.selectSticker(s.id);
				ve.seekFrame(s.startTime);
			});

			card.querySelector('[data-act="del"]').addEventListener("click", (e) => {
				e.stopPropagation();
				ve.deleteSticker(s.id);
			});

			card.addEventListener("click", () => {
				ve.selectSticker(s.id);
			});

			ve.stickersList.appendChild(card);
		}
	};

	ve.exportVideoWithStickers = async function () {
		if (!ve.activeVideoPath) return;
		if (ve.stickers.length === 0) {
			notice("当前未添加任何贴纸，请先添加贴纸再导出。", "warning");
			return;
		}

		notice("正在通过后台引擎合成贴纸并导出 MP4 视频，请稍候…", "info");

		// Convert stickers to PNG DataURLs and scale to video coordinate system
		const vW = ve.video.videoWidth || 1920;
		const vH = ve.video.videoHeight || 1080;
		const layerW = ve.stickerLayer.clientWidth || vW;
		const layerH = ve.stickerLayer.clientHeight || vH;
		const scaleX = vW / layerW;
		const scaleY = vH / layerH;

		const exportPayload = [];
		for (const s of ve.stickers) {
			const off = document.createElement("canvas");
			off.width = Math.round(s.width * scaleX);
			off.height = Math.round(s.height * scaleY);
			const oCtx = off.getContext("2d");

			oCtx.save();
			oCtx.translate(off.width / 2, off.height / 2);
			oCtx.rotate((s.rotation * Math.PI) / 180);

			if (s.type === "image" && s.imgElement) {
				oCtx.drawImage(s.imgElement, -off.width / 2, -off.height / 2, off.width, off.height);
			} else {
				oCtx.font = `${Math.round(44 * Math.min(scaleX, scaleY))}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
				oCtx.textAlign = "center";
				oCtx.textBaseline = "middle";
				oCtx.fillText(s.content, 0, 0);
			}
			oCtx.restore();

			exportPayload.push({
				dataUrl: off.toDataURL("image/png"),
				x: Math.round(s.x * scaleX),
				y: Math.round(s.y * scaleY),
				width: off.width,
				height: off.height,
				startTime: s.startTime,
				endTime: s.endTime,
			});
		}

		try {
			const res = await fetch("/api/video/render-stickers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: ve.activeVideoPath,
					stickers: exportPayload,
				}),
			});
			const data = await res.json();
			if (data.ok) {
				notice(`带贴纸视频渲染完成！正在下载：${data.filename}`, "success");
				const a = document.createElement("a");
				a.href = fileUrl(data.path);
				a.download = data.filename;
				a.click();
			} else {
				notice(`贴纸合成失败：${data.error || "未知错误"}`, "error");
			}
		} catch (err) {
			notice(`贴纸合成异常：${err.message}`, "error");
		}
	};

	// Bind OpenCut Editor Event Listeners
	(function initOpenCutEventListeners() {
		ve.video.addEventListener("timeupdate", () => {
			if (!ve.isDraggingPlayhead) {
				ve.updatePlayheadUI();
			}
		});

		ve.video.addEventListener("play", () => {
			ve.playBtn.textContent = "⏸ 暂停";
		});
		ve.video.addEventListener("pause", () => {
			ve.playBtn.textContent = "▶ 播放";
		});

		ve.playBtn.addEventListener("click", () => {
			if (ve.video.paused) {
				ve.video.play();
			} else {
				ve.video.pause();
			}
		});

		$("#ve-btn-first-frame").addEventListener("click", () => ve.seekFrame(0));
		$("#ve-btn-last-frame").addEventListener("click", () => ve.seekFrame(ve.duration));
		$("#ve-btn-prev-frame").addEventListener("click", () => ve.stepFrame(-1));
		$("#ve-btn-next-frame").addEventListener("click", () => ve.stepFrame(1));
		$("#ve-btn-prev-sec").addEventListener("click", () => ve.stepFrame(-Math.round(ve.fps)));
		$("#ve-btn-next-sec").addEventListener("click", () => ve.stepFrame(Math.round(ve.fps)));

		ve.speedSelect.addEventListener("change", (e) => {
			ve.video.playbackRate = Number.parseFloat(e.target.value) || 1.0;
		});

		$("#ve-btn-mark-in").addEventListener("click", ve.markIn);
		$("#ve-btn-mark-out").addEventListener("click", ve.markOut);
		$("#ve-btn-clear-range").addEventListener("click", ve.clearRange);
		$("#ve-btn-split").addEventListener("click", ve.splitAtPlayhead);
		$("#ve-btn-freeze").addEventListener("click", ve.freezeFrame);
		ve.btnAnnotate.addEventListener("click", ve.toggleAnnotate);
		$("#ve-btn-clear-draw").addEventListener("click", () => {
			if (ve.annotateCtx) {
				ve.annotateCtx.clearRect(0, 0, ve.annotateCanvas.width, ve.annotateCanvas.height);
			}
		});

		$("#ve-btn-export-clip").addEventListener("click", () => {
			if (ve.inPoint !== null && ve.outPoint !== null && ve.outPoint > ve.inPoint) {
				ve.exportClip(ve.inPoint, ve.outPoint);
			} else {
				notice("请先设置入点 (In) 和出点 (Out) 选区", "warning");
			}
		});

		$("#ve-btn-feedback-ai").addEventListener("click", () => {
			const curTime = ve.video.currentTime;
			const curFrame = Math.round(curTime * ve.fps);
			ve.sendFrameToAI(formatSMPTE(curTime, ve.fps), curFrame);
		});

		$("#ve-btn-close").addEventListener("click", closeFrameEditor);

		// Sticker Actions & Picker Events
		$("#ve-btn-add-sticker")?.addEventListener("click", ve.openStickerPicker);
		$("#ve-btn-quick-add-sticker")?.addEventListener("click", ve.openStickerPicker);
		$("#ve-btn-close-sticker-picker")?.addEventListener("click", ve.closeStickerPicker);
		$("#ve-btn-export-stickers")?.addEventListener("click", ve.exportVideoWithStickers);

		// Category switching in sticker picker
		document.querySelectorAll(".cat-tab").forEach((tab) => {
			tab.addEventListener("click", () => {
				document.querySelectorAll(".cat-tab").forEach((t) => t.classList.remove("active"));
				tab.classList.add("active");
				const cat = tab.dataset.cat;
				if (cat === "upload" || cat === "custom") {
					ve.stickerGrid.hidden = true;
					$("#ve-sticker-upload-area").hidden = false;
				} else {
					ve.stickerGrid.hidden = false;
					$("#ve-sticker-upload-area").hidden = true;
					ve.renderStickerGrid(cat);
				}
			});
		});

		// Custom sticker image upload
		const handleStickerFile = (file) => {
			if (!file || !file.type.startsWith("image/")) {
				notice("请上传有效的图片文件 (PNG, JPG, SVG 等)", "warning");
				return;
			}
			const reader = new FileReader();
			reader.onload = (e) => {
				const dataUrl = e.target.result;
				ve.addSticker({
					type: "image",
					content: dataUrl,
					label: file.name.replace(/\.[^/.]+$/, "") || "自定义图片",
				});
			};
			reader.readAsDataURL(file);
		};

		$("#ve-btn-browse-sticker")?.addEventListener("click", (e) => {
			e.stopPropagation();
			ve.stickerFileInput?.click();
		});

		$("#ve-sticker-dropzone")?.addEventListener("click", () => {
			ve.stickerFileInput?.click();
		});

		ve.stickerFileInput?.addEventListener("change", (e) => {
			if (e.target.files && e.target.files[0]) {
				handleStickerFile(e.target.files[0]);
				e.target.value = "";
			}
		});

		ve.stickerDropzone?.addEventListener("dragover", (e) => {
			e.preventDefault();
			ve.stickerDropzone.classList.add("dragover");
		});

		ve.stickerDropzone?.addEventListener("dragleave", (e) => {
			e.preventDefault();
			ve.stickerDropzone.classList.remove("dragover");
		});

		ve.stickerDropzone?.addEventListener("drop", (e) => {
			e.preventDefault();
			ve.stickerDropzone.classList.remove("dragover");
			if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
				handleStickerFile(e.dataTransfer.files[0]);
			}
		});

		ve.stickerPickerModal?.addEventListener("click", (e) => {
			if (e.target === ve.stickerPickerModal) {
				ve.closeStickerPicker();
			}
		});

		// Timecode Direct Input
		ve.timecodeInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const targetSec = parseSMPTE(ve.timecodeInput.value, ve.fps);
				ve.seekFrame(targetSec);
				ve.timecodeInput.blur();
			}
		});

		// Zoom Slider
		ve.zoomSlider.addEventListener("input", (e) => {
			ve.zoom = Number.parseFloat(e.target.value) || 1.0;
			ve.drawRuler();
		});

		window.addEventListener("resize", () => {
			if (!ve.modal.hidden) {
				ve.drawRuler();
				ve.updateStickerLayerBounds();
			}
		});

		// Timeline Scrubber & Dragging
		const handleTimelineInteraction = (e) => {
			const rect = ve.trackContainer.getBoundingClientRect();
			const clientX = e.clientX ?? (e.touches && e.touches[0].clientX);
			if (clientX === undefined) return;
			const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
			const time = (x / rect.width) * ve.duration;
			ve.seekFrame(time);
		};

		const startScrub = (e) => {
			ve.isDraggingPlayhead = true;
			ve.video.pause();
			handleTimelineInteraction(e);

			const onMove = (moveEvt) => {
				if (!ve.isDraggingPlayhead) return;
				handleTimelineInteraction(moveEvt);
			};

			const onUp = () => {
				ve.isDraggingPlayhead = false;
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				document.removeEventListener("touchmove", onMove);
				document.removeEventListener("touchend", onUp);
			};

			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
			document.addEventListener("touchmove", onMove);
			document.addEventListener("touchend", onUp);
		};

		ve.rulerContainer.addEventListener("mousedown", startScrub);
		ve.trackContainer.addEventListener("mousedown", startScrub);

		// Hover tooltip
		ve.trackContainer.addEventListener("mousemove", (e) => {
			const rect = ve.trackContainer.getBoundingClientRect();
			const x = e.clientX - rect.left;
			if (x < 0 || x > rect.width) {
				ve.hoverIndicator.hidden = true;
				return;
			}
			ve.hoverIndicator.hidden = false;
			ve.hoverIndicator.style.left = `${x}px`;
			const time = (x / rect.width) * ve.duration;
			ve.hoverTooltip.textContent = formatSMPTE(time, ve.fps);
		});

		ve.trackContainer.addEventListener("mouseleave", () => {
			ve.hoverIndicator.hidden = true;
		});

		// Sidebar Tabs
		for (const tab of document.querySelectorAll(".sidebar-tab")) {
			tab.addEventListener("click", () => {
				document.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.remove("active"));
				document.querySelectorAll(".sidebar-tab-content").forEach((c) => c.classList.remove("active"));
				tab.classList.add("active");
				$(`#ve-tab-${tab.dataset.tab}`)?.classList.add("active");
			});
		}

		// Annotate Canvas Drawing
		ve.annotateCanvas.addEventListener("mousedown", (e) => {
			if (!ve.isAnnotating || !ve.annotateCtx) return;
			ve.isDrawing = true;
			const rect = ve.annotateCanvas.getBoundingClientRect();
			ve.annotateCtx.beginPath();
			ve.annotateCtx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
		});

		ve.annotateCanvas.addEventListener("mousemove", (e) => {
			if (!ve.isDrawing || !ve.annotateCtx) return;
			const rect = ve.annotateCanvas.getBoundingClientRect();
			ve.annotateCtx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
			ve.annotateCtx.stroke();
		});

		const stopDraw = () => {
			ve.isDrawing = false;
		};
		ve.annotateCanvas.addEventListener("mouseup", stopDraw);
		ve.annotateCanvas.addEventListener("mouseleave", stopDraw);

		// Global Hotkeys for OpenCut Editor
		window.addEventListener("keydown", (e) => {
			if (ve.modal.hidden) return;
			if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

			if (e.code === "Space") {
				e.preventDefault();
				ve.playBtn.click();
			} else if (e.code === "ArrowLeft") {
				e.preventDefault();
				if (e.shiftKey) {
					ve.stepFrame(-Math.round(ve.fps));
				} else {
					ve.stepFrame(-1);
				}
			} else if (e.code === "ArrowRight") {
				e.preventDefault();
				if (e.shiftKey) {
					ve.stepFrame(Math.round(ve.fps));
				} else {
					ve.stepFrame(1);
				}
			} else if (e.code === "Home") {
				e.preventDefault();
				ve.seekFrame(0);
			} else if (e.code === "End") {
				e.preventDefault();
				ve.seekFrame(ve.duration);
			} else if (e.key === "i" || e.key === "I" || e.key === "[") {
				e.preventDefault();
				ve.markIn();
			} else if (e.key === "o" || e.key === "O" || e.key === "]") {
				e.preventDefault();
				ve.markOut();
			} else if (e.key === "c" || e.key === "C" || e.key === "s" || e.key === "S") {
				e.preventDefault();
				ve.splitAtPlayhead();
			} else if (e.key === "f" || e.key === "F") {
				e.preventDefault();
				ve.freezeFrame();
			} else if (e.key === "Escape") {
				if (!ve.stickerPickerModal.hidden) {
					ve.closeStickerPicker();
					return;
				}
				closeFrameEditor();
			}
		});
	})();

	if (projectSearchEl) {
		projectSearchEl.addEventListener("input", (e) => {
			projectSearchQuery = (e.target.value || "").trim().toLowerCase();
			renderProjects();
		});
	}

	const refreshBtn = $("#btn-refresh");
	if (refreshBtn) {
		refreshBtn.addEventListener("click", () => {
			refreshBtn.classList.add("spinning");
			refreshProjects().finally(() => {
				setTimeout(() => refreshBtn.classList.remove("spinning"), 500);
			});
		});
	}

	emptyState();
	loadHistory();
	connect();
	loadStatus();
	syncTasks();
	refreshProjects();
	const linked = new URLSearchParams(location.search).get("project");
	if (linked) openProject(linked, { silent: true });
	if (new URLSearchParams(location.search).has("model")) openModelDialog();
	setInterval(() => {
		loadStatus();
		syncTasks();
	}, 30_000);
})();
