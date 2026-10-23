#!/usr/bin/env node
/**
 * DSH → QQ 只读通知器（可移植版）
 *
 * 设计目标：换一台装了 SnowLuma 的电脑，只需要改 `config.json` 里的 owner.qq，
 * 其余（SnowLuma 地址、token、端口）全部自动从 SnowLuma 自己的配置文件里读。
 *
 * 职责（严格只读，绝不向 DSH 发送任何会话消息/指令）：
 *   1. 订阅 DSH 全局事件流，捕获 approval/request、user-questions/request
 *   2. 订阅目标工作区会话的 turn/end 并推送 QQ
 *   3. 接收 QQ 私聊查询（#进度 / #状态），读 DSH session/list 后回复
 *
 * 硬限制：仅 Windows（依赖 netstat 解析端口、SnowLuma 的 OneBot 实现）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh')

// ── 配置 ──────────────────────────────────────────────────────────────
const CFG_PATH = path.join(HERE, 'config.json')
let CFG = {}
for (const candidate of [CFG_PATH, path.join(HERE, 'config.example.json')]) {
  try {
    CFG = JSON.parse(fs.readFileSync(candidate, 'utf8'))
    break
  } catch {
    CFG = {}
  }
}

const LOG = process.env.DSH_NOTIFIER_LOG ?? CFG.logFile ?? path.join(HERE, 'notifier.log')
const OWNER = Number(process.env.DSH_NOTIFIER_OWNER ?? CFG.owner?.qq ?? 0) || 0
const WORKSPACES = (
  process.env.DSH_NOTIFIER_WORKSPACE
    ? [process.env.DSH_NOTIFIER_WORKSPACE]
    : (CFG.dsh?.workspaces ?? [])
).map((w) => String(w).toLowerCase())
let BASE = CFG.dsh?.baseUrl ?? 'auto'

// ── 日志 ──────────────────────────────────────────────────────────────
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  console.log(line)
  try { fs.appendFileSync(LOG, line + '\n') } catch {}
}
function trimLog() {
  try {
    if (fs.statSync(LOG).size > 2 * 1024 * 1024) fs.renameSync(LOG, LOG + '.1')
  } catch {}
}

// ── SnowLuma 自动发现 ────────────────────────────────────────────────
/** SnowLuma 安装目录的候选位置（config 里给了就优先用） */
function snowlumaDirCandidates() {
  const list = []
  if (process.env.SNOWLUMA_DIR) list.push(process.env.SNOWLUMA_DIR)
  if (CFG.snowluma?.dir) list.push(CFG.snowluma.dir)
  list.push(path.join(path.dirname(HERE), 'snowluma'))
  list.push('D:\\QQBot\\snowluma')
  list.push('C:\\SnowLuma')
  return list
}

/** 从 SnowLuma 的 config/onebot*.json 里读出 OneBot 的地址与 token */
function loadSnowlumaOnebot() {
  for (const dir of snowlumaDirCandidates()) {
    const cfgDir = path.join(dir, 'config')
    if (!fs.existsSync(cfgDir)) continue
    let files = []
    try {
      files = fs.readdirSync(cfgDir).filter((f) => /^onebot.*\.json$/i.test(f))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(cfgDir, file), 'utf8'))
        const net = doc.networks ?? doc
        const wsServer = (net.wsServers ?? [])[0] ?? null
        const httpServer = (net.httpServers ?? [])[0] ?? null
        if (!wsServer && !httpServer) continue
        const host = (s) => (s?.host && s.host !== '0.0.0.0' ? s.host : '127.0.0.1')
        return {
          dir,
          wsUrl: wsServer ? `ws://${host(wsServer)}:${wsServer.port ?? 3001}${wsServer.path ?? '/'}` : '',
          wsToken: wsServer?.accessToken ?? '',
          httpUrl: httpServer ? `http://${host(httpServer)}:${httpServer.port ?? 3000}` : '',
          httpToken: httpServer?.accessToken ?? '',
        }
      } catch {
        continue
      }
    }
  }
  return null
}

function resolveSnowluma() {
  const manual = CFG.snowluma ?? {}
  const wsUrl = manual.wsUrl ?? ''
  // 兼容两种写法：wsToken/httpToken（新版）与 accessToken（旧版手填）
  if (wsUrl) {
    return {
      wsUrl,
      wsToken: manual.wsToken ?? manual.accessToken ?? '',
      httpUrl: manual.httpUrl ?? '',
      httpToken: manual.httpToken ?? manual.accessToken ?? '',
      source: 'config.json',
    }
  }
  const found = loadSnowlumaOnebot()
  if (found) return { ...found, source: found.dir }
  return { wsUrl: '', wsToken: '', httpUrl: '', httpToken: '', source: 'none' }
}

const SL = resolveSnowluma()

