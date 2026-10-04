"""
分幕模板：复制成 scene_01_xxx.py 使用。

要点：
1. 继承 theme_config 里的 VideoScene（已开启配音、中文字体自适应、收尾自动导出时间轴）。
2. 台词一律用 with speech(self, 字幕, spoken="口播") 包住，块内动画时长自动与配音锁死。
   * 字幕（caption）可以直接写 πr²、2πr 这类符号，屏幕显示好看；
   * 口播（spoken）必须写「派 r 的平方」「二派 r」这种纯中文，否则 TTS 会念错。
3. 中文用 self.make_text / self.set_caption；数学公式用 self.make_math。
4. 多幕共用的常量与几何装置放 project_style.py，不要塞进 theme_config.py。
5. 结尾调用 self.finish() 导出配音时间轴。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from manim import *
from theme_config import VideoScene, speech

# 需要多幕共用几何时再打开这两行：
# from project_style import R_CIRCLE, build_rings


class Scene01Intro(VideoScene):
    DEFAULT_THEME = "claude_light"

    def construct(self):
        super().construct()

        with speech(self, "第一句字幕（可含 πr² 符号）。", spoken="第一句口播，用汉字写公式。"):
            self.play_show_title("标题", "Subtitle")
            self.play(Create(Circle(radius=1.2, color=self.theme.primary)), run_time=1.0)

        self.finish()
