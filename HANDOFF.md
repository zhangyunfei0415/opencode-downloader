# HANDOFF · opencode-downloader 项目交接手册

> **历史文档 / Historical document:** 以下保留 DeepSeek V4.1 Flash 的初版交接记录。
> 1.1.0 已调整取消、重试、临时文件、会话通知和开发检查行为；当前使用说明以 README.md 为准，变更见 CHANGELOG.md。

> 写给「接手这个项目的自己或下一个 AI」。
> 读完这份 + `README.md` + 源码，就能独立维护、扩展、发布这个项目。

---

## 一、这是什么

给 **OpenCode V2** 用的**后台下载器插件**（单文件、零依赖）。

核心价值有三点，按重要性排：

1. **⭐ 下载完成后主动唤醒 AI**（最大差异点）
2. 网页 GUI 进度面板
3. 限速

**一句话定位**：让 AI 能「派活下载 → 去干别的 → 下载完自己回来接着干」。

---

## 二、当前状态

| 项 | 状态 |
|---|---|
| 版本 | v1.0.0（未发布） |
| 代码 | `downloader.ts`，632 行 / 26.3 KB |
| 依赖 | **零**（只用 Node 内置模块） |
| 测试 | 在 Windows 11 + OpenCode V2 + Node 24 上**全功能实测通过** |
| 平台 | 主要在 Windows 验证；理论跨平台（代码无 Windows 专有 API，但 `dl.open` 用了 `cmd.exe /c start`） |

### 已实测通过的功能

| 功能 | 验证方式 | 结果 |
|---|---|---|
| HTTP 下载 | 1.46 GB 文件 | ✅ |
| 进度/速度/ETA | GUI + `dl.list` | ✅ 准确 |
| **自动唤醒** | 多次触发 | ✅ **实测收到推送** |
| 限速 | 设 2 MB/s | ✅ 精确 2.0 MB/s |
| 取消 + 清理分片 | 取消 1.46GB 任务 | ✅ 分片被删 |
| 重试 / 删除 / 清空 | GUI 按钮 + 工具 | ✅ |
| Ollama 拉取 | 拉 16.52 GB 模型 | ✅ 按分片汇总总进度 |
| 跨插件重载存活 | 下载中改了 3 次源码 | ✅ 未中断 |
| 镜像回退 | 内置 4 个 GitHub 镜像 | ✅（代码逻辑，未强测） |
| sha256 校验 | 代码逻辑 | ⚠️ 未实测 |

---

## 三、源码结构（`downloader.ts` 分段导读）

```
1.  顶部常量
    - GUI_PORT = 17890        面板端口
    - DEFAULT_DIR             默认下载目录 ~/Downloads/opencode-dl
    - MAX_CONCURRENT = 3      并发数
    - MIRRORS[]               4 个 GitHub 加速镜像

2.  类型定义
    Task { id, kind: "http"|"ollama", url, name, dest, status, total,
           received, speed, startedAt, endedAt, error, sha256, mirrored,
           sessionID, notified, notifyResult, digests, limitBps }

3.  setup(ctx)
    ├── 全局共享状态 store = globalThis.__ocDownloader
    │     { tasks, controllers, running, server, activeSessionID, cfg }
    ├── ctx.tool.hook("execute.before") → 捕获 activeSessionID
    ├── notifyDone(t, ok)      ⭐ 核心：往会话推消息
    ├── pullOllama(t)          走 /api/pull 流式 NDJSON
    ├── download(t)            HTTP 下载（流式 + pacing 限速 + 镜像回退）
    ├── pump()                 并发调度（最多 3 个）
    ├── HTML 常量              GUI 页面（内联字符串）
    ├── startGui()             HTTP 服务：/ + /api/tasks + /api/{cancel,retry,remove}
    └── ctx.tool.transform()   注册 9 个工具
```

### 关键设计决策（改动前必读）

| 决策 | 原因 |
|---|---|
| **状态放 `globalThis`** | 插件每次重载都新建实例；不共享就会丢任务列表/配置 |
| **`startGui()` 检查 `server.listening`** | 旧实例可能仍占着端口，盲目 `listen` 会 EADDRINUSE 且静默失败 → 面板空白 |
| **cleanup 返回空函数** | 不要 close 共享的 server，否则重载后面板挂掉 |
| **限速用手动 pacing 而非流控** | `for await` 逐 chunk 写 + 按字节数追赶理论时间，简单可靠 |
| **不用 `pipeline()`** | 限速需要逐块介入，`pipeline` 无法插入延迟 |
| **HTML 内联而不是独立文件** | 插件是单文件发布，避免路径解析问题 |
| **不 import `@opencode/plugin`** | 本地插件目录解析不到该包；`Plugin.define` 是恒等函数，直接导出对象即可 |

---

## 四、开发环境准备

```powershell
# 1) 插件目录（Windows）
$pluginDir = "$env:USERPROFILE\.config\opencode\plugins"

# 2) 改完源码后热加载，看日志确认
Get-Content "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Tail 20 |
  Select-String "loading plugin|failed to load"

# 3) GUI 端口占用排查
netstat -ano | findstr ":17890"
```

> ⚠️ **改源码会重载插件** → **进行中的 ollama pull 会被中断**（客户端断开，Ollama 会取消拉取）。开发时注意。