// ── DSH 鉴权 ─────────────────────────────────────────────────────────
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

function readSecret() {
  const text = fs.readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8')
  const m = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/.exec(text)
  if (!m) throw new Error('credentials 中找不到 browser-session 密钥')
  const raw = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (raw.byteLength !== 32) throw new Error('browser-session 密钥长度异常')
  return raw
}

let cachedSecret = null
function mintCookie() {
  cachedSecret ??= readSecret()
  const authority = new URL(BASE).host
  const issuedAt = Date.now()
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 3600_000 }), 'utf8'))
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
  return `${name}=v1.${body}.${b64url(createHmac('sha256', cachedSecret).update(body).digest())}`
}

async function rpc(method, payload, wrapper) {
  const endpoint = method.replace(/\./g, '/')
  const args = wrapper ? { [wrapper]: payload } : payload
  const message = { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }
  const res = await fetch(new URL('/api/' + endpoint, BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: mintCookie() },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  })
  const json = await res.json()
  if (json?.result?.ok === false) throw new Error(`${method} 失败: ${JSON.stringify(json.result.error).slice(0, 300)}`)
  return json?.result?.value ?? json?.result
}

// ── 会话状态 ──────────────────────────────────────────────────────────
const sessions = new Map()
const followed = new Set()
const notifiedApprovals = new Set()
const notifiedTurns = new Set()

function inScope(cwd) {
  if (!WORKSPACES.length) return true
  return WORKSPACES.includes(String(cwd ?? '').toLowerCase())
}

// ── QQ 发送 ──────────────────────────────────────────────────────────
let slWs = null
let slReady = false

function sendQQ(text) {
  const msg = String(text ?? '').slice(0, 4000)
  if (slWs && slReady) {
    slWs.send(JSON.stringify({
      action: 'send_private_msg',
      params: { user_id: OWNER, message: [{ type: 'text', data: { text: msg } }] },
      echo: randomUUID(),
    }))
    return
  }
  if (!SL.httpUrl) return log('[QQ] 通道未就绪且无 HTTP 兜底，消息丢弃')
  fetch(SL.httpUrl + '/send_private_msg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (SL.httpToken ?? '') },
    body: JSON.stringify({ user_id: OWNER, message: [{ type: 'text', data: { text: msg } }] }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => log('[QQ] HTTP 发送失败:', e.message))
}

// ── SnowLuma OneBot WS 客户端 ────────────────────────────────────────
function connectQQ() {
  if (!SL.wsUrl) {
    log('[QQ] 未找到 SnowLuma 的 OneBot 配置，10 秒后重试（请确认 SnowLuma 已安装并运行过）')
    setTimeout(connectQQ, 10_000)
    return
  }
  const url = new URL(SL.wsUrl)
  if (SL.wsToken) url.searchParams.set('access_token', SL.wsToken)
  const ws = new WebSocket(url.toString())
  slWs = ws
  ws.on('open', () => { slReady = true; log('[QQ] OneBot WS 已连接', url.origin) })
  ws.on('close', () => { slReady = false; log('[QQ] OneBot WS 断开，5s 后重连'); setTimeout(connectQQ, 5000) })
  ws.on('error', (e) => log('[QQ] WS 错误:', e.message))
  ws.on('message', (raw) => {
    let ev
    try { ev = JSON.parse(raw.toString()) } catch { return }
    if (ev.post_type !== 'message' || ev.message_type !== 'private') return
    if (OWNER && Number(ev.user_id) !== OWNER) return
    const text = (ev.message ?? []).filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('').trim()
    handleQuery(text)
  })
}

// ── 查询处理 ─────────────────────────────────────────────────────────
async function handleQuery(text) {
  const prefixes = CFG.query?.prefixes ?? ['#进度', '#状态']
  if (!prefixes.some((p) => text.toLowerCase().startsWith(String(p).toLowerCase()))) return
  try {
    const list = await rpc('session/list', {}, '_request')
    const items = (list?.items ?? []).filter((it) => inScope(it.cwd))
    if (!items.length) return sendQQ('当前没有该工作区的 DSH 会话。')
    items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const lines = ['📊 DSH 工作区状态']
    for (const it of items.slice(0, 5)) {
      const v = it.projections?.values ?? {}
      const st = v.sessionStats ?? {}
      const live = sessions.get(it.sessionId)
      const state = it.running ? '🟢 运行中' : '⚪ 空闲'
      lines.push('')
      lines.push(`${state} ${v.title ?? '(无标题)'}`)
      lines.push(`  轮次 ${st.turns ?? 0} · 步数 ${st.steps ?? 0}`)
      if (live?.turnStartAt && it.running) lines.push(`  本轮已跑 ${fmtDuration(Date.now() - live.turnStartAt)}`)
      if (live?.lastTool) lines.push(`  最近动作 ${live.lastTool}`)
      lines.push(`  目录 ${it.cwd}`)
    }
    sendQQ(lines.join('\n'))
  } catch (e) {
    log('[query] 失败:', e.message)
    sendQQ('查询失败：' + e.message)
  }
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

// ── DSH 地址解析 ─────────────────────────────────────────────────────
async function probeDsh(base) {
  try {
    const res = await fetch(base + '/', { signal: AbortSignal.timeout(500) })
    if (res.status !== 401) return false
    const body = await res.text().catch(() => '')
    return /dsh/i.test(body) && /auth/i.test(body)
  } catch {
    return false
  }
}

async function listListeningPorts() {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      const ports = new Set()
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING|侦听/.test(line)) continue
        const m = /^\s*TCP\s+(\S+):(\d+)\s+/.exec(line)
        if (!m) continue
        if (['127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(m[1])) ports.add(Number(m[2]))
      }
      resolve([...ports])
    })
  })
}

