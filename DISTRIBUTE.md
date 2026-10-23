# 把这个通知器装到另一台电脑

适用场景：那台电脑已经装好 **DeepSeek Harness + SnowLuma + QQ**（AstrBot 可以不装，通知链路不依赖它）。

## 0. 前置检查

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10/11（脚本依赖 `netstat`、`mklink`、VBS） |
| DSH | 0.2.x（依赖 `remote.mux` 事件流与 `session/list` 协议） |
| SnowLuma | 已安装、**已运行过一次**（生成 `config/onebot_*.json`） |
| QQ | 已登录（SnowLuma 的 hook 需要活着的 QQ 进程） |
| Node.js | 不需要单独装，插件用 DSH 自带的 Electron 运行时 |

## 1. 拷贝插件包

把本仓库整个目录拷到目标机器任意位置，例如 `C:\Tools\dsh-qq-notifier`（路径随意，没有硬编码）。

## 2. 装依赖

```bat
cd /d C:\Tools\dsh-qq-notifier
npm install --omit=dev
```

（只需要 `ws` 一个包；没有 npm 的话可以把 `node_modules\ws` 直接拷过去。）

## 3. 跑安装脚本

```bat
cd /d C:\Tools\dsh-qq-notifier
node install.mjs
```

它会做三件事：
- 在 `~\.dsh\profiles\desktop\node_modules\dsh-qq-notifier` 建一个 junction 指向插件目录；
- 在 profile 的 `package.json` 里登记 `dependencies` 和 `dsh.profile.bundles`；
- 提示重启。

卸载：`node install.mjs --uninstall`

> 没有 Node 也能装：手动建 junction + 手改 profile `package.json` 的 `dependencies` / `dsh.profile.bundles`，效果一样。

## 4. 改配置

编辑插件目录下的 `config.json`，**通常只需要改一个值**：

```json
{
  "owner": { "qq": 你的QQ号 },
  "dsh": { "baseUrl": "auto", "workspaces": [] },
  "snowluma": { "dir": "" }
}
```

- `owner.qq`：必填，接收通知的 QQ 号。
- `workspaces`：留空 = 监控该 DSH 下所有会话；填绝对路径 = 只监控该工作区。
- `snowluma.dir`：留空 = 自动在 `..\snowluma`、`D:\QQBot\snowluma`、`C:\SnowLuma` 里找；找不到再手动填。
- `baseUrl`：保持 `auto`，DSH 换端口会自动探测。

**SnowLuma 的地址 / 端口 / access token 全部自动读取**，不用填。

## 5. 重启 DSH

插件在 DSH 启动时加载，重启后看日志有没有：

```
[qq-notifier] 已启动 notifier，pid = ...
```

以及插件目录下的 `notifier.log` 里：

```
SnowLuma: D:\QQBot\snowluma ws://127.0.0.1:3001/
[QQ] OneBot WS 已连接
[DSH] 探测到 DSH 端口: 5xxxx
```

## 6. 验证

用 owner QQ 给机器人账号发 `#进度`，应该收到工作区状态。

---

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 没有 `[qq-notifier]` 日志 | 插件没被加载：检查 profile `package.json` 的 `dsh.profile.bundles` 是否包含 `dsh-qq-notifier`，以及 junction 是否存在 |
| `[QQ] 未找到 SnowLuma 的 OneBot 配置` | SnowLuma 没跑过，或 `snowluma.dir` 指错了；确认目录下有 `config/onebot_*.json` |
| `[QQ] WS 错误: ... 401` | token 不对：删掉 `config.json` 里手填的 token，让它自动读取 |
| `[DSH] 未探测到 DSH 端口` | DSH 没启动，或不是 0.2.x 协议 |
| 查询返回 `fetch failed` | 通知器连的还是旧端口：看 `notifier.log` 的 `探测到 DSH 端口` 是否等于当前 GUI 端口 |
| DSH 升级后全挂 | 大概率是 `remote.mux` / `session/list` 协议变了，需要改 `notifier.mjs` 的接入层 |

## 版本兼容

| 通知器 | DSH | 备注 |
| --- | --- | --- |
| 0.2.0 | 0.2.1-rc.2 | 当前验证版本 |

DSH 每次重启端口都会变，`baseUrl: "auto"` 就是为此准备的；如果 DSH 改了事件协议，需要跟改 `connectDsh()` / `rpc()`。
