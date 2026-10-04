# 架构说明：框架与技能是怎么接起来的

## 一、Pi 是什么

`github.com/earendil-works/pi` 是一个**极简、可扩展的智能体外壳（agent harness）**，不是一个模型，也不是一个产品。

它做的事可以概括为：

1. **接模型**：内置多家 provider（Anthropic / OpenAI / Gemini / 本地模型…），负责登录、鉴权、流式输出、重试与上下文压缩。
2. **跑循环**：把「用户输入 → 模型回复 → 调用工具 → 把结果喂回模型 → 继续」这个 agentic loop 跑起来，
   并管理会话文件（可 `--continue`、`--fork`、导出 HTML）。
3. **给工具**：自带 `read` / `bash` / `edit` / `write` 等基础工具，并把扩展注册的自定义工具也暴露给模型。
4. **装载扩展点**：这是 Pi 最有价值的部分——它把「怎么用」交给使用者自己定义：

| 扩展点 | 作用 | 本工作台用到的 |
| :--- | :--- | :--- |
| Extension（TS 模块） | 注册工具、命令、事件钩子、provider | ✅ `extensions/video-workbench.ts` |
| Skill（`SKILL.md`） | 给模型的作业指导书，按需加载 | ✅ `skills/mathvideo-autopilot` + 挂载技能仓库的 `manim-video` |
| Prompt template（`.md`） | 把常用提示词变成 `/` 命令 | ✅ `prompts/video.md` |
| Package（带 `pi` 清单的目录） | 把上面几样打包分发 | ✅ 本目录就是一个 Pi package |
| RPC 模式 | 用 JSONL 从外部进程驱动 Pi | ✅ Web 层就是这么接的 |
| SDK | 在自己的 Node 进程里直接嵌入 Pi | 未使用（RPC 进程隔离更稳） |
| Theme | 终端配色 | — |

5. **可选形态**：交互式 TUI、`-p` 一次性打印、JSON、RPC、以及 TypeScript SDK —— 本工作台的网页版走的就是 RPC。

一句话：**Pi 负责「想」，并且允许你把「做」的部分换成自己的。**

Pi 刻意不内置 sub-agent、plan mode 这类特性，理由和本工作台的设计完全一致——
真正有价值的是把某个垂直领域的工作流固化下来，而不是让模型每次自由发挥。

## 二、manim-video 技能仓库是什么

`github.com/cha3343954211/Mathvideo-skill` 提供的是**数学视频的领域知识与美学资产**：

- `skills/manim-video/SKILL.md`：动画设计原则、排版规范、叙事节奏；
- `templates/base_scene.py`：`BaseMathScene` / `MovingCameraMathScene` / `ThreeDMathScene` 三个基类；
- `templates/`：七套配色主题、几何装置（`math_rigs.py`）、版式守卫（`layout_guard.py`）、
  视觉特效（`visual_fx.py`）、配音引擎（`audio_engine.py`）；
- `scripts/storyboard_generator.py`：故事板看板。

它知道「一支好的数学视频应该长什么样」，但它**不会自己跑起来**：没有模型、没有循环、没有工具调度。

## 三、两者怎么接起来

```
┌─────────────────────────────────────────────────────────┐
│ 浏览器（web/public）：对话流 + 项目列表 + 成片播放器        │
│   ↑ SSE /api/events        ↓ POST /api/prompt /api/run   │
├─────────────────────────────────────────────────────────┤
│ web/server.mjs（本工作台的 Web 层）                        │
│   · 把 Pi 的 JSONL 事件流翻译成前端好画的事件                │
│   · 把 videoctl 的子命令做成 HTTP 接口（按钮直达，不过模型）  │
│   · 代理视频/图片文件，支持 Range 拖动进度条                 │
├─────────────────────────────────────────────────────────┤
│ Pi 以 `pi --mode rpc` 长驻子进程运行（决策层）              │
│  · 模型 ↔ 工具循环    · 会话管理    · 扩展/技能/命令装载   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ extensions/video-workbench.ts（本工作台）           │  │
│  │  · resources_discover → 挂载 manim-video 技能        │  │
│  │  · 7 个原生工具：env_check / new / lint / qa /       │  │
│  │    build / storyboard / report                      │  │
│  │  · 4 个命令：/video /video-build /video-qa /-status  │  │
│  └──────────────────┬─────────────────────────────────┘  │
└─────────────────────┼────────────────────────────────────┘
                      │ spawn（解析 JSON）
┌─────────────────────▼────────────────────────────────────┐
│ tools/videoctl.py（确定性执行层）                          │
│  建项目 · 静态检查 · 单帧质检+拼图 · 渲染 · 配音 · 混流 ·    │
│  拼接 · 故事板 · 产物汇总                                  │
└─────────────────────┬────────────────────────────────────┘
                      │ 子进程调用
┌─────────────────────▼────────────────────────────────────┐
│ Mathvideo-skill（领域资产）                                │
│  基类 · 主题 · 几何装置 · 版式守卫 · AudioEngine · 故事板    │
└──────────────────────────────────────────────────────────┘
```

