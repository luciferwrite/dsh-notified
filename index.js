/**
 * dsh-qq-notifier —— 通知器宿主插件
 *
 * 只做三件事：
 *   1. DSH 启动时拉起同目录下的 `notifier.mjs`（独立进程，只读订阅 DSH 事件）
 *   2. 子进程退出时按间隔重拉
 *   3. DSH 卸载/退出时杀掉子进程
 *
 * 可移植设计：
 *   - 用 `import.meta.url` 定位同目录的 notifier.mjs，不写死安装路径
 *   - 用 DSH 自带的 Electron 运行时以 `ELECTRON_RUN_AS_NODE=1` 执行脚本，
 *     因此目标机器不需要另外安装 Node.js
 *   - SnowLuma 的地址/token 由 notifier.mjs 自己从 SnowLuma 配置文件里发现
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-qq-notifier'
export const inject = []

const DEFAULTS = {
  notifierDir: HERE,
  nodeExe: '',
  workspace: '',
  ownerQQ: 0,
  restartDelayMs: 5000,
}

/** 选一个能执行 ESM 脚本的 node：优先 DSH 自带 Electron 运行时 */
function resolveRunner(opts) {
  if (opts.nodeExe && fs.existsSync(opts.nodeExe)) return { exe: opts.nodeExe, env: {} }
  if (process.versions.electron) return { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  return { exe: process.execPath, env: {} }
}

export function apply(ctx, config) {
  const opts = { ...DEFAULTS, ...(config ?? {}) }
  const log = (...args) => console.log('[qq-notifier]', ...args)
  const runner = resolveRunner(opts)

  let child = null
  let timer = null
  let stopped = false

  const start = () => {
    if (stopped || child) return
    const entry = path.join(opts.notifierDir, 'notifier.mjs')
    if (!fs.existsSync(entry)) {
      log('未找到 notifier.mjs：', entry)
      return
    }
    const env = { ...process.env, ...runner.env }
    if (opts.workspace) env.DSH_NOTIFIER_WORKSPACE = opts.workspace
    if (opts.ownerQQ) env.DSH_NOTIFIER_OWNER = String(opts.ownerQQ)

    try {
      child = spawn(runner.exe, [entry], {
        cwd: opts.notifierDir,
        env,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      log('启动失败：', error?.message ?? error)
      timer = setTimeout(start, opts.restartDelayMs)
      return
    }

    log('已启动 notifier，pid =', child.pid, '| runner =', runner.exe)
    child.on('exit', (code, signal) => {
      log('notifier 退出', code, signal)
      child = null
      if (!stopped) timer = setTimeout(start, opts.restartDelayMs)
    })
    child.on('error', (error) => log('notifier 进程错误：', error?.message ?? error))
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    if (child) {
      try { child.kill() } catch {}
      child = null
    }
    log('已停止')
  }

  start()
  if (typeof ctx?.on === 'function') {
    try { ctx.on('dispose', stop) } catch {}
  }
  process.once('exit', stop)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

export default { apply, name, inject }
