#!/usr/bin/env node
/**
 * dsh-qq-notifier 安装脚本
 *
 * 做三件事：
 *   1. 把本包链接到目标 DSH profile 的 node_modules（Windows 用 junction）
 *   2. 在 profile 的 package.json 里登记 dependencies + dsh.profile.bundles
 *   3. 提示重启 DSH
 *
 * 用法：
 *   node install.mjs                      # 默认 profile = desktop
 *   node install.mjs --profile web
 *   node install.mjs --uninstall
 *
 * 不需要 pnpm / 网络：只是建链接和改 JSON。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-qq-notifier'
const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh')

const args = process.argv.slice(2)
const uninstall = args.includes('--uninstall')
const profileIdx = args.indexOf('--profile')
const profileName = profileIdx >= 0 && args[profileIdx + 1] ? args[profileIdx + 1] : (process.env.DSH_PROFILE ?? 'desktop')
const profileDir = path.join(DSH_HOME, 'profiles', profileName)

function fail(msg) {
  console.error('[install] ' + msg)
  process.exit(1)
}

if (!fs.existsSync(profileDir)) fail(`找不到 profile 目录：${profileDir}`)

const pkgFile = path.join(profileDir, 'package.json')
if (!fs.existsSync(pkgFile)) fail(`找不到 ${pkgFile}`)
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []

const linkPath = path.join(profileDir, 'node_modules', PKG_NAME)
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })

if (uninstall) {
  if (fs.existsSync(linkPath)) {
    fs.rmSync(linkPath, { recursive: true, force: true })
    console.log('[install] 已删除链接', linkPath)
  }
  delete pkg.dependencies[PKG_NAME]
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((n) => n !== PKG_NAME)
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
  console.log('[install] 已从 profile 移除，重启 DSH 生效。')
  process.exit(0)
}

// 1) 建立链接
if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true })
if (process.platform === 'win32') {
  execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, HERE], { stdio: 'inherit' })
} else {
  fs.symlinkSync(HERE, linkPath, 'dir')
}
console.log('[install] 已链接', linkPath, '->', HERE)

// 2) 登记 profile
pkg.dependencies[PKG_NAME] = 'file:' + HERE.replaceAll('\\', '/')
if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles.push(PKG_NAME)
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
console.log('[install] 已写入', pkgFile)

// 3) 检查依赖
const wsDir = path.join(HERE, 'node_modules', 'ws')
if (!fs.existsSync(wsDir)) {
  console.log('[install] 警告：缺少 ws 依赖。请在插件目录执行：npm install --omit=dev')
}

console.log(`
[install] 完成。接下来：
  1. 编辑 ${path.join(HERE, 'config.json')}，把 owner.qq 改成你的 QQ 号
  2. 重启 DSH（插件在启动时加载）
  3. 若 SnowLuma 未运行，先启动它并扫码登录
`)
