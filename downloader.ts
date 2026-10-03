/**
 * downloader — 下载器插件（V2 插件 API）
 *
 * 三个能力：
 *   1. 后台下载（支持镜像回退、进度、速度、ETA、sha256 校验）
 *   2. 本地 Web GUI 面板（浏览器里看所有任务与进度，1 秒自刷新）
 *   3. ⭐ 下载完成后**主动往会话里推消息**唤醒 agent 继续干活（不用轮询）
 *
 * 工具：
 *   dl.add     添加下载任务（后台跑）
 *   dl.list    查看任务与进度（文本）
 *   dl.cancel  取消任务
 *   dl.retry   重试任务
 *   dl.open    在浏览器打开 GUI 面板
 *   dl.config  查看/修改配置（下载目录、自动通知、镜像）
 */
import { createWriteStream, existsSync, mkdirSync, linkSync, unlinkSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { join, basename, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createServer } from "node:http"
import { execFile } from "node:child_process"
import { appendFileSync } from "node:fs"

const NOTIFY_LOG = join(tmpdir(), "downloader-notify.log")
function logNotify(s: string) {
  try {
    appendFileSync(NOTIFY_LOG, `${new Date().toISOString()} ${s}\n`)
  } catch {}
}

const GUI_PORT = 17890
const DEFAULT_DIR = join(homedir(), "Downloads", "opencode-dl")
const MAX_CONCURRENT = 3

type Status = "queued" | "downloading" | "verifying" | "done" | "failed" | "canceled"

type Task = {
  id: string
  kind: "http" | "ollama"
  url: string
  name: string
  dest: string
  status: Status
  total: number
  received: number
  speed: number // B/s
  startedAt: number
  endedAt?: number
  error?: string
  sha256?: string
  mirrored?: boolean
  sessionID?: string
  notified?: boolean
  notifyResult?: string
  digests?: Record<string, { completed: number; total: number }>
  limitBps?: number
  autoMirror?: boolean
}

function validName(name: string) {
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    throw new Error("无效文件名 / Invalid filename")
  return name
}

function rate(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("限速必须是非负有限数 / Rate must be finite and nonnegative")
  return value * 1024 * 1024
}

function terminal(t: Task) {
  return ["done", "failed", "canceled"].includes(t.status)
}

// 常见 GitHub 加速镜像（按需自动回退）
const MIRRORS = [
  (u: string) => u,
  (u: string) => "https://ghfast.top/" + u,
  (u: string) => "https://ghproxy.net/" + u,
  (u: string) => "https://gh-proxy.com/" + u,
]

function human(n: number): string {
  if (!n || n < 0) return "-"
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB"
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB"
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB"
  return n + " B"
}

function eta(t: Task): string {
  if (!t.total || !t.speed || t.status !== "downloading") return "-"
  const left = t.total - t.received
  const s = Math.round(left / t.speed)
  if (s < 60) return s + "s"
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s"
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m"
}

export default {
  id: "downloader",
  async setup(ctx: any) {
    // 跨重载共享状态（避免重载后旧实例占着端口、面板显示空数据、设置丢失）
    const G: any = globalThis as any
    const store = G.__ocDownloader || (G.__ocDownloader = {
      tasks: new Map<string, Task>(),
      controllers: new Map<string, AbortController>(),
      running: 0,
      server: null as any,
      activeSessionID: undefined as string | undefined,
      cfg: null as any,
    })
    const cfg = store.cfg || (store.cfg = {
      dir: DEFAULT_DIR,
      autoNotify: true,
      autoMirror: true,
      guiPort: GUI_PORT,
      maxMbps: 0, // 0 = 不限速；>0 = 全局限速（MB/s）
    })
    const tasks: Map<string, Task> = store.tasks
    const controllers: Map<string, AbortController> = store.controllers

    // 从工具 hook 捕获会话 ID（通知要用）
    ctx.tool.hook("execute.before", (event: any) => {
      if (event?.sessionID) store.activeSessionID = event.sessionID
    })

    mkdirSync(cfg.dir, { recursive: true })

    // ---------- 通知：往会话里推消息，唤醒 agent ----------
    async function notifyDone(t: Task, ok: boolean) {
      if (!cfg.autoNotify || t.notified) return
      t.notified = true
      const sid = t.sessionID
      const text = ok
        ? `✅ 下载完成：${t.name}\n路径: ${t.dest}\n大小: ${human(t.received)}${t.mirrored ? "（镜像回退）" : ""}\n请继续之前的工作。`
        : `❌ 下载失败：${t.name}\nURL: ${t.url}\n原因: ${t.error || "未知"}\n请决定是否重试。`
      try {
        if (sid && ctx.session?.prompt) {
          await ctx.session.prompt({ sessionID: sid, text, delivery: "queue" })
          t.notifyResult = "✅ prompt 已注入会话"
          logNotify(`prompt ok → ${sid}`)
          return
        }
        t.notifyResult = sid ? "⚠️ 无 prompt API" : "⚠️ 未捕获会话ID"
        logNotify(t.notifyResult)
      } catch (e: any) {
        t.notifyResult = `⚠️ prompt 失败: ${String(e?.message || e)}`
        logNotify(String(t.notifyResult))
      }
      try {
        if (sid && ctx.session?.synthetic) {
          await ctx.session.synthetic({ sessionID: sid, text, description: "下载完成通知" })
          t.notifyResult = (t.notifyResult ? t.notifyResult + "；" : "") + "✅ synthetic 已注入"
          logNotify(`synthetic ok → ${sid}`)
        }
      } catch (e: any) {
        logNotify(`synthetic failed: ${String(e?.message || e)}`)
      }
    }

    // ---------- Ollama 拉取（走 /api/pull 流式进度）----------
    async function pullOllama(t: Task) {
      t.status = "downloading"
      t.startedAt = Date.now()
      t.received = 0
      t.total = 0
      t.digests = {}
      const ac = new AbortController()
      controllers.set(t.id, ac)
      let lastTick = Date.now()
      let lastBytes = 0
      try {
        const res = await fetch("http://127.0.0.1:11434/api/pull", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: t.name, stream: true }),
          signal: ac.signal,
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const reader = (res.body as any).getReader()
        const dec = new TextDecoder()
        let buf = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split("\n")
          buf = lines.pop() || ""
          for (const line of lines) {
            if (!line.trim()) continue
            let j: any
            try {
              j = JSON.parse(line)
            } catch {
              continue
            }
            if (j.error) throw new Error(String(j.error))
            if (j.digest && j.total) {
              t.digests![j.digest] = { completed: j.completed || 0, total: j.total }
              const vs = Object.values(t.digests!)
              t.received = vs.reduce((s: number, d: any) => s + d.completed, 0)
              t.total = vs.reduce((s: number, d: any) => s + d.total, 0)
              const now = Date.now()
              if (now - lastTick >= 1000) {
                const inst = (t.received - lastBytes) / ((now - lastTick) / 1000)
                t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst
                lastTick = now
                lastBytes = t.received
              }
            } else if (j.status === "success") {
              t.status = "done"
            }
          }
        }
        if (ac.signal.aborted) throw new Error("Canceled")
        if (t.status !== "done") throw new Error("Ollama stream ended without success")
        t.endedAt = Date.now()
        t.speed = 0
        controllers.delete(t.id)
        void notifyDone(t, true)
      } catch (e: any) {
        controllers.delete(t.id)
        if (ac.signal.aborted) return
        t.status = "failed"
        t.endedAt = Date.now()
        t.error = String(e?.message || e)
        void notifyDone(t, false)
      }
    }

    // ---------- 下载引擎 ----------
    async function download(t: Task) {
      if (t.kind === "ollama") return pullOllama(t)
      const target = t.dest
      const partial = `${target}.${t.id}.part`
      t.status = "downloading"
      t.startedAt = Date.now()
      t.received = 0
      t.error = undefined
      t.notified = false

      const github = ["github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"].includes(new URL(t.url).hostname)
      const urls = (t.autoMirror ?? cfg.autoMirror) && github ? MIRRORS.map((f) => f(t.url)) : [t.url]
      let lastErr = ""

      for (let i = 0; i < urls.length; i++) {
        const ac = new AbortController()
        controllers.set(t.id, ac)
        try {
          if (existsSync(target)) throw new Error("目标文件已存在 / Destination already exists")
          t.status = "downloading"
          t.speed = 0
          const res = await fetch(urls[i], {
            headers: { "user-agent": "Mozilla/5.0 (opencode-downloader)" },
            signal: ac.signal,
            redirect: "follow",
          })
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

          t.total = Number(res.headers.get("content-length") || 0)
          t.mirrored = i > 0
          t.received = 0
          const hash = createHash("sha256")
          let lastTick = Date.now()
          let lastBytes = 0

          const rs = Readable.fromWeb(res.body as any)
          const ws = createWriteStream(partial, { flags: "wx" })
          const limit = t.limitBps ?? (cfg.maxMbps > 0 ? cfg.maxMbps * 1024 * 1024 : 0)
          const t0 = Date.now()
          let written = 0
          await pipeline(rs, async function* (source) {
            for await (const chunk of source) {
              const buf = chunk as Buffer
              written += buf.length
              t.received += buf.length
              hash.update(buf)
              const now = Date.now()
              if (now - lastTick >= 1000) {
                const inst = (t.received - lastBytes) / ((now - lastTick) / 1000)
                t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst
                lastTick = now
                lastBytes = t.received
              }
              // 限速：按已写字节数追赶理论时间
              if (limit > 0) {
                const expectedMs = (written / limit) * 1000
                const actualMs = Date.now() - t0
                if (expectedMs > actualMs) {
                  await delay(expectedMs - actualMs, undefined, { signal: ac.signal })
                }
              }
              yield buf
            }
          }, ws, { signal: ac.signal })
          ac.signal.throwIfAborted()

          // 校验
          if (t.sha256) {
            t.status = "verifying"
            const got = hash.digest("hex")
            if (got.toLowerCase() !== t.sha256.toLowerCase()) {
              throw new Error(`sha256 不匹配（期望 ${t.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`)
            }
          }

          // Atomic publication without replacing an existing destination.
          linkSync(partial, target)
          unlinkSync(partial)
          t.status = "done"
          t.endedAt = Date.now()
          t.speed = 0
          controllers.delete(t.id)
          void notifyDone(t, true)
          return
        } catch (e: any) {
          controllers.delete(t.id)
          lastErr = String(e?.message || e)
          t.error = lastErr
          try {
            if (existsSync(partial)) unlinkSync(partial)
          } catch {}
          if (ac.signal.aborted) return
        }
      }

      t.status = "failed"
      t.endedAt = Date.now()
      t.error = lastErr
      t.speed = 0
      void notifyDone(t, false)
    }

    function pump() {
      while (store.running < MAX_CONCURRENT) {
        const next = [...tasks.values()].find((t) => t.status === "queued")
        if (!next) break
        store.running++
        void download(next).finally(() => {
          store.running--
          pump()
        })
      }
    }

    function action(id: string, operation: string) {
      const t = tasks.get(id)
      if (!t) throw new Error("未找到任务 / Task not found")
      if (operation === "cancel") {
        if (terminal(t)) throw new Error("任务已结束 / Task already ended")
        t.status = "canceled"
        t.speed = 0
        t.endedAt = Date.now()
        controllers.get(id)?.abort()
      } else {
        if (!terminal(t) || controllers.has(id)) throw new Error("任务仍在运行或清理中 / Task still running or cleaning up")
        if (operation === "remove") tasks.delete(id)
        else {
          if (t.status === "done") throw new Error("已完成任务不能重试 / Completed tasks cannot be retried")
          t.status = "queued"
          t.error = undefined
          t.notifyResult = undefined
          t.notified = false
          t.endedAt = undefined
          t.received = t.total = t.speed = 0
          pump()
        }
      }
    }

    // ---------- GUI 服务器 ----------
    const HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenCode Downloader</title><style>
:root{color-scheme:dark}
body{margin:0;font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;background:#0d1117;color:#e6edf3}
header{padding:14px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:12px}
h1{font-size:16px;margin:0;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;background:#3fb950;animation:b 1.4s infinite}
@keyframes b{50%{opacity:.3}}
.wrap{padding:16px 20px;display:flex;flex-direction:column;gap:10px}
.card{border:1px solid #21262d;border-radius:8px;padding:12px 14px;background:#161b22}
.row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.name{font-weight:600;word-break:break-all}
.u{color:#7d8590;font-size:12px;word-break:break-all;margin-top:2px}
.bar{height:8px;border-radius:4px;background:#21262d;overflow:hidden;margin:8px 0 6px}
.fill{height:100%;background:linear-gradient(90deg,#1f6feb,#3fb950);transition:width .4s}
.meta{display:flex;gap:14px;font-size:12px;color:#8b949e;flex-wrap:wrap}
.st{font-size:12px;padding:1px 8px;border-radius:10px;border:1px solid}
.st.downloading{color:#58a6ff;border-color:#1f6feb55;background:#1f6feb22}
.st.done{color:#3fb950;border-color:#3fb95055;background:#3fb95022}
.st.failed{color:#f85149;border-color:#f8514955;background:#f8514922}
.st.queued{color:#8b949e;border-color:#8b949e55}
.st.verifying{color:#d29922;border-color:#d2992255;background:#d2992222}
.st.canceled{color:#8b949e;border-color:#8b949e55}
button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px}
button:hover{background:#30363d}
.empty{color:#7d8590;text-align:center;padding:40px}
</style></head><body>
<header><span class="dot"></span><h1>opencode 下载器</h1><span id="sum" class="meta"></span></header>
<div class="wrap" id="list"><div class="empty">暂无任务</div></div>
<script>
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function h(n){if(!n||n<0)return '-';const u=['B','KB','MB','GB'];let i=0;while(n>=1024&&i<3){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]}
async function tick(){
  try{
    const r=await fetch('/api/tasks');const d=await r.json();
    const list=document.getElementById('list');
    document.getElementById('sum').textContent='共 '+d.tasks.length+' 个任务 · 目录 '+d.dir;
    if(!d.tasks.length){list.innerHTML='<div class="empty">暂无任务</div>';return}
    list.innerHTML=d.tasks.map(t=>{
      const pct=t.total?Math.min(100,t.received/t.total*100):0;
      const et=t.status==='downloading'&&t.speed&&t.total?(()=>{const s=(t.total-t.received)/t.speed;return s<60?Math.round(s)+'s':Math.round(s/60)+'m'})():'-';
       return '<div class="card"><div class="row"><div><div class="name">'+esc(t.name)+'</div><div class="u">'+esc(t.url)+'</div></div><span class="st '+esc(t.status)+'">'+esc(t.status)+'</span></div>'
      +'<div class="bar"><div class="fill" style="width:'+pct.toFixed(1)+'%"></div></div>'
       +'<div class="meta"><span>'+h(t.received)+(t.total?' / '+h(t.total):'')+'</span><span>'+h(t.speed)+'/s</span><span>剩余 '+et+'</span><span>'+(t.error?'⚠ '+esc(t.error.slice(0,160)):'')+'</span></div>'
       +'<div style="margin-top:8px;display:flex;gap:6px">'+(['queued','downloading','verifying'].includes(t.status)?'<button data-action="cancel" data-id="'+esc(t.id)+'">取消 / Cancel</button>':'')+(['failed','canceled'].includes(t.status)?'<button data-action="retry" data-id="'+esc(t.id)+'">重试 / Retry</button>':'')+(['done','failed','canceled'].includes(t.status)?'<button data-action="remove" data-id="'+esc(t.id)+'">删除 / Remove</button>':'')+'</div></div>'
    }).join('');
   }catch(e){document.getElementById('sum').textContent='连接失败 / Connection lost'}
}
document.getElementById('list').addEventListener('click',async e=>{const b=e.target.closest('button[data-action]');if(!b)return;b.disabled=true;try{const r=await fetch('/api/'+b.dataset.action+'?id='+encodeURIComponent(b.dataset.id),{method:'POST'});const d=await r.json();if(!r.ok)alert(d.error);await tick()}catch(e){alert(String(e))}finally{b.disabled=false}});
tick();setInterval(tick,1000);
</script></body></html>`

    function startGui() {
      // 关键：只有当服务器「确实在监听」时才跳过；否则重建
      if (store.server?.listening) return
      try {
        store.server?.close()
      } catch {}
      store.server = createServer((req: any, res: any) => {
        const origin = `http://127.0.0.1:${cfg.guiPort}`
        res.setHeader("cache-control", "no-store")
        res.setHeader("x-content-type-options", "nosniff")
        if (req.headers.host !== `127.0.0.1:${cfg.guiPort}` || (req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") {
          res.writeHead(403); res.end("Forbidden"); return
        }
        const u = new URL(req.url, `http://127.0.0.1:${cfg.guiPort}`)
        if (u.pathname === "/" || u.pathname === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          res.end(HTML)
          return
        }
        if (u.pathname === "/api/tasks") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
          res.end(JSON.stringify({ dir: cfg.dir, tasks: [...tasks.values()] }))
          return
        }
        if (u.pathname === "/api/cancel" || u.pathname === "/api/retry" || u.pathname === "/api/remove") {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end("Method not allowed"); return }
          const id = u.searchParams.get("id") || ""
          try {
            action(id, u.pathname.slice(5))
            res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}')
          } catch (e: any) {
            res.writeHead(tasks.has(id) ? 409 : 404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message }))
          }
          return
        }
        res.writeHead(404)
        res.end("not found")
      })
      store.server.on("error", (e: any) => {
        logNotify("GUI server error: " + String(e?.message || e))
      })
      store.server.listen(cfg.guiPort, "127.0.0.1", () => {
        logNotify(`GUI listening on ${cfg.guiPort}`)
      })
    }

    // ---------- 工具 ----------
    await ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "dl", description: "后台下载 + 网页进度面板 + 完成后自动唤醒 agent。" })

      editor.add({
        name: "add",
        description: "添加后台下载任务。完成后会自动往当前会话推消息唤醒 agent（不用手动查）。",
        input: {
          type: "object",
          properties: {
            url: { type: "string", description: "下载地址" },
            name: { type: "string", description: "保存文件名（默认从 URL 推断）" },
            dir: { type: "string", description: "保存目录（默认 用户\\Downloads\\opencode-dl）" },
            sha256: { type: "string", description: "可选：校验用的 sha256" },
            mirror: { type: "boolean", description: "失败时自动尝试 GitHub 镜像（默认开）" },
            max_mbps: { type: "number", description: "该任务限速（MB/s），省略则用全局设置；0=不限" },
          },
          required: ["url"],
          additionalProperties: false,
        },
        options: { namespace: "dl", codemode: true },
        execute: async (input: any, context: any) => {
          const url = String(input.url)
          const parsed = new URL(url)
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("仅支持不含凭据的 HTTP(S) URL / HTTP(S) URLs without embedded credentials only")
          const name = validName(input.name ? String(input.name) : decodeURIComponent(basename(parsed.pathname)) || `download-${Date.now()}`)
          const dir = resolve(input.dir ? String(input.dir) : cfg.dir)
          const dest = join(dir, name)
          if (existsSync(dest) || [...tasks.values()].some(t => t.kind === "http" && t.dest.toLowerCase() === dest.toLowerCase() && (!terminal(t) || controllers.has(t.id)))) throw new Error("目标文件已存在或正在下载 / Destination exists or is reserved")
          if (input.sha256 && !/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("Invalid SHA-256")
          const limitBps = input.max_mbps !== undefined ? rate(input.max_mbps) : undefined
          mkdirSync(dir, { recursive: true })
          const id = randomUUID()
          const sessionID =
            context?.sessionID || context?.session?.id || context?.sessionId || store.activeSessionID || undefined
          const t: Task = {
            id, kind: "http", url, name, dest, status: "queued",
            total: 0, received: 0, speed: 0, startedAt: 0,
            sha256: input.sha256 ? String(input.sha256) : undefined,
            limitBps, autoMirror: input.mirror ?? cfg.autoMirror,
            sessionID,
          }
          tasks.set(id, t)
          startGui()
          pump()
          return {
            content:
              `已加入下载队列 [${id}]\n文件: ${name}\n目录: ${dir}\n` +
              `进度面板: http://127.0.0.1:${cfg.guiPort}/ （用 dl.open 打开，或浏览器直接访问）\n` +
              (cfg.autoNotify
                ? sessionID
                  ? "✅ 完成后会自动通知我（已捕获会话）"
                  : "⚠️ 未捕获会话ID —— 完成后无法自动通知，请用 dl.list 查看"
                : "（自动通知已关闭）"),
          }
        },
      })

      editor.add({
        name: "ollama",
        description: "拉取 Ollama 模型（走 /api/pull 流式进度），同样出现在 GUI 面板里，完成后自动通知。",
        input: {
          type: "object",
          properties: {
            model: { type: "string", description: "模型名，如 qwen3.8:27b、qwen3.5:9b" },
          },
          required: ["model"],
          additionalProperties: false,
        },
        options: { namespace: "dl", codemode: true },
        execute: async (input: any, context: any) => {
          const model = String(input.model)
          if (!model.trim()) throw new Error("Model name is required")
          const id = randomUUID()
          const sessionID = context?.sessionID || context?.session?.id || context?.sessionId || store.activeSessionID || undefined
          const t: Task = {
            id, kind: "ollama", url: `ollama://${model}`, name: model,
            dest: "(Ollama 模型库)", status: "queued",
            total: 0, received: 0, speed: 0, startedAt: 0, sessionID,
          }
          tasks.set(id, t)
          startGui()
          pump()
          return {
            content:
              `已开始拉取 Ollama 模型 [${id}]：${model}\n` +
              `进度面板: http://127.0.0.1:${cfg.guiPort}/（或 dl.open）\n` +
              (cfg.autoNotify && sessionID ? "✅ 完成后会自动通知我" : "⚠️ 未捕获会话，无法自动通知"),
          }
        },
      })

      editor.add({
        name: "list",
        description: "查看所有下载任务与进度。",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "dl", codemode: true },
        execute: async () => {
          if (!tasks.size) return { content: "暂无下载任务。" }
          return {
            content: [...tasks.values()]
              .map((t) => {
                const pct = t.total ? ((t.received / t.total) * 100).toFixed(1) + "%" : "-"
                const limit = t.limitBps ?? (cfg.maxMbps > 0 ? cfg.maxMbps * 1024 * 1024 : 0)
                return `[${t.id}] ${t.name}\n  ${t.status} ${pct} ${human(t.received)}${t.total ? "/" + human(t.total) : ""} ${t.speed ? human(t.speed) + "/s 剩余 " + eta(t) : ""}${limit ? ` · 限速 ${(limit / 1024 / 1024).toFixed(1)} MB/s` : ""}${t.error ? "\n  ⚠ " + t.error : ""}${t.notifyResult ? "\n  通知: " + t.notifyResult : ""}`
              })
              .join("\n"),
          }
        },
      })

      editor.add({
        name: "cancel",
        description: "取消一个下载任务。",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        options: { namespace: "dl", codemode: true },
        execute: async (input: any) => {
          const t = tasks.get(String(input.id))
          if (!t) return { content: `未找到任务 [${input.id}]` }
          action(t.id, "cancel")
          return { content: `已取消 [${t.id}]（运行中的任务将在停止后清理临时文件）` }
        },
      })

      editor.add({
        name: "retry",
        description: "重试失败的下载任务。",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        options: { namespace: "dl", codemode: true },
        execute: async (input: any) => {
          const t = tasks.get(String(input.id))
          if (!t) return { content: `未找到任务 [${input.id}]` }
          action(t.id, "retry")
          return { content: `已重新排队 [${t.id}]` }
        },
      })

      editor.add({
        name: "remove",
        description: "从列表中删除一个已结束（完成/失败/取消）的任务。",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        options: { namespace: "dl", codemode: true },
        execute: async (input: any) => {
          const t = tasks.get(String(input.id))
          if (!t) return { content: `未找到任务 [${input.id}]` }
          action(t.id, "remove")
          return { content: `已删除 [${t.id}]` }
        },
      })

      editor.add({
        name: "clear",
        description: "清空所有已结束（完成/失败/取消）的任务记录，保留进行中的。",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "dl", codemode: true },
        execute: async () => {
          let n = 0
          for (const [id, t] of [...tasks.entries()]) {
            if (terminal(t) && !controllers.has(id)) {
              tasks.delete(id)
              n++
            }
          }
          return { content: `已清理 ${n} 条已结束的任务。` }
        },
      })

      editor.add({
        name: "open",
        description: "在浏览器打开下载进度面板（GUI）。",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "dl", codemode: true },
        execute: async () => {
          startGui()
          const url = `http://127.0.0.1:${cfg.guiPort}/`
          const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open"
          const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
          execFile(command, args, { windowsHide: true }, (error) => { if (error) logNotify(`Open browser failed: ${error.message}`) })
          return { content: `已在浏览器打开：${url}` }
        },
      })

      editor.add({
        name: "config",
        description: "查看或修改下载器配置。",
        input: {
          type: "object",
          properties: {
            dir: { type: "string" },
            auto_notify: { type: "boolean", description: "下载完成后是否自动唤醒 agent" },
            auto_mirror: { type: "boolean", description: "失败时是否自动尝试镜像" },
            max_mbps: { type: "number", description: "全局限速（MB/s），0=不限速" },
          },
          additionalProperties: false,
        },
        options: { namespace: "dl", codemode: true },
        execute: async (input: any) => {
          if (input?.max_mbps !== undefined) rate(input.max_mbps)
          if (input?.dir) { const dir = resolve(String(input.dir)); mkdirSync(dir, { recursive: true }); cfg.dir = dir }
          if (typeof input?.auto_notify === "boolean") cfg.autoNotify = input.auto_notify
          if (typeof input?.auto_mirror === "boolean") cfg.autoMirror = input.auto_mirror
          if (typeof input?.max_mbps === "number") cfg.maxMbps = Math.max(0, input.max_mbps)
          return { content: "当前配置：\n" + JSON.stringify(cfg, null, 2) }
        },
      })
    })

    startGui()
    // GUI 服务器是跨重载共享的，插件重载时不关闭，保证面板一直可用
    return () => {}
  },
}
