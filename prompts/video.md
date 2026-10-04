---
description: 全自动制作一支数学视频（脚本 → 分幕代码 → 质检 → 渲染 → 配音 → 成片）
argument-hint: "<视频主题> [--auto 跳过脚本确认]"
---
请使用 mathvideo-autopilot 技能，全自动制作一支关于以下主题的数学科普视频：

${1:欧拉公式的几何本质}

要求：

1. 先调用 `video_env_check` 确认环境就绪。
2. 用 `video_new` 建立项目，然后按技能规范写 `script_and_timeline.md`。
3. 若参数里没有 `--auto`，先把脚本要点（核心 Aha 点、分幕结构、台词摘要）呈现给我确认后再继续；
   若带了 `--auto`，直接继续，不必等待确认。
4. 逐幕编写 `scene_XX_*.py`，每幕结尾调用 `self.finish()`。
5. `video_lint` → `video_qa`，**认真看质检拼图**并迭代修正排版，直到干净。
6. `video_build` 出片（1080p60 + 中文配音），最后用 `video_report` 汇报成片路径、时长、体积。