async function resolveBase() {
  if (process.env.DSH_WEB_URL) { BASE = process.env.DSH_WEB_URL; return }
  if (BASE && BASE !== 'auto' && (await probeDsh(BASE))) return
  log('[DSH] 旧地址不可用，探测本机监听端口 ...')
  const ports = (await listListeningPorts()).filter((p) => p >= 1024 && p < 65536)
  for (let i = 0; i < ports.length; i += 20) {
    const batch = ports.slice(i, i + 20)
    const hits = await Promise.all(batch.map((p) => probeDsh(`http://127.0.0.1:${p}`).then((ok) => (ok ? p : 0))))
    const found = hits.find(Boolean)
    if (found) {
      BASE = `http://127.0.0.1:${found}`
      log('[DSH] 探测到 DSH 端口:', found)
      try {
        CFG.dsh = { ...(CFG.dsh ?? {}), baseUrl: BASE }
        fs.writeFileSync(CFG_PATH, JSON.stringify(CFG, null, 2))
      } catch {}
      return
    }
  }
  throw new Error('未探测到 DSH 端口（已扫描本机全部监听端口）')
}

// ── DSH 事件流 ───────────────────────────────────────────────────────
let dsh = null
let dshRetry = 0
const streams = new Map()

function connectDsh() {
  resolveBase()
    .then(openDshSocket)
    .catch((e) => { log('[DSH] 地址解析失败:', e.message); setTimeout(connectDsh, 5000) })
}

function openDshSocket() {
  const url = new URL('/api/remote.mux', BASE)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(url, { headers: { cookie: mintCookie() } })
  dsh = ws
  let eventStreamId = null
  const sendOpen = (endpoint, payload, kind, sessionId) => {
    const streamId = randomUUID()
    streams.set(streamId, { kind, sessionId })
    ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: payload } }))
    return streamId
  }

  ws.on('open', () => {
    log('[DSH] remote.mux 已连接', BASE)
    dshRetry = 0
    eventStreamId = sendOpen('$events', {}, 'events')
    refreshSessions()
    setInterval(() => { if (ws.readyState === WebSocket.OPEN) refreshSessions() }, 30_000)
  })

  ws.on('close', () => {
    log('[DSH] 连接断开，等待重连')
    followed.clear()
    dshRetry = Math.min(dshRetry + 1, 6)
    setTimeout(connectDsh, 3000 * dshRetry)
  })

  ws.on('error', (e) => log('[DSH] WS 错误:', e.message))

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    const meta = streams.get(msg.streamId)
    if (msg.type === 'end' || msg.type === 'error') {
      if (meta) streams.delete(msg.streamId)
      return
    }
    if (msg.type !== 'item' || !meta) return
    const v = msg.value
    if (!v) return

    if (meta.kind === 'events') {
      if (v.type === 'waterfall') {
        if (v.event === 'approval/request') onApproval(v)
        else if (v.event === 'user-questions/request') onQuestion(v)
      }
      return
    }

    if (meta.kind === 'follow') {
      const sid = meta.sessionId
      if (v.type === 'snapshot') {
        const s = sessions.get(sid) ?? {}
        s.title = v.projections?.values?.title ?? s.title
        s.cwd = v.header?.cwd ?? s.cwd
        sessions.set(sid, s)
        return
      }
      if (v.type === 'event') onSessionEvent(sid, v.event)
    }
  })
}

async function refreshSessions() {
  try {
    const list = await rpc('session/list', {}, '_request')
    const items = (list?.items ?? []).filter((it) => inScope(it.cwd))
    for (const it of items) {
      const s = sessions.get(it.sessionId) ?? {}
      s.title = it.projections?.values?.title ?? s.title
      s.cwd = it.cwd
      s.running = !!it.running
      sessions.set(it.sessionId, s)
      if (!followed.has(it.sessionId)) followSession(it.sessionId)
    }
  } catch (e) {
    log('[DSH] 刷新会话列表失败:', e.message)
  }
}

