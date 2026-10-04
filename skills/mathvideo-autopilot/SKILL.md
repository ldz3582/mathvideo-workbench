---
name: mathvideo-autopilot
description: "数学视频全自动生产流水线：从自然语言主题出发，自动完成时间轴脚本 → 分幕 Manim 代码 → 单帧质检迭代 → 高清渲染 → TTS 配音 → 混流拼接 → 成片交付。当用户要求「做一个数学视频 / 讲解视频 / Manim 动画 / 可视化科普」时使用。"
version: 1.0.0
metadata:
  tags: [manim, math-video, automation, tts, pipeline]
---

# 数学视频全自动生产线（Autopilot）

本技能把 **manim-video 技能仓库** 与工作台的确定性执行层 `videoctl` 连起来：
你（模型）只负责「想」——写脚本、写画面代码、看质检图改版式；
所有机械动作交给 `videoctl` 工具完成，不要自己手敲 manim/ffmpeg 命令。

配套美学与实现规范仍以 manim-video 技能为准（本仓库已通过 `resources_discover` 挂载）。

## 生产闭环（严格按序执行）

| 阶段 | 动作 | 工具 |
| :--- | :--- | :--- |
| 0 环境 | 确认 manim / ffmpeg / LaTeX / 中文字体就绪 | `video_env_check` |
| 1 脚本 | 写 `script_and_timeline.md`：逐幕时间轴 + 口播台词 + 画面行为 + 核心 Aha 点 | 用 `write`/`edit` 工具 |
| 2 门控 | 把脚本要点呈现给用户确认（除非用户明确要求全自动跳过） | 对话 |
| 3 建项目 | 生成项目骨架 | `video_new` |
| 4 编码 | 逐幕写 `scene_XX_*.py`（一幕一个 Scene 类，3~5 幕） | 用 `write`/`edit` 工具 |
| 5 静态检查 | 中文进 LaTeX、硬编码字体、视口越界、配音时间轴 | `video_lint` |
| 6 视觉质检 | 每幕末帧拼成总览图，**你必须亲眼看这张图**并据此改版式 | `video_qa` |
| 7 出片 | 高清渲染 + 配音 + 混流 + 拼接 | `video_build` |
| 8 交付 | 汇总成片路径/时长/体积，生成故事板 | `video_report`、`video_storyboard` |

第 5–7 步是迭代循环：`video_lint` / `video_qa` 发现问题 → 改代码 → 重跑，
直到质检图无出界、无重叠、字幕完整，再进入 `video_build`。

## 项目结构约定

项目位于 `<技能仓库>/projects/<slug>/`，由 `video_new` 自动生成：

```text
projects/<slug>/
├── brief.md                     # 创作简报（可改）
├── script_and_timeline.md       # 时间轴脚本（阶段 1 填写）
├── theme_config.py              # 工作台基础设施：基类 + 中文字体 + TTS 策略 + speech()（自动同步，勿手改）
├── project_style.py             # 本项目自己的常量与几何装置（随便改，工作台不覆盖）
├── scene_01_xxx.py              # 分幕代码（阶段 4 编写）
├── voiceover_timeline_<Scene>.json  # 渲染时自动生成，供混流使用
└── qa/contact_sheet.png         # 质检总览图
```

## 分工铁律

**能算的别猜，能查的别问人。** 所有机械动作走 `videoctl` 对应的工具；你只做三件事：
写脚本、写分幕代码、看质检图改版式。

- `theme_config.py` 由工作台自动同步（每次 lint/qa/build 前都会刷新），**在里面加自己的东西一定会被覆盖**；
- 项目专属的常量、配色微调、自定义图形装置一律写 `project_style.py`；
- 分幕里 `from theme_config import (...)` 只允许导入工作台基础设施名，导入别的会被 lint 拦下。

## 编码规范（硬性）

1. **分幕继承 `VideoScene`**：`from theme_config import VideoScene, speech`；
   `VideoScene` 已开启 `ENABLE_VOICEOVER`，并在 `self.finish()` 时导出配音时间轴。
2. **每句台词用 `speech()` 包住**：
   ```python
   with speech(self, "字幕文本（可含 2πr、πr²）", spoken="口播文本（用汉字写「二派 r」）"):
       self.play(...)          # 块内动画时长自动与配音物理时长锁死
   ```
3. **中文一律用 `self.make_text(...)` / `self.set_caption(...)`**，绝不能进 `MathTex`。
4. **安全视口**：X ∈ [-6.0, 6.0]，Y ∈ [-3.2, 3.2]；关键词用 `self.focus_on(...)` 或 `self.play_focus_revelation(...)`。
5. **每幕结尾调用 `self.finish()`**，否则该幕没有配音时间轴，混音会退化为无声。
6. 一幕一个文件一个类，便于快速单幕质检与返工。
7. 换肤只需改类的 `DEFAULT_THEME`（`claude_light` / `3b1b_dark` / `chalkboard` / `nord` / `claude_dark`）。
8. **字幕与口播必须分开写**：`caption` 可含 `πr²`、`2πr`；`spoken` 用汉字写读音（「派 r 的平方」「二派 r」），
   否则 TTS 会把符号念错。数字同理，`spoken="二分之一"` 比 `"1/2"` 稳。
9. 多幕共用的几何与标签放 `project_style.py`，保证各幕视觉严格一致。

## 配音与网络（重要）

渲染时 `speech()` 会取配音时长来锁死画面节奏，所以配音策略直接决定流水线是否稳定：

- 缓存优先：同一句话（文本+音色）只会请求一次，之后走 `media/voiceover_cache/`，重渲不再联网；
- `MATHVIDEO_TTS=off`：完全不联网，按文本估算时长。`video_lint` / `video_qa` 自动用这个模式，
  所以**改版式时不怕断网**，QA 只关心排版；
- `MATHVIDEO_TTS=auto`（默认）：缓存未命中才联网，失败自动重试 3 次，仍失败则退化为估算时长并继续渲染，
  把失败句子记进 `tts_warnings.json`；
- `video_build` 的返回里若出现 `tts_failures`，说明那几句只有画面没有声音 —— 联网后重跑一次即可补齐（已成功的句子走缓存）。

## 质检图怎么用

`video_qa` 返回的图片就是每一幕的末帧拼图。逐条检查：

- 字幕是否贴边、被裁切；公式是否与图形/字幕重叠；
- 元素是否超出安全视口（拼图边缘被切断说明超框）；
- 深浅主题下文字对比度是否足够（白底白字要立刻改）；
- 关键结论是否落在视觉中心，而不是缩在角落。

发现问题后修改对应 `scene_XX_*.py`，只重跑 `video_qa`（可带 `only` 参数只查改过的那一幕），
确认干净后再 `video_build`。

**不要跳过看图这一步**：`video_qa` 返回的图是唯一能证明排版没坏的东西，静态 lint 查不出重叠与遮挡。
若 QA 返回 `ok: false`，先看 `scenes[].error`（已经压缩成「项目内代码位置 + 异常行」），改完再跑。

## 交付话术

出片后向用户报告：成片绝对路径、时长、体积、分幕数量、配音段数、主题风格，
并给出可继续迭代的方向（换主题、换音色、加背景音乐、加长某一段）。