连接方式是三层单向依赖，**没有一层会反向依赖上一层**：

- 技能仓库不需要知道 Pi 的存在（它只是一堆 Python 模块和 Markdown）；
- `videoctl` 不知道模型的存在（它只认项目目录和 `--json`）；
- 扩展不知道 Manim 的细节（它只会调 `videoctl` 并转发进度）。

## 四、为什么中间要加一层 `videoctl`

如果让模型直接敲 `manim -qm scene_01.py Scene01`，会出三个问题：

1. **不可复现**：模型每次写的命令不一样，出片参数漂移；
2. **无法定位**：渲染失败时模型看到的是整屏 rich 方框，找不到自己代码的第几行；
3. **不可验收**：模型「觉得」排版没问题，但没有证据。

`videoctl` 把机械动作固化下来，并且专门为模型消费做了三件事：

- 所有子命令支持 `--json`，返回结构化结果；
- 报错被压缩成「项目内代码位置 + 真正的异常行」（`clean_error()`）；
- `qa` 直接把拼图 PNG 作为工具结果返回，模型必须**看图**才能进入下一步。

## 五、一次生产的完整数据流

1. 用户 `/video 勾股定理的可视化证明`
   → 扩展发出 `sendUserMessage`，把主题交给 agent。
2. agent 加载 `mathvideo-autopilot` 技能 → 调用 `video_env_check` → `video_new`
   → 在 `<技能仓库>/projects/pythagoras_demo/` 建骨架并写入 `theme_config.py`（基础设施）+ `project_style.py`（项目自有）。
3. agent 写 `script_and_timeline.md` 与 `scene_XX_*.py`。
4. `video_lint`：静态查中文进 LaTeX、硬编码字体、视口越界、从 `theme_config` 导入了不属于基础设施的名字。
5. `video_qa`：逐幕渲染末帧（`MATHVIDEO_TTS=off`，不联网）→ 拼图 → 模型看图 → 改代码 → 重跑。
6. `video_build`：渲染（`speech()` 取配音时长锁画面节奏；缓存优先、失败重试、失败降级不中断）
   → 逐幕 `AudioEngine.mix_scene_audio` 混流 → `ffmpeg concat` 无损拼接 → 写出成片与 `workbench_report.json`。
7. `video_report` / `video_storyboard`：汇总成片路径、时长、体积、配音段数，生成 HTML 故事板。

## 六、Web 层为什么用 RPC 而不是 SDK

Pi 两种嵌入方式都能用，这里选 RPC 有三个实际理由：

1. **状态隔离**：模型卡住或扩展抛异常时，崩的只是子进程，Web 服务能重启它并把这件事告诉前端；
2. **复用现成配置**：RPC 子进程就是完整的 pi CLI，登录态、模型设置、已安装的包全都直接生效，
   不必在 Web 层重建一遍 provider 与凭据逻辑；
3. **边界干净**：Web 层只认 JSONL，Pi 升级不会牵动前端代码。

代价是事件要多序列化一轮，对这个量级完全无感。

## 七、这套架构的可迁移性

把 `Mathvideo-skill` 换成别的领域资产包、把 `videoctl.py` 换成别的执行器，
`extensions/video-workbench.ts` 的骨架（`resources_discover` + `registerTool` + `registerCommand`）可以原样复用。

这就是 Pi 的「包 / 扩展 / 技能」三层抽象想要达到的效果：
**框架提供循环，包提供连接，技能提供知识，执行器提供确定性。**
