# 数学视频全自动工作台（Pi × manim-video）

一句话：**你说一个数学主题，AI 负责想，机器负责做，最后拿到一支带配音的数学动画视频。**

这个工作台把两样东西焊在了一起：

- **Pi**（`github.com/earendil-works/pi`）—— 极简可扩展的智能体框架，负责承载模型、工具与技能；
- **manim-video 技能仓库**（`github.com/cha3343954211/Mathvideo-skill`）—— 负责美学主题、场景基类、主题与数学动画装置。

中间加了一层确定性执行器 `tools/videoctl.py`，把「机械动作」全部固化下来。

## 核心设计：AI 只决策，机器只执行

| 谁 | 干什么 |
| :--- | :--- |
| AI（模型） | 写时间轴脚本、写分幕 Manim 代码、**看质检图改版式** |
| `videoctl`（确定性 CLI） | 建项目、环境自检、静态检查、单帧质检、渲染、配音、混流、拼接、故事板、产物汇总 |

这样分工的好处：结果是可复现的，出错能定位到具体一步，模型不需要记住 ffmpeg 参数，也不会因为一次网络抖动毁掉整支出片。

```
自然语言主题
   │
   ├─ 1 环境自检 ────────────── video_env_check
   ├─ 2 时间轴脚本（AI 写）
   ├─ 3 建项目骨架 ──────────── video_new
   ├─ 4 分幕 Manim 代码（AI 写）
   ├─ 5 静态检查 ────────────── video_lint      ┐
   ├─ 6 单帧质检图（AI 亲眼看）─ video_qa        ┘ 迭代到干净为止
   ├─ 7 渲染+配音+混流+拼接 ─── video_build
   └─ 8 交付汇总/故事板 ─────── video_report / video_storyboard
```

## 目录结构

```text
mathvideo-workbench/
├── web/                            # Web 工作台：server.mjs + 前端（浏览器 ⇄ Pi RPC ⇄ videoctl）
├── bin/web                         # 一条命令启动网页版
├── extensions/video-workbench.ts   # Pi 扩展：7 个工具 + 4 个斜杠命令 + 技能挂载
├── skills/mathvideo-autopilot/     # 全自动生产线技能（AI 的作业指导书）
├── prompts/video.md                # /video 提示词模板
├── templates/                      # 新项目骨架：主题配置、脚本模板、分幕模板、project_style
├── tools/
│   ├── videoctl.py                 # 确定性执行层（唯一的事实来源）
│   ├── workbench.json              # 技能仓库路径、Python、画质、音色
│   └── verify_workbench.mjs        # 冒烟测试：真加载扩展 + 真跑环境自检
└── .pi/settings.json               # 把本目录注册成 Pi 包（项目作用域）
```

## 两种用法

**网页版（推荐）**

```bash
bin/web        # 启动并自动打开 http://127.0.0.1:5180
```

左边挑项目、中间对话、右边看成片。质检图直接内嵌在对话流里，成片可在线播放与下载，
还有「重新质检 / 快速预览 / 1080p60 重出片」按钮可以直接跳过模型重跑。详见 `web/README.md`。

网页会记住上一次聊到哪儿：刷新页面自动恢复对话，服务重启也会接着原来的会话继续（`--continue`）。
数学公式用本地打包的 KaTeX 渲染，断网也能看。

**模型是 BYOK 的**：右上角「⚙ 模型」里填自己的服务商与 API Key（OpenAI / Claude / DeepSeek / Kimi / 通义 / 智谱 /
OpenRouter / 本机 Ollama…），也可以一键「导入本机 Pi 配置」。Key 只写在本机 `web/.agent/`（700/600 权限），
不回显、不上传，也不改动你的 `~/.pi`。

**终端版**

```bash
pi             # 进入后 /login 连一个模型
/video 勾股定理的可视化证明
```

## 安装与启动

前提：Node.js ≥ 22.19、Python 3.11+、`ffmpeg`、LaTeX（`latex`/`dvisvgm`）。

