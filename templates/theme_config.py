"""
工作台通用主题配置（由 videoctl new 复制到每个项目）。

包含三件事：
1. 把 manim-video 技能的基类接进来（BaseMathScene / MovingCameraMathScene / 主题）。
2. 中文字体自适应：仓库默认锁定 Windows 的 Microsoft YaHei，这里按本机可用字体自动降级。
3. speech() 语画同步块与 export_timeline()：让配音与画面毫秒级锁死。
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

# ---- 1. 定位 manim-video 技能模板目录 -------------------------------------
def _find_skill_templates(start: Path):
    node = start.resolve()
    for _ in range(8):
        candidate = node / "skills" / "manim-video" / "templates"
        if (candidate / "base_scene.py").exists():
            return candidate
        if node.parent == node:
            break
        node = node.parent
    return None


_TEMPLATES = _find_skill_templates(Path(__file__).resolve().parent)
if _TEMPLATES is None:
    raise RuntimeError("未找到 skills/manim-video/templates，请确认项目位于技能仓库的 projects/ 目录下")
if str(_TEMPLATES) not in sys.path:
    sys.path.insert(0, str(_TEMPLATES))

import base_scene
from base_scene import (  # noqa: E402
    THEMES,
    BaseMathScene,
    MovingCameraMathScene,
    ThreeDMathScene,
    ClaudeScene,
    ClaudeLightScene,
    NordScene,
    ChalkboardScene,
    ClaudeLightTheme,
    AudioEngine,
    VoiceoverTracker,
)
from manim import *  # noqa: E402,F401,F403
import numpy as np  # noqa: E402

PROJECT_DIR = Path(__file__).resolve().parent

# ---- 2. 中文字体自适应 ------------------------------------------------------
CJK_FONT_CANDIDATES = [
    "Microsoft YaHei",
    "PingFang SC",
    "Hiragino Sans GB",
    "STHeiti",
    "Songti SC",
    "Arial Unicode MS",
    "Noto Sans CJK SC",
    "WenQuanYi Micro Hei",
]


def pick_cjk_font():
    try:
        from manimpango import list_fonts

        available = set(list_fonts())
        for name in CJK_FONT_CANDIDATES:
            if name in available:
                return name
    except Exception:
        pass
    return CJK_FONT_CANDIDATES[1]


FONT_CHINESE = pick_cjk_font()
base_scene.FONT_CHINESE = FONT_CHINESE

# ---- 2.5 配音（TTS）策略：离线优先、缓存优先、失败不炸 ----------------------
# MATHVIDEO_TTS=auto(默认) 缓存优先，未命中才联网，失败退化为时长估算并记录告警
# MATHVIDEO_TTS=off         完全不联网（lint/qa/版式迭代用），按文本估算时长
# MATHVIDEO_TTS=force       必须联网合成，失败即报错（正式出片可用）
TTS_MODE = os.environ.get("MATHVIDEO_TTS", "auto").strip().lower() or "auto"
VOICEOVER_ENABLED = os.environ.get("MATHVIDEO_VOICEOVER", "on").strip().lower() not in {"off", "0", "false", "no"}
TTS_CACHE_DIR = Path(os.environ.get("MATHVIDEO_TTS_CACHE") or (PROJECT_DIR / "media" / "voiceover_cache"))
TTS_WARNINGS_FILE = PROJECT_DIR / "tts_warnings.json"
TTS_STATS_FILE = PROJECT_DIR / "tts_stats.json"


def estimate_speech_duration(text):
    """无网络时按文本估算口播时长：汉字按字计，英文/数字按词计。"""
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    words = len([w for w in re.split(r"\s+", re.sub(r"[\u4e00-\u9fff]", " ", text)) if w.strip()])
    return max(cjk * 0.185 + words * 0.32 + 0.35, 1.2)


def _record_tts_event(kind, text, detail=""):
    """把配音合成情况落盘，供 videoctl build 汇总（渲染在子进程里，只能走文件）。"""
    path = TTS_WARNINGS_FILE if kind == "failed" else TTS_STATS_FILE
    try:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"kind": kind, "text": text[:120], "detail": str(detail)[:200]}, ensure_ascii=False) + "\n")
    except Exception:
        pass


def probe_audio_duration(path):
    """
    严格探测音频时长（秒）。半截的 mp3 在 ffprobe 下会失败或给出异常值，
    这里统一返回 None，避免把「失败残留文件」当成有效缓存。
    """
    probe = shutil.which("ffprobe")
    if not probe:
        return None
    try:
        res = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, errors="replace", timeout=30,
        )
        value = float((res.stdout or "").strip())
    except Exception:  # noqa: BLE001
        return None
    return value if value > 0.05 else None


def synthesize_speech(text, voice=None):
    """
    合成（或复用缓存）一句口播，返回 (audio_path|None, duration, source)。
    source ∈ cache / tts / estimate / failed；除 failed 外，duration 都可用于锁时间轴。
    """
    selected_voice = voice or os.environ.get("MATHVIDEO_VOICE") or "zh-CN-YunxiNeural"
    c_dir = TTS_CACHE_DIR
    c_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.md5(f"{selected_voice}_{text}".encode("utf-8")).hexdigest()
    cached = c_dir / f"{digest}.mp3"
    if cached.exists():
        duration = probe_audio_duration(cached)
        if duration is not None:
            _record_tts_event("cache", text)
            return cached, duration, "cache"
        cached.unlink(missing_ok=True)  # 上次合成失败留下的半截文件，清掉重来
    if TTS_MODE == "off":
        return None, estimate_speech_duration(text), "estimate"
    from audio_engine import AudioEngine  # noqa: E402

    attempts = max(1, int(os.environ.get("MATHVIDEO_TTS_RETRIES", "5")))
    last_error = None
    for attempt in range(attempts):
        try:
            audio_path, duration = AudioEngine.generate_speech(text, voice=selected_voice, cache_dir=c_dir)
            if probe_audio_duration(cached) is None:
                raise RuntimeError("合成结果为空或损坏（edge-tts 偶发返回空音频）")
            _record_tts_event("synth", text)
            return audio_path, duration, "tts"
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            cached.unlink(missing_ok=True)
            if attempt + 1 < attempts:
                # edge-tts 走的是境外端点，偶发 reset / 空音频，退避重试基本都能过
                time.sleep(min(1.0 * (2 ** attempt), 4.0))
    _record_tts_event("failed", text, f"{type(last_error).__name__}: {last_error}")
    if TTS_MODE == "force":
        raise last_error
    print(f"[theme_config] TTS 合成失败（已重试 {attempts} 次），改用时长估算：{type(last_error).__name__}", file=sys.stderr)
    return None, estimate_speech_duration(text), "failed"



# ---- 3. 语画同步与时间轴 ----------------------------------------------------
@contextmanager
def speech(scene, caption, spoken=None, voice=None, buffer_wait=0.3):
    """
    语画同步块：屏幕显示 caption（可含 π、r 等符号），TTS 朗读 spoken（建议纯中文），
    块结束时自动补齐等待，使整块时长 = 配音物理时长 + buffer。
    """
    scene.set_caption(caption)
    spoken_text = spoken or caption
    start_time = scene.renderer.time if hasattr(scene, "renderer") else 0.0

    if getattr(scene, "ENABLE_VOICEOVER", False) and VOICEOVER_ENABLED:
        audio_path, duration, source = synthesize_speech(
            spoken_text, voice=voice or getattr(scene, "VOICE_NAME", getattr(AudioEngine, "DEFAULT_VOICE", None))
        )
        scene.tts_sources = getattr(scene, "tts_sources", [])
        scene.tts_sources.append(source)
        if audio_path is not None:
            scene.voiceover_timeline.append((str(audio_path), start_time))
        tracker = VoiceoverTracker(duration=duration, audio_path=audio_path)
    else:
        tracker = VoiceoverTracker(duration=estimate_speech_duration(spoken_text))

    try:
        yield tracker
    finally:
        elapsed = (scene.renderer.time if hasattr(scene, "renderer") else 0.0) - start_time
        remaining = tracker.duration - elapsed
        if remaining > 0:
            scene.wait(remaining)
        if buffer_wait > 0:
            scene.wait(buffer_wait)


def export_timeline(scene, path=None):
    """把本幕配音时间轴落盘（videoctl build 会读取它做混流）。"""
    target = Path(path) if path else PROJECT_DIR / f"voiceover_timeline_{type(scene).__name__}.json"
    data = [{"audio": str(audio), "start_time": float(start)} for audio, start in getattr(scene, "voiceover_timeline", [])]
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


class VideoScene(BaseMathScene):
    """项目内分幕的推荐基类：默认开启配音，收尾自动导出时间轴。"""

    DEFAULT_THEME = "{{THEME}}"
    ENABLE_VOICEOVER = True
    VOICE_NAME = "zh-CN-YunxiNeural"

    def finish(self):
        sources = getattr(self, "tts_sources", [])
        if sources and all(s == "estimate" for s in sources):
            print(f"[theme_config] {type(self).__name__}: 本次渲染未使用配音（估算时长）", file=sys.stderr)
        export_timeline(self)
