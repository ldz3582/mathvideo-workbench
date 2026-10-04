#!/usr/bin/env python3
"""
videoctl — 数学视频全自动生产流水线的确定性执行层。

设计原则：AI 只负责「想」（写脚本、写画面代码、看图修版式），
一切机械动作（建项目、环境自检、静态检查、单帧质检、渲染、配音、混流、拼接、
故事板、产物汇总）都由本 CLI 以确定的方式完成，并统一输出 JSON 供智能体消费。

用法：
    python3 tools/videoctl.py check
    python3 tools/videoctl.py new "圆的面积为什么是 pi r 平方"
    python3 tools/videoctl.py lint  projects/<slug>
    python3 tools/videoctl.py qa    projects/<slug>
    python3 tools/videoctl.py preview projects/<slug>
    python3 tools/videoctl.py build projects/<slug> --quality h --voice
    python3 tools/videoctl.py storyboard projects/<slug>
    python3 tools/videoctl.py report projects/<slug>

约定：
    * 所有数学视频项目放在 <skill_root>/projects/<slug>/ 下
    * 项目内 scene_*.py 为分幕，类名即场景名
    * 项目内 theme_config.py 提供基类、中文字体自适应与 speech() 语画同步块
    * 配音时间轴落盘为 <project>/voiceover_timeline_<SceneClass>.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

WORKBENCH_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = WORKBENCH_ROOT / "tools" / "workbench.json"
RES_DIR = {"l": "480p15", "m": "720p30", "h": "1080p60", "k": "2160p60"}
TTS_ENV_OFFLINE = {"MATHVIDEO_TTS": "off"}
SCENE_CLASS_RE = re.compile(r"^class\s+(\w+)\s*\(([^)]*)\)\s*:", re.MULTILINE)
CJK_RE = re.compile(r"[\u4e00-\u9fff]")


# ----------------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------------
def die(message, code=1):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stdout)
    sys.exit(code)


def run(cmd, cwd=None, timeout=None, env=None):
    """执行外部命令，永不抛异常，统一返回结构化结果。"""
    started = time.time()
    merged_env = dict(os.environ)
    if env:
        merged_env.update(env)
    try:
        proc = subprocess.run(
            [str(c) for c in cmd],
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            env=merged_env,
        )
        return {
            "cmd": [str(c) for c in cmd],
            "rc": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "seconds": round(time.time() - started, 2),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "cmd": [str(c) for c in cmd],
            "rc": 124,
            "stdout": (exc.stdout or b"").decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
            "stderr": f"timeout after {timeout}s",
            "seconds": round(time.time() - started, 2),
        }
    except FileNotFoundError as exc:
        return {"cmd": [str(c) for c in cmd], "rc": 127, "stdout": "", "stderr": str(exc), "seconds": 0.0}


def _tts_stats(events):
    """把渲染期记录的配音来源统计成 {cache, synth, estimate, failed}。"""
    stats = {"cache": 0, "synth": 0, "estimate": 0, "failed": 0}
    for event in events:
        kind = event.get("kind")
        if kind == "tts":
            stats["synth"] += 1
        elif kind in stats:
            stats[kind] += 1
    return stats


def read_jsonl(path: Path):
    """读取按行追加的 JSON 记录（渲染子进程写入的配音告警/统计）。"""
    if not path.exists():
        return []
    items = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            items.append(json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    return items


BOX_CHARS = "│╭╮╰╯─━┌┐└┘❱"


def clean_error(text, limit=800):
    """
    把 manim/rich 的花哨报错压缩成「最后一处项目内代码位置 + 真正的异常行」，
    这样智能体看到的是可执行的定位信息，而不是整屏方框。
    """
    if not text:
        return ""
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    kept = []
    for line in lines:
        stripped = line.strip(BOX_CHARS + " ")
        if not stripped:
            continue
        if stripped.startswith("[theme_config]"):
            continue
        kept.append(stripped)
    exception = next((ln for ln in reversed(kept) if re.match(r"^[A-Za-z_]*(Error|Exception|Warning)\b.*:", ln)), None)
    location = next((ln for ln in reversed(kept) if re.search(r"scene_\w+\.py:\d+|project_style\.py:\d+|theme_config\.py:\d+", ln)), None)
    parts = [ln for ln in (location, exception) if ln]
    if not parts:
        parts = kept[-3:]
    return "\n".join(parts)[:limit]


def tail(text, lines=12, limit=4000):
    if not text:
        return ""
    parts = [line for line in text.strip().splitlines() if line.strip()]
    return "\n".join(parts[-lines:])[-limit:]


def find_skill_root():
    """从环境变量、工作台目录、当前目录逐级向上寻找 manim-video 技能根目录。"""
    candidates = []
    if os.environ.get("MATHVIDEO_SKILL_ROOT"):
        candidates.append(Path(os.environ["MATHVIDEO_SKILL_ROOT"]).expanduser())
    starts = [WORKBENCH_ROOT, Path.cwd()]
    for start in starts:
        node = start.resolve()
        for _ in range(6):
            candidates.append(node)
            if node.parent == node:
                break
            node = node.parent
            candidates.append(node / "Mathvideo-skill")
    for cand in candidates:
        if (cand / "skills" / "manim-video" / "templates" / "base_scene.py").exists():
            return cand.resolve()
    return None


def load_config(config_path=None):
    path = Path(config_path or os.environ.get("MATHVIDEO_WORKBENCH_CONFIG") or DEFAULT_CONFIG_PATH)
    cfg = {}
    if path.exists():
        try:
            cfg = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            die(f"配置文件解析失败 {path}: {exc}")
    cfg["config_path"] = str(path)

    root = Path(str(cfg.get("skill_root") or "")).expanduser()
    if not (root / "skills" / "manim-video" / "templates" / "base_scene.py").exists():
        found = find_skill_root()
        if not found:
            die("未找到 manim-video 技能根目录。请设置 MATHVIDEO_SKILL_ROOT 或修改 tools/workbench.json 的 skill_root")
        root = found
    cfg["skill_root"] = str(root)
    cfg.setdefault("projects_dir", str(root / "projects"))
    cfg.setdefault("default_theme", "claude_light")
    cfg.setdefault("preview_quality", "l")
    cfg.setdefault("final_quality", "h")
    cfg.setdefault("default_voice", "zh-CN-YunxiNeural")
    cfg.setdefault("render_timeout_sec", 1800)

    py = os.environ.get("MATHVIDEO_PYTHON") or cfg.get("python")
    if not py:
        venv = root / ".venv" / "bin" / "python"
        py = str(venv) if venv.exists() else sys.executable
    cfg["python"] = py
    return cfg


def templates_dir():
    return WORKBENCH_ROOT / "templates"


def emit(payload, as_json, human_lines):
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for line in human_lines:
            print(line)
    sys.exit(0 if payload.get("ok") else 1)


THEME_DECL_RE = re.compile(r'DEFAULT_THEME\s*=\s*"([^"]+)"')


def ensure_theme_config(cfg, project: Path, stream=None):
    """
    把工作台最新版 theme_config.py 同步进项目。
    该文件属于工作台基础设施（字体自适应 / TTS 策略 / 语画同步），项目里不要手改；
    若项目自定义过主题，同步时会保留其 DEFAULT_THEME。
    """
    src = templates_dir() / "theme_config.py"
    dst = project / "theme_config.py"
    theme = cfg["default_theme"]
    if dst.exists():
        found = THEME_DECL_RE.search(dst.read_text(encoding="utf-8", errors="replace"))
        if found:
            theme = found.group(1)
    content = src.read_text(encoding="utf-8").replace("{{THEME}}", theme)
    if dst.exists() and dst.read_text(encoding="utf-8", errors="replace") == content:
        return False
    if dst.exists():
        shutil.copyfile(dst, dst.with_name("theme_config.py.bak"))
    dst.write_text(content, encoding="utf-8")
    if stream:
        stream(f"已同步工作台 theme_config.py（主题 {theme}）")
    return True


def discover_scenes(project: Path):
    """返回 [(脚本路径, 场景类名)]，按文件名排序。"""
    scenes = []
    for script in sorted(project.glob("scene_*.py")):
        text = script.read_text(encoding="utf-8", errors="replace")
        for match in SCENE_CLASS_RE.finditer(text):
            name, bases = match.group(1), match.group(2)
            if name.endswith("Scene") or "Scene" in bases:
                scenes.append((script, name))
                break
    return scenes


def manim(cfg, args):
    return [cfg["python"], "-m", "manim", *args]


# ----------------------------------------------------------------------------
# check：环境自检
# ----------------------------------------------------------------------------
def probe_python(cfg):
    code = (
        "import json\n"
        "info = {}\n"
        "try:\n"
        "    import manim; info['manim'] = manim.__version__\n"
        "except Exception as exc:\n"
        "    info['manim_error'] = str(exc)\n"
        "try:\n"
        "    from manimpango import list_fonts\n"
        "    fonts = set(list_fonts())\n"
        "    preferred = ['Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'STHeiti', 'Songti SC', 'Noto Sans CJK SC']\n"
        "    info['cjk_font'] = next((f for f in preferred if f in fonts), None)\n"
        "except Exception as exc:\n"
        "    info['cjk_font_error'] = str(exc)\n"
        "print(json.dumps(info))\n"
    )
    res = run([cfg["python"], "-c", code], timeout=180)
    data = {"python_rc": res["rc"]}
    if res["rc"] == 0 and res["stdout"].strip():
        try:
            data.update(json.loads(res["stdout"].strip().splitlines()[-1]))
        except Exception:  # noqa: BLE001
            data["raw"] = tail(res["stdout"])
    else:
        data["error"] = tail(res["stderr"]) or "python probe failed"
    return data


def cmd_check(args):
    cfg = load_config(args.config)
    checks = {}
    checks["skill_root"] = {
        "path": cfg["skill_root"],
        "ok": (Path(cfg["skill_root"]) / "skills" / "manim-video" / "templates" / "base_scene.py").exists(),
    }
    checks["python"] = {"path": cfg["python"], **probe_python(cfg)}
    ffmpeg = shutil.which("ffmpeg")
    checks["ffmpeg"] = {"path": ffmpeg, "ok": bool(ffmpeg)}
    latex = shutil.which("latex") or shutil.which("pdflatex")
    checks["latex"] = {"path": latex, "ok": bool(latex)}
    dvisvgm = shutil.which("dvisvgm")
    checks["dvisvgm"] = {"path": dvisvgm, "ok": bool(dvisvgm)}
    checks["projects_dir"] = {"path": cfg["projects_dir"], "ok": Path(cfg["projects_dir"]).exists()}

    checks["python"]["ok"] = bool(checks["python"].get("manim")) and bool(checks["python"].get("cjk_font"))
    ok = all(v.get("ok") for v in checks.values())
    payload = {"ok": ok, "config": {"path": cfg["config_path"], "skill_root": cfg["skill_root"], "python": cfg["python"],
                                    "projects_dir": cfg["projects_dir"], "default_theme": cfg["default_theme"]},
               "checks": checks,
               "hint": "全部就绪，可以开始生产" if ok else "存在未就绪项：请检查 python/manim/ffmpeg/latex/中文字体"}
    lines = [f"{'OK ' if v.get('ok') else 'FAIL'} {k}: {v.get('path')}" for k, v in checks.items()]
    emit(payload, args.json, lines)


# ----------------------------------------------------------------------------
# new：创建项目骨架
# ----------------------------------------------------------------------------
def slugify(topic, slug=None):
    if slug:
        return re.sub(r"[^0-9A-Za-z_\-]+", "_", slug).strip("_")
    ascii_part = re.sub(r"[^0-9A-Za-z_\-]+", "_", topic).strip("_")
    stamp = time.strftime("%Y%m%d_%H%M%S")
    return f"{ascii_part}_{stamp}" if ascii_part else f"video_{stamp}"


def cmd_new(args):
    cfg = load_config(args.config)
    topic = args.topic.strip()
    if not topic:
        die("需要提供视频主题")
    slug = slugify(topic, args.slug)
    project = Path(cfg["projects_dir"]) / slug
    if project.exists() and not args.force:
        die(f"项目已存在：{project}（加 --force 覆盖骨架文件）")
    project.mkdir(parents=True, exist_ok=True)

    tpl = templates_dir()
    theme_src = tpl / "theme_config.py"
    script_tpl = (tpl / "script_and_timeline.md").read_text(encoding="utf-8")
    brief_tpl = (tpl / "brief.md").read_text(encoding="utf-8")

    replacements = {
        "{{TOPIC}}": topic,
        "{{SLUG}}": slug,
        "{{THEME}}": args.theme or cfg["default_theme"],
        "{{AUDIENCE}}": args.audience,
        "{{MINUTES}}": str(args.minutes),
    }

    theme_dst = project / "theme_config.py"
    if not theme_dst.exists() or args.force:
        theme_content = theme_src.read_text(encoding="utf-8")
        for key, value in replacements.items():
            theme_content = theme_content.replace(key, value)
        theme_dst.write_text(theme_content, encoding="utf-8")

    for name, content in (("script_and_timeline.md", script_tpl), ("brief.md", brief_tpl)):
        target = project / name
        if target.exists() and not args.force:
            continue
        for key, value in replacements.items():
            content = content.replace(key, value)
        target.write_text(content, encoding="utf-8")

    # project_style.py 归项目所有，工作台永不复写；缺了就补一份空骨架
    style_dst = project / "project_style.py"
    if not style_dst.exists():
        style_dst.write_text((tpl / "project_style.py").read_text(encoding="utf-8"), encoding="utf-8")

    payload = {
        "ok": True,
        "project": str(project),
        "slug": slug,
        "theme": args.theme or cfg["default_theme"],
        "files": sorted(str(p.relative_to(project)) for p in project.glob("*") if p.suffix != ".bak"),
        "next_steps": [
            f"1. 填写 {project}/script_and_timeline.md（时间轴脚本，需用户确认）",
            f"2. 在 {project}/ 下编写 scene_01_*.py 等分幕代码；共用几何放 {project}/project_style.py",
            f"3. videoctl lint  {project}",
            f"4. videoctl qa    {project}   # 单帧质检拼图，用眼睛验收排版",
            f"5. videoctl build {project} --quality h --voice",
        ],
    }
    emit(payload, args.json, [f"项目已创建: {project}"] + payload["next_steps"])


# ----------------------------------------------------------------------------
# lint：静态检查
# ----------------------------------------------------------------------------
VIEWPORT_X, VIEWPORT_Y = 6.3, 3.4
COORD_RE = re.compile(r"move_to\(\s*\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)")


THEME_IMPORT_RE = re.compile(
    r"from\s+theme_config\s+import\s*\(([^)]*)\)|from\s+theme_config\s+import\s+([^\n(]+)|from\s+theme_config\s+import\s+\*"
)


def theme_config_exports():
    """列出工作台 theme_config 对外提供的名字，用于校验项目没把私有装置混进基础设施文件。"""
    text = (templates_dir() / "theme_config.py").read_text(encoding="utf-8")
    names = set(re.findall(r"^(?:def|class)\s+(\w+)", text, re.M))
    names |= set(re.findall(r"^([A-Za-z_]\w*)\s*=", text, re.M))
    names |= set(re.findall(r"^\s{4}([A-Za-z_]\w*)\s*=", text, re.M))
    # theme_config 还从技能基类转出主题与场景类，这些同样允许被分幕导入
    for block in re.findall(r"from\s+base_scene\s+import\s*\(([^)]*)\)", text):
        names |= {line.strip().rstrip(",") for line in block.splitlines() if line.strip()}
    return names


def theme_imports(text):
    """抽出分幕从 theme_config 导入的名字。"""
    names = []
    for match in THEME_IMPORT_RE.finditer(text):
        if match.group(0).rstrip().endswith("*"):
            names.append("*")
            continue
        body = match.group(1) or match.group(2) or ""
        body = "\n".join(line.split("#")[0] for line in body.splitlines())
        for raw in body.split(","):
            name = raw.split(" as ")[-1].strip()
            if name:
                names.append(name)
    return names


def lint_scene(script: Path, scene_name: str, theme_allowed=None):
    text = script.read_text(encoding="utf-8", errors="replace")
    errors, warnings = [], []

    if "def construct" not in text:
        errors.append("缺少 construct() 方法")
    if "DEFAULT_THEME" not in text:
        warnings.append("未声明 DEFAULT_THEME（将使用基类默认主题）")
    if "set_caption" not in text and "voiceover(" not in text and "speech(" not in text:
        warnings.append("没有任何字幕调用（set_caption / speech）")
    if "ENABLE_VOICEOVER = True" in text and "speech(" not in text and "voiceover(" not in text:
        warnings.append("已开启 ENABLE_VOICEOVER 但没有使用 speech()/voiceover() 同步块")

    for match in re.finditer(r"MathTex\(([^)]*)\)", text):
        if CJK_RE.search(match.group(1)):
            errors.append("MathTex 中出现中文，请改用 Text / self.make_text（中文不进 LaTeX）")

    if theme_allowed is not None:
        for name in theme_imports(text):
            if name == "*":
                warnings.append("建议显式列出 theme_config 的导入名，避免遮蔽 manim 的 config 等符号")
            elif name not in theme_allowed:
                errors.append(
                    f"theme_config 里没有 {name}：项目自有的常量/装置请放 project_style.py，"
                    "theme_config.py 由工作台自动同步、会被覆盖"
                )

    for match in re.finditer(r"Text\([^)]*font\s*=\s*[\"']([^\"']+)[\"']", text):
        if match.group(1) not in ("Microsoft YaHei",):
            warnings.append(f"硬编码字体 {match.group(1)!r}：建议使用 self.make_text 走主题字体自适应")

    for match in COORD_RE.finditer(text):
        x, y = float(match.group(1)), float(match.group(2))
        if abs(x) > VIEWPORT_X or abs(y) > VIEWPORT_Y:
            warnings.append(f"move_to({x}, {y}) 可能超出安全视口 |x|<=6.0 |y|<=3.2")

    if "export_timeline" not in text and "finish()" not in text and "ENABLE_VOICEOVER = True" in text:
        warnings.append("开启配音但未导出时间轴：结尾需调用 self.finish() 或 export_timeline(self)")

    return {"script": str(script), "scene": scene_name, "errors": errors, "warnings": warnings}


def cmd_lint(args):
    project = Path(args.project).resolve()
    if not project.exists():
        die(f"项目不存在：{project}")
    scenes = discover_scenes(project)
    if not scenes:
        die(f"未在 {project} 找到 scene_*.py")
    allowed = theme_config_exports()
    results = [lint_scene(script, name, allowed) for script, name in scenes]
    errors = sum(len(r["errors"]) for r in results)
    warnings = sum(len(r["warnings"]) for r in results)
    payload = {"ok": errors == 0, "project": str(project), "scene_count": len(results),
               "error_count": errors, "warning_count": warnings, "results": results}
    lines = [f"{'ERROR' if r['errors'] else 'ok   '} {r['scene']}: {len(r['errors'])} errors / {len(r['warnings'])} warnings" for r in results]
    for r in results:
        lines += [f"    ! {e}" for e in r["errors"]] + [f"    ~ {w}" for w in r["warnings"]]
    emit(payload, args.json, lines)


# ----------------------------------------------------------------------------
# qa：逐幕单帧质检 + 拼图（给模型"看"的排版验收图）
# ----------------------------------------------------------------------------
def media_duration(path: Path):
    res = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], timeout=60)
    try:
        return round(float(res["stdout"].strip()), 2)
    except Exception:  # noqa: BLE001
        return None


def build_contact_sheet(pngs, out_path: Path, cols=2, cell_w=640, cell_h=360):
    """把多张单帧拼成一张总览图，便于模型一眼看清每一幕的版式。"""
    if not pngs:
        return None
    if len(pngs) == 1:
        shutil.copyfile(pngs[0], out_path)
        return out_path
    if not shutil.which("ffmpeg"):
        return None

    per_row = min(cols, len(pngs))
    inputs = []
    for png in pngs:
        inputs += ["-i", str(png)]

    filters = [f"[{i}:v]scale={cell_w}:{cell_h},setsar=1[s{i}]" for i in range(len(pngs))]
    rows = []
    for i in range(0, len(pngs), per_row):
        chunk = list(range(i, min(i + per_row, len(pngs))))
        if len(chunk) == 1:
            filters.append(f"[s{chunk[0]}]pad={cell_w * per_row}:{cell_h}:0:0[r{i // per_row}]")
        else:
            joined = "".join(f"[s{c}]" for c in chunk)
            filters.append(f"{joined}hstack=inputs={len(chunk)}[r{i // per_row}]")
        rows.append(f"[r{i // per_row}]")
    if len(rows) == 1:
        filters.append(f"{rows[0]}null[out]")
    else:
        filters.append(f"{''.join(rows)}vstack=inputs={len(rows)}[out]")

    cmd = ["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(filters), "-map", "[out]", "-frames:v", "1", str(out_path)]
    res = run(cmd, timeout=300)
    return out_path if res["rc"] == 0 and out_path.exists() else None


def cmd_qa(args):
    cfg = load_config(args.config)
    project = Path(args.project).resolve()
    if not project.exists():
        die(f"项目不存在：{project}")
    scenes = discover_scenes(project)
    if args.only:
        wanted = set(args.only)
        scenes = [(s, n) for s, n in scenes if n in wanted or s.name in wanted]
    if not scenes:
        die(f"未在 {project} 找到可质检的分幕")

    ensure_theme_config(cfg, project)

    qa_dir = project / "qa"
    qa_dir.mkdir(parents=True, exist_ok=True)
    results, pngs = [], []
    for index, (script, name) in enumerate(scenes):
        print(f"[qa {index + 1}/{len(scenes)}] 抽取关键帧 {name} ...", file=sys.stderr, flush=True)
        res = run(manim(cfg, ["render", "-s", "-ql", script.name, name]), cwd=project, timeout=args.timeout,
                  env=dict(TTS_ENV_OFFLINE))
        candidates = sorted((project / "media" / "images" / script.stem).glob(f"{name}*.png"),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        entry = {"scene": name, "script": script.name, "ok": bool(candidates) and res["rc"] == 0,
                 "seconds": res["seconds"], "frame": None, "error": None}
        if candidates:
            dest = qa_dir / f"{name}.png"
            shutil.copyfile(candidates[0], dest)
            entry["frame"] = str(dest)
            pngs.append(dest)
        if res["rc"] != 0:
            entry["error"] = clean_error(res["stderr"]) or f"manim 退出码 {res['rc']}"
        results.append(entry)

    sheet = qa_dir / "contact_sheet.png"
    sheet_path = build_contact_sheet(pngs, sheet) if pngs else None
    failed = [r for r in results if not r["ok"]]
    payload = {
        "ok": not failed,
        "project": str(project),
        "quality": "l",
        "scenes": results,
        "contact_sheet": str(sheet_path) if sheet_path else None,
        "failed": [r["scene"] for r in failed],
        "hint": "请打开 contact_sheet 检查排版：字幕是否出界、公式是否重叠、颜色是否可读；发现问题改 scene 代码后重新 qa。",
    }
    lines = [f"{'ok  ' if r['ok'] else 'FAIL'} {r['scene']} ({r['seconds']}s) -> {r['frame']}" for r in results]
    if sheet_path:
        lines.append(f"拼图: {sheet_path}")
    for r in failed:
        lines.append(f"  ! {r['scene']}: {r['error']}")
    emit(payload, args.json, lines)


# ----------------------------------------------------------------------------
# 渲染 / 配音 / 拼接
# ----------------------------------------------------------------------------
def render_scenes(cfg, project, scenes, quality, timeout, stream=None):
    rendered = []
    for index, (script, name) in enumerate(scenes):
        if stream:
            stream(f"[{index + 1}/{len(scenes)}] 渲染 {name} (-q{quality}) ...")
        res = run(manim(cfg, ["render", f"-q{quality}", script.name, name]), cwd=project, timeout=timeout)
        video = project / "media" / "videos" / script.stem / RES_DIR[quality] / f"{name}.mp4"
        rendered.append({"scene": name, "script": script.name, "ok": res["rc"] == 0 and video.exists(),
                         "video": str(video) if video.exists() else None,
                         "seconds": res["seconds"], "error": None if res["rc"] == 0 else (clean_error(res["stderr"]) or f"退出码 {res['rc']}")})
    return rendered


def mix_voiceover(cfg, project, rendered, stream=None):
    """按幕混入配音：读取 voiceover_timeline_<Scene>.json，用技能的 AudioEngine 混流。"""
    templates = Path(cfg["skill_root"]) / "skills" / "manim-video" / "templates"
    if str(templates) not in sys.path:
        sys.path.insert(0, str(templates))
    try:
        from audio_engine import AudioEngine  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return None, f"无法加载 AudioEngine: {exc}"

    out_dir = project / "voiced"
    out_dir.mkdir(exist_ok=True)
    mixed = []
    for entry in rendered:
        timeline = project / f"voiceover_timeline_{entry['scene']}.json"
        if not entry["ok"] or not timeline.exists():
            mixed.append(entry["video"])
            continue
        tracks = json.loads(timeline.read_text(encoding="utf-8"))
        if not tracks:
            mixed.append(entry["video"])
            continue
        target = out_dir / f"{entry['scene']}_voiced.mp4"
        if stream:
            stream(f"混音 {entry['scene']}：{len(tracks)} 段配音")
        ok = AudioEngine.mix_scene_audio(
            video_path=entry["video"],
            audio_files_with_offsets=[(t["audio"], t["start_time"]) for t in tracks],
            output_path=str(target),
        )
        mixed.append(str(target) if ok else entry["video"])
    return mixed, None


def stitch(videos, output: Path):
    list_file = output.parent / "concat_list.txt"
    with open(list_file, "w", encoding="utf-8") as handle:
        for video in videos:
            handle.write(f"file '{Path(video).resolve().as_posix()}'\n")
    res = run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(output)], timeout=900)
    if res["rc"] != 0 or not output.exists():
        res = run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(list_file),
                   "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", str(output)], timeout=1800)
    list_file.unlink(missing_ok=True)
    return res["rc"] == 0 and output.exists()


def scene_timelines(project: Path, scenes):
    """只取当前分幕对应的配音时间轴；改名或重做后残留的旧 timeline 不参与统计。"""
    files = sorted(project.glob("voiceover_timeline_*.json"))
    prefix = "voiceover_timeline_"
    names = {name for _script, name in scenes}
    matched = [p for p in files if p.stem[len(prefix):] in names]
    return matched or files


def produce(cfg, project, quality, want_voice, output=None, stream=None):
    scenes = discover_scenes(project)
    if not scenes:
        return {"ok": False, "error": f"未在 {project} 找到 scene_*.py"}

    ensure_theme_config(cfg, project, stream=stream)

    for stale in ("tts_warnings.json", "tts_stats.json"):
        (project / stale).unlink(missing_ok=True)

    rendered = render_scenes(cfg, project, scenes, quality, cfg["render_timeout_sec"], stream=stream)
    failed = [r for r in rendered if not r["ok"]]
    if failed:
        return {"ok": False, "stage": "render", "rendered": rendered,
                "error": "; ".join(f"{r['scene']}: {r['error']}" for r in failed)}

    timelines = scene_timelines(project, scenes)
    use_voice = want_voice and bool(timelines)
    videos = [r["video"] for r in rendered]
    voice_error = None
    if use_voice:
        videos, voice_error = mix_voiceover(cfg, project, rendered, stream=stream)
        if videos is None:
            videos = [r["video"] for r in rendered]
            use_voice = False

    suffix = "_final_voiced.mp4" if use_voice else "_final.mp4"
    out_path = Path(output) if output else project / f"{project.name}{suffix}"
    if stream:
        stream(f"拼接 {len(videos)} 幕 -> {out_path.name}")
    if not stitch(videos, out_path):
        return {"ok": False, "stage": "stitch", "error": "ffmpeg 拼接失败", "rendered": rendered}

    payload = {
        "ok": True,
        "project": str(project),
        "quality": quality,
        "voiced": use_voice,
        "output": str(out_path),
        "duration_sec": media_duration(out_path),
        "size_mb": round(out_path.stat().st_size / 1024 / 1024, 2),
        "scenes": [{"scene": r["scene"], "render_seconds": r["seconds"], "video": r["video"]} for r in rendered],
        "voice_tracks": sum(len(json.loads(t.read_text(encoding="utf-8"))) for t in timelines) if timelines else 0,
        "voice_error": voice_error,
        "tts_failures": read_jsonl(project / "tts_warnings.json"),
        "tts_stats": _tts_stats(read_jsonl(project / "tts_stats.json")),
    }
    if payload["tts_failures"] and not use_voice:
        payload["hint"] = (f"{len(payload['tts_failures'])} 句配音合成失败（多为网络不通），成片为无声；"
                           "可联网后重跑 build，已成功合成的句子会命中缓存不会重复请求。")
    (project / "workbench_report.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def progress(message):
    """流水线进度：写到 stderr，便于上层（Pi 扩展）实时转发给用户。"""
    print(message, file=sys.stderr, flush=True)


def cmd_preview(args):
    cfg = load_config(args.config)
    project = Path(args.project).resolve()
    quality = args.quality or cfg["preview_quality"]
    payload = produce(cfg, project, quality, want_voice=True, output=args.output, stream=progress)
    emit(payload, args.json, [f"预览: {payload.get('output')} ({payload.get('duration_sec')}s)"] if payload.get("ok") else [payload.get("error", "失败")])


def cmd_build(args):
    cfg = load_config(args.config)
    project = Path(args.project).resolve()
    quality = args.quality or cfg["final_quality"]
    want_voice = not args.no_voice
    if args.voice:
        want_voice = True
    payload = produce(cfg, project, quality, want_voice=want_voice, output=args.output, stream=progress)
    stats = payload.get("tts_stats") or {}
    stats_text = f"配音 缓存{stats.get('cache', 0)}/新合成{stats.get('synth', 0)}/估算{stats.get('estimate', 0)}"
    lines = [f"成片: {payload.get('output')}  {payload.get('duration_sec')}s  {payload.get('size_mb')}MB  {stats_text}"]
    if payload.get("tts_failures"):
        lines.append(f"注意: {len(payload['tts_failures'])} 句配音合成失败 -> {payload.get('hint')}")
    emit(payload, args.json, lines if payload.get("ok") else [f"失败: {payload.get('error')}"])


# ----------------------------------------------------------------------------
# storyboard / report / list
# ----------------------------------------------------------------------------
def cmd_storyboard(args):
    cfg = load_config(args.config)
    project = Path(args.project).resolve()
    script = Path(cfg["skill_root"]) / "skills" / "manim-video" / "scripts" / "storyboard_generator.py"
    if not script.exists():
        die(f"未找到故事板脚本：{script}")
    cmd = [cfg["python"], str(script), str(project)]
    if args.output:
        cmd += ["-o", args.output]
    if args.title:
        cmd += ["-t", args.title]
    res = run(cmd, timeout=600)
    html = Path(args.output) if args.output else project / "storyboard.html"
    payload = {"ok": res["rc"] == 0 and html.exists(), "project": str(project),
               "storyboard": str(html) if html.exists() else None, "log": tail(res["stdout"] + res["stderr"])}
    emit(payload, args.json, [f"故事板: {payload['storyboard']}" if payload["ok"] else payload["log"]])


def cmd_report(args):
    cfg = load_config(args.config)
    project = Path(args.project).resolve()
    if not project.exists():
        die(f"项目不存在：{project}")
    scenes = discover_scenes(project)
    artifacts = []
    seen = set()
    for pattern in ("*_final_voiced.mp4", "*_final.mp4", "*.mp4", "qa/contact_sheet.png", "storyboard.html"):
        for path in sorted(project.glob(pattern)):
            if path in seen:
                continue
            seen.add(path)
            artifacts.append({"path": str(path), "size_mb": round(path.stat().st_size / 1024 / 1024, 3),
                              "duration_sec": media_duration(path) if path.suffix == ".mp4" else None})
    timelines = {}
    for path in scene_timelines(project, scenes):
        try:
            timelines[path.stem] = len(json.loads(path.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            timelines[path.stem] = None
    payload = {"ok": True, "project": str(project), "scenes": [{"script": s.name, "scene": n} for s, n in scenes],
               "script_filled": (project / "script_and_timeline.md").exists(),
               "voiceover_segments": timelines, "artifacts": artifacts,
               "finished": any(a["path"].endswith(".mp4") for a in artifacts)}
    lines = [
        f"{a['path']}  {a['size_mb']}MB" + (f"  {a['duration_sec']}s" if a.get("duration_sec") else "")
        for a in artifacts
    ] or ["暂无产物"]
    lines.append(f"分幕 {len(scenes)} ｜ 配音段数 {sum(v for v in timelines.values() if v)}")
    emit(payload, args.json, lines)


def cmd_list(args):
    cfg = load_config(args.config)
    root = Path(cfg["projects_dir"])
    items = []
    for project in sorted(p for p in root.glob("*") if p.is_dir()):
        scenes = discover_scenes(project)
        finals = sorted(project.glob("*_final*.mp4")) or sorted(project.glob("*.mp4"))
        items.append({"project": project.name, "path": str(project), "scenes": len(scenes),
                      "final": str(finals[0]) if finals else None})
    emit({"ok": True, "projects_dir": str(root), "count": len(items), "projects": items}, args.json,
         [f"{i['scenes']:>2} 幕  {i['project']:<32} {i['final'] or '(未出片)'}" for i in items] or ["还没有任何项目"])


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(prog="videoctl", description="数学视频全自动生产流水线（确定性执行层）")
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON（智能体默认使用）")
    parser.add_argument("--config", default=None, help="工作台配置文件路径")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="环境自检").set_defaults(func=cmd_check)

    p_new = sub.add_parser("new", help="创建项目骨架")
    p_new.add_argument("topic")
    p_new.add_argument("--slug")
    p_new.add_argument("--theme")
    p_new.add_argument("--audience", default="理工科本科生")
    p_new.add_argument("--minutes", type=int, default=2)
    p_new.add_argument("--force", action="store_true")
    p_new.set_defaults(func=cmd_new)

    p_lint = sub.add_parser("lint", help="场景代码静态检查")
    p_lint.add_argument("project")
    p_lint.set_defaults(func=cmd_lint)

    p_qa = sub.add_parser("qa", help="逐幕单帧质检并拼图")
    p_qa.add_argument("project")
    p_qa.add_argument("--only", nargs="*", help="只质检指定场景类名或脚本名")
    p_qa.add_argument("--timeout", type=int, default=600)
    p_qa.set_defaults(func=cmd_qa)

    p_prev = sub.add_parser("preview", help="低清预览成片（含配音）")
    p_prev.add_argument("project")
    p_prev.add_argument("--quality", choices=list(RES_DIR), default=None)
    p_prev.add_argument("--output", default=None)
    p_prev.set_defaults(func=cmd_preview)

    p_build = sub.add_parser("build", help="高清渲染 + 配音 + 拼接出成片")
    p_build.add_argument("project")
    p_build.add_argument("--quality", choices=list(RES_DIR), default=None)
    p_build.add_argument("--voice", action="store_true", help="强制启用配音")
    p_build.add_argument("--no-voice", action="store_true", help="禁用配音")
    p_build.add_argument("--output", default=None)
    p_build.set_defaults(func=cmd_build)

    p_sb = sub.add_parser("storyboard", help="生成 HTML 故事板看板")
    p_sb.add_argument("project")
    p_sb.add_argument("--output", default=None)
    p_sb.add_argument("--title", default=None)
    p_sb.set_defaults(func=cmd_storyboard)

    p_rep = sub.add_parser("report", help="汇总项目产物")
    p_rep.add_argument("project")
    p_rep.set_defaults(func=cmd_report)

    sub.add_parser("list", help="列出全部项目").set_defaults(func=cmd_list)

    # 允许 --json 出现在子命令之后（对智能体更友好）：统一提到最前面
    argv = sys.argv[1:]
    json_flags = argv.count("--json")
    if json_flags:
        argv = ["--json"] * json_flags + [a for a in argv if a != "--json"]
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