function followSession(sessionId) {
  if (!dsh || dsh.readyState !== WebSocket.OPEN) return
  if (followed.has(sessionId)) return
  followed.add(sessionId)
  const streamId = randomUUID()
  streams.set(streamId, { kind: 'follow', sessionId })
  dsh.send(JSON.stringify({
    type: 'open',
    streamId,
    endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } } },
  }))
  log('[DSH] follow 会话', sessionId)
}

function onSessionEvent(sessionId, ev) {
  if (!ev) return
  const s = sessions.get(sessionId) ?? {}
  s.lastEventAt = Date.now()
  if (ev.type === 'turn/start') {
    s.turnStartAt = Date.now()
    s.running = true
    s.lastTool = null
    sessions.set(sessionId, s)
    return
  }
  if (ev.type === 'tool/call') {
    if (ev.data?.name) s.lastTool = String(ev.data.name)
    sessions.set(sessionId, s)
    return
  }
  if (ev.type === 'turn/end') {
    const turn = ev.data?.turn
    const reason = ev.data?.reason?.kind ?? 'unknown'
    const key = `${sessionId}#${turn}`
    const startAt = s.turnStartAt
    s.running = false
    s.turnStartAt = null
    sessions.set(sessionId, s)
    if (!(CFG.notify?.turnEnd ?? true) || notifiedTurns.has(key)) return
    notifiedTurns.add(key)
    const dur = startAt ? `，用时 ${fmtDuration(Date.now() - startAt)}` : ''
    const icon = reason === 'completed' ? '✅' : '⚠️'
    sendQQ(
      `${icon} DSH 任务${reason === 'completed' ? '完成' : '结束（' + reason + '）'}\n` +
      `会话：${s.title ?? '(无标题)'}\n` +
      `第 ${turn} 轮${dur}\n` +
      `目录：${s.cwd ?? '?'}`,
    )
  }
}

function onApproval(value) {
  if (!(CFG.notify?.approval ?? true)) return
  const eventId = String(value.eventId ?? '')
  if (!eventId || notifiedApprovals.has(eventId)) return
  notifiedApprovals.add(eventId)
  const sid = value.agentId
  const s = sessions.get(sid) ?? {}
  if (s.cwd && !inScope(s.cwd)) return
  const req = value.request ?? {}
  const reason = typeof req.reason === 'string' ? req.reason : (req.reason ? JSON.stringify(req.reason).slice(0, 200) : '')
  log('[notify] 提权请求', sid ?? '', req.toolName ?? '')
  sendQQ(
    '⚠️ DSH 请求授权\n' +
    `会话：${s.title ?? sid ?? '(未知)'}\n` +
    `工具：${req.toolName ?? '(未知)'}\n` +
    (reason ? `原因：${reason}\n` : '') +
    '→ 请回到 DSH 窗口点「允许」或「拒绝」',
  )
}

function onQuestion(value) {
  if (!(CFG.notify?.userQuestions ?? true)) return
  const eventId = String(value.eventId ?? '')
  if (!eventId || notifiedApprovals.has('q:' + eventId)) return
  notifiedApprovals.add('q:' + eventId)
  const sid = value.agentId
  const s = sessions.get(sid) ?? {}
  if (s.cwd && !inScope(s.cwd)) return
  const qs = (value.request?.questions ?? []).map((q) => `· ${q.question}`).join('\n')
  sendQQ(
    '❓ DSH 有提问等你回答\n' +
    `会话：${s.title ?? sid ?? '(未知)'}\n` +
    (qs ? qs + '\n' : '') +
    '→ 请回到 DSH 窗口作答',
  )
}

// ── 启动 ──────────────────────────────────────────────────────────────
log('=== DSH → QQ 通知器启动 ===')
log('DSH     :', BASE)
log('工作区  :', WORKSPACES.join(', ') || '(全部)')
log('QQ      :', OWNER || '(未配置 owner.qq)')
log('SnowLuma:', SL.source, SL.wsUrl || '(未找到)')
trimLog()
connectQQ()
connectDsh()
setInterval(trimLog, 10 * 60_000)

if (process.argv.includes('--selftest')) {
  setTimeout(() => {
    sessions.set('session-selftest', { title: '提权提醒测试', cwd: WORKSPACES[0] })
    onApproval({ eventId: 'selftest-' + Date.now(), agentId: 'session-selftest', request: { toolName: 'Bash', reason: '这是提权提醒的模拟测试，不是真实操作' } })
    setTimeout(() => process.exit(0), 5000)
  }, 3500)
}

process.on('uncaughtException', (e) => log('[fatal]', e?.stack ?? e))
process.on('unhandledRejection', (e) => log('[fatal] unhandled', e?.stack ?? e))