### 调试技巧

| 想看什么 | 怎么看 |
|---|---|
| 任务实时状态 | `dl.list` 或 `curl http://127.0.0.1:17890/api/tasks` |
| 通知是否发出 | 看任务里的 `notifyResult` 字段（✅ prompt 已注入会话 / ⚠️ 失败原因） |
| 通知日志 | `%TEMP%\downloader-notify.log` |
| Ollama 拉取细节 | `%LOCALAPPDATA%\Ollama\server.log` |

---

## 五、已知问题 / TODO

### 已知问题

| 问题 | 影响 | 可能解法 |
|---|---|---|
| Ollama 拉取**无法限速** | 游戏时拉模型会抢带宽 | 无解（下载在 Ollama 服务侧）；或改用 HTTP 直接下 GGUF |
| 任务列表**不持久化** | OpenCode 重启后清空 | 存文件到 `~/.config/opencode/` 或 `ctx.storage` |
| 不支持**断点续传** | 大文件中途失败要重来 | 记录已下载字节 + `Range` 请求；Ollama 那侧它自己支持 |
| `dl.open` 依赖 `cmd.exe` | 非 Windows 平台失效 | 按 `process.platform` 分支：`open`(mac) / `xdg-open`(linux) |
| 面板只在 127.0.0.1 | 无法远程看 | 可配置 bind 地址（注意安全） |
| 没有上传/多线程分段下载 | 单连接速度受限 | 见 TODO |

### TODO（按价值排序）

1. **持久化任务列表**（重载/重启不丢）
2. **断点续传**（`Range` + 临时 `.part` 文件）
3. **跨平台 `dl.open`**
4. **多线程分段下载**（提速，但对服务器不友好，慎做）
5. **GUI 增强**：全局速度图表、任务分组、拖拽排序
6. **通知去重/聚合**（多个任务完成时合并成一条消息）
7. **发布到 npm**（让别人 `plugins: ["opencode-downloader"]` 就能装）

---

## 六、部署到新机器

```powershell
# 1) 放插件
Copy-Item .\downloader.ts "$env:USERPROFILE\.config\opencode\plugins\" -Force

# 2) 重启 OpenCode

# 3) 验证
#    让 AI 执行：dl.open
#    或浏览器打开 http://127.0.0.1:17890/
```

**零依赖**，不需要 `npm install`。

---

## 七、发布到 GitHub 的清单

### 建议仓库名
`opencode-downloader` 或 `opencode-plugin-downloader`

### 发布前 checklist

- [x] `README.md`（含截图 + 功能 + 用法 + 原理 + 限制）
- [x] `LICENSE`（MIT）
- [x] `package.json`（元信息，为将来发 npm 铺路）
- [x] `.gitignore`
- [x] `docs/screenshot.png`（GUI 截图）
- [x] `HANDOFF.md`（本文件）
- [ ] **再通读一遍源码，删掉任何本机专属信息**（当前 `downloader.ts` 已确认无硬编码个人路径、无 API key）
- [ ] 可选：加 `CHANGELOG.md`
- [ ] 可选：加 GitHub Actions（lint / `node --check`）

### 发布命令

```bash
git init
git add .
git commit -m "feat: initial release of opencode-downloader v1.0.0"
git branch -M main
git remote add origin https://github.com/<你的用户名>/opencode-downloader.git
git push -u origin main
```

### 建议的仓库描述（GitHub About）

> 给 OpenCode 用的后台下载器插件：网页进度面板 + **下载完自动唤醒 AI** + 限速

### 建议 Topics

`opencode` `opencode-plugin` `downloader` `ai-agent` `ollama` `typescript`

---

## 八、给下一个 AI 的话

如果你是被叫来继续开发这个项目的：

1. **先读 `README.md` 的「工作原理」一节** —— 那里解释了最关键的「主动唤醒」机制，是理解全项目的钥匙
2. **别动 `globalThis` 共享状态那段** —— 那是踩了坑之后的设计，去掉会引发「重载丢任务」「面板空白」两个 bug
3. **改源码前先确认没有正在跑的下载** —— 重载会中断 Ollama pull
4. **测试要写成 `.ps1` 用 shell 跑** —— OpenCode 的 Code Mode 运行时没有 `AbortController`/`setTimeout`，长任务测试在那里跑不了
5. **Windows 上用 `pwsh` 7**，不要用 PowerShell 5.1（UTF-8 编码会炸）
6. 项目的**实测数据**可以参考这些脚本的思路：
   - `bench-*.ps1`（在 `%TEMP%\opencode\`）：用 curl 调 Ollama API + `nvidia-smi` 采样显存

### 这个项目最值得骄傲的一点

**「下载完自动唤醒 AI」** 这个能力，在 OpenCode 生态里（截至 2026-10）没有现成的开源实现 —— 大部分同类插件（`opencode-notify` 等）只做「弹通知」，不会把消息推进会话让 AI 继续。

实现它的关键是找到了 `ctx.session.prompt({ sessionID, text, delivery: "queue" })` 这个 V2 API，以及用 `ctx.tool.hook("execute.before")` 捕获会话 ID。

**如果你要写宣传语，就突出这一点。**