```bash
# 1. 安装 Pi
curl -fsSL https://pi.dev/install.sh | sh

# 2. 装好 manim 环境（技能仓库自带 .venv 更省事）
export MATHVIDEO_SKILL_ROOT=/path/to/Mathvideo-skill

# 3. 冒烟测试：确认真加载了扩展、真找得到技能与环境
node tools/verify_workbench.mjs

# 4. 在 Pi 里登录模型，然后启动
pi            # 进入后 /login 选一个 provider
```

启动后在对话框里输入：

```text
/video 勾股定理的可视化证明
```

Pi 会自动走完 8 个阶段，中途把脚本要点和质检图给你确认。

也可以只跑某一步：

```text
/video-qa  <项目目录>       # 只看排版
/video-build <项目目录>     # 直接出片
/video-status               # 现在做到哪了
```

## 确定性执行层

```bash
python3 tools/videoctl.py check          # 环境自检（manim/ffmpeg/LaTeX/中文字体/技能仓库）
python3 tools/videoctl.py new "主题"      # 建项目到 <技能仓库>/projects/<slug>/
python3 tools/videoctl.py lint  <项目>    # 静态检查：中文进 LaTeX、硬编码字体、视口越界、导入违规
python3 tools/videoctl.py qa    <项目>    # 逐幕末帧 + 拼图（给模型看的排版验收图）
python3 tools/videoctl.py build <项目> --quality h --voice
python3 tools/videoctl.py storyboard <项目>
python3 tools/videoctl.py report <项目>
```

全部子命令都支持 `--json`，输出结构化结果给智能体消费；人看的时候则是普通文本。

## 项目内部的三个文件分工

| 文件 | 归属 | 说明 |
| :--- | :--- | :--- |
| `theme_config.py` | 工作台 | 基类、中文字体自适应、TTS 策略、`speech()` 语画同步。**每次渲染前自动同步，项目里改会被覆盖。** |
| `project_style.py` | 项目 | 本项目自己的常量与几何装置，随便改。 |
| `scene_XX_*.py` | 项目 | 分幕代码，一幕一类。 |

## 配音（TTS）策略

渲染时要用配音的物理时长去锁画面节奏，所以配音的稳定性就是流水线的稳定性：

| `MATHVIDEO_TTS` | 行为 |
| :--- | :--- |
| `off` | 不联网，按文本估算时长。`lint` / `qa` 自动使用，改版式不怕断网。 |
| `auto`（默认） | 缓存优先；未命中才联网，失败重试 3 次，仍失败则退化为估算时长并记录告警，绝不中断渲染。 |
| `force` | 必须合成成功，否则报错，适合正式交付前把关。 |

缓存位于 `<项目>/media/voiceover_cache/`，同一句话（文本+音色）只请求一次。

**字幕与口播必须分开写**：`caption` 可以写 `πr²`、`2πr`，`spoken` 要用汉字写读音（「派 r 的平方」），否则 TTS 会念错。

## 排错

- `video_env_check` 报字体缺失：macOS 一般自动降级到 `PingFang SC`；Linux 请装 `fonts-noto-cjk`。
- `qa` 返回 `ok: false`：看 `scenes[].error`，已经把报错压缩成「项目内代码位置 + 异常行」。
- `build` 返回 `tts_failures`：那几句只有画面没声音，联网后重跑即可，已成功的句子走缓存不会重复请求。
- `pi` 启动报 Node 版本或 dylib 错误：用 `node -v` 确认 ≥ 22.19，Homebrew 用户可 `brew reinstall node`。

## 冒烟测试做了什么

`tools/verify_workbench.mjs` 用 Pi 自己的扩展加载器（jiti + 官方别名）真实加载 `extensions/video-workbench.ts`，
校验 7 个工具、4 个命令、技能发现路径，并真实调用一次 `video_env_check`。改完扩展先跑它，比开 Pi 试快得多。
