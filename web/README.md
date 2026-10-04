# Web 工作台

把「说一个主题 → 拿到成片」做成网页。

## 启动

```bash
bin/web            # 启动并自动打开 http://127.0.0.1:5180
PORT=8080 bin/web  # 换端口
```

## 三层结构

```
浏览器  ──SSE──▶  web/server.mjs  ──JSONL──▶  pi --mode rpc   （决策层）
                       │
                       └──子进程──▶  tools/videoctl.py        （执行层）
```

- **决策层**：Pi 以长驻子进程方式运行（`--mode rpc`），复用你已登录的模型与已安装的扩展；
  服务启动时显式带上 `--extension / --skill / --prompt-template`，所以不依赖 `pi install` 也能跑。
- **执行层**：`videoctl.py` 的每个子命令都变成 HTTP 接口，按钮直接触发，不经过模型。
- **传输**：一条 SSE（`/api/events`）把模型输出、工具进度、任务日志统一推给前端。

## 接口

| 方法 | 路径 | 作用 |
| :--- | :--- | :--- |
| GET | `/api/events` | SSE 事件流 |
| GET | `/api/status` | Pi 是否就绪、当前模型、技能仓库路径 |
| POST | `/api/prompt` | 发一句话给智能体（忙碌时自动排队） |
| POST | `/api/abort` | 停止当前生产 |
| POST | `/api/new-session` | 开新对话 |
| GET | `/api/projects` | 项目列表（`videoctl list`） |
| GET | `/api/report?project=` | 单个项目的产物汇总（`videoctl report`） |
| GET | `/api/history` | 上一次对话的记录（含工具卡片与质检图），刷新页面不丢上下文 |
| GET | `/api/tasks` | 当前正在跑的确定性任务（刷新页面也能把任务日志接回来） |
| GET | `/api/model` | 当前模型配置（Key 只回掩码） |
| POST | `/api/model` | 保存 BYOK 配置并重启模型连接 |
| DELETE | `/api/model` | 清空工作台的模型配置（不动 `~/.pi`） |
| POST | `/api/model/discover` | 用给定的地址与 Key 拉取可用模型列表 |
| POST | `/api/model/import` | 沿用本机 `~/.pi` 里已经在用的 provider |
| POST | `/api/run` | 直接跑确定性任务：`lint` / `qa` / `build` / `preview` / `storyboard` |
| GET | `/api/file?path=` | 读视频/图片/故事板，支持 Range（视频可拖动进度条） |

服务端启动 Pi 时带了 `--continue`，所以**服务重启也不会丢上下文**，刷新页面会自动把上一轮对话画回来。

## 模型配置（BYOK）

工作台不绑定任何服务商，模型和 Key 都在界面右上角的「⚙ 模型」里填：

- **预设**：OpenAI、Claude、DeepSeek、Kimi、智谱 GLM、通义千问、硅基流动、OpenRouter、Gemini，以及本机的 Ollama / LM Studio；
- **填法**：选地址 → 点「拉取模型列表」→ 挑一个模型 → 保存并重启。地址是本机时 Key 可以留空；
- **落盘**：配置写在 `web/.agent/`（目录 700，文件 600），Key 不回显、不上传，也不读写你的 `~/.pi`；
- **换回来**：想用本机 Pi 里已经配好的模型，点「导入本机 Pi 配置」；想重新开始就「清空配置」。

保存后会重启 Pi 子进程（会话用 `--continue` 接回来，上下文不丢）；「正在生产」时不让改，避免打断渲染。

模型报错会翻译成人话并留在对话里，例如：

```
API Key 不对或已失效，去「⚙ 模型」里重新填一次。
这个地址上没有该模型：400 Model "xxx" is not supported on this endpoint.
这个 Key 没有该模型的权限：403 MODEL_NOT_IN_PLAN ...
```

## 安全边界

- `/api/file` 只放行 `<技能仓库>/projects/**` 与工作台自身目录，路径穿越会被拒绝；
- `/api/run` 的命令走白名单，参数以数组形式传给子进程，不经过 shell；
- 同一个项目同时只允许一个确定性任务（`qa` 与 `build` 抢同一个项目会把产物搅乱），冲突时返回 409 与一句人话；
- 服务默认只监听 `127.0.0.1`。要给别人访问，请自行加反向代理与鉴权，不要直接暴露端口。

## 前端交互要点

- 模型每次调用工具都会画成一张卡片：进行中显示 Spinner 与实时进度，完成后折叠，**带图的工具（质检）会自动展开图片**；
- 工具结果不是裸 JSON：成片卡片内嵌播放器、质检卡片直接显示拼图与逐幕耗时；原始输出收在「运行日志与原始输出」里，需要时再展开；
- AI 回复按轻量 markdown 排版（标题/列表/引用/加粗/行内代码），`\( … \)` 与 `\[ … \]` 公式用本地打包的 KaTeX 渲染，**离线可用**；
- 回复里出现的成片、质检图路径会自动变成可点开的链接；
- 图片点击可放大；
- 右侧产物面板：成片可直接播放/下载，质检总览图可放大，还有「重新质检 / 快速预览 / 1080p60 重出片」按钮；
- 窗口变窄时三栏自动堆叠，不会隐藏任何内容。
