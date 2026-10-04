/* 数学视频工作台 · 前端
   只做三件事：把 SSE 事件画成对话、把项目画成列表、把成片画成播放器。 */
(() => {
	"use strict";

	const $ = (sel) => document.querySelector(sel);
	const messagesEl = $("#messages");
	const outputEl = $("#output");
	const projectListEl = $("#project-list");
	const inputEl = $("#input");
	const sendBtn = $("#send");
	const chipsEl = $("#chips");

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
				<h3>从一个数学主题开始</h3>
				<p>它会先写脚本给你确认，再逐幕生成动画，最后渲染成带配音的 1080p 成片。</p>
				<ol>
					<li>说一个主题，比如「圆的面积为什么是 πr²」</li>
					<li>看它给出的脚本要点，回一句「确认」</li>
					<li>它会自动写代码、自查排版、渲染出片</li>
					<li>成片会出现在右侧面板，可直接播放和下载</li>
				</ol>
			</div>`;
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
		el.innerHTML = `
			<div class="tool-head">
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
		if (!state.projects.length) {
			projectListEl.innerHTML = `<p class="empty">还没有项目</p>`;
			return;
		}
		projectListEl.innerHTML = state.projects
			.map((p) => {
				const active = state.selected === p.path ? " active" : "";
				const tag = p.final ? `<span class="tag">已成片</span>` : `<span class="tag none">制作中</span>`;
				return `<div class="project${active}" data-path="${esc(p.path)}">
					<div class="name">${esc(p.project)}</div>
					<div class="meta"><span>${p.scenes} 幕</span>${tag}</div>
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
		const artifacts = data.artifacts || [];
		const videos = artifacts.filter((a) => a.path.endsWith(".mp4"));
		const sheet = artifacts.find((a) => a.path.endsWith("contact_sheet.png"));
		const board = artifacts.find((a) => a.path.endsWith(".html"));

		let html = "";
		if (videos.length) {
			const final = videos.find((v) => v.path.includes("voiced")) || videos[0];
			html += `<div class="artifact">
				<h3>成片</h3>
				<video src="${fileUrl(final.path)}#t=2" controls preload="metadata"></video>
				<div class="row">
					<a href="${fileUrl(final.path)}" download>下载 MP4</a>
					<a href="${fileUrl(final.path)}" target="_blank" rel="noopener">新窗口打开</a>
				</div>
				<div class="facts">时长 ${final.duration_sec ?? "—"} 秒 · ${final.size_mb} MB${
					videos.length > 1 ? ` · 另有 ${videos.length - 1} 个版本（含预览）` : ""
				}</div>
			</div>`;
		} else {
			html += `<div class="artifact"><h3>成片</h3><p class="empty">还没有出片。可以让它继续，或点下面的按钮直接渲染。</p></div>`;
		}

		html += `<div class="artifact">
			<h3>排版质检</h3>
			${
				sheet
					? `<img src="${fileUrl(sheet.path)}?t=${Date.now()}" alt="质检总览" data-zoom="1" />`
					: `<p class="empty">还没做过质检</p>`
			}
			<div class="row">
				<button class="mini" data-run="qa">重新质检</button>
				${board ? `<a href="${fileUrl(board.path)}" target="_blank" rel="noopener">打开故事板</a>` : `<button class="mini" data-run="storyboard">生成故事板</button>`}
			</div>
		</div>`;

		html += `<div class="artifact">
			<h3>重新出片</h3>
			<div class="row">
				<button class="mini" data-run="build" data-quality="l">快速预览</button>
				<button class="mini" data-run="build" data-quality="h">1080p60</button>
				<button class="mini" data-run="lint">代码检查</button>
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
	$("#btn-abort").addEventListener("click", async () => {
		await fetch("/api/abort", { method: "POST" });
		notice("已请求停止。", "warning");
	});
	$("#btn-refresh").addEventListener("click", refreshProjects);

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
