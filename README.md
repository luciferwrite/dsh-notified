# dsh-qq-notifier

把 **DeepSeek Harness（DSH）** 的运行状态接到 **QQ** 上的只读通知器 + DSH 插件。

- ⚠️ **DSH 请求授权**（`approval/request`）→ 推送 QQ，提示回 DSH 窗口点允许/拒绝
- ❓ **DSH 向你提问**（`user-questions/request`）→ 推送 QQ
- ✅ **任务完成**（`turn/end`）→ 推送会话标题、轮次、耗时
- 📊 **进度查询**：在 QQ 私聊里发 `#进度` / `#状态`，返回运行状态、轮次/步数、最近动作、工作区目录

> **严格只读**：只订阅 DSH 事件流和调用 `session/list` 查询，**不调用任何 `session/prompt`、`session/cancel`、`respond` 等写接口**，
> QQ 侧也不会转发任何指令给 DSH。

## 工作原理

```
QQ 客户端 ←hook→ SnowLuma（OneBot v11）
                       ├─ WS  ws://127.0.0.1:3001   ← notifier 收发消息
                       └─ HTTP http://127.0.0.1:3000

notifier ←─ ws /api/remote.mux ── DSH Web（随机端口，自动探测）
         ├─ $events 流：approval/request、user-questions/request
         ├─ session/follow：turn/start、tool/call、turn/end
         └─ 一元 RPC：session/list（查询进度）
```

插件本身只负责生命周期：DSH 启动时 `spawn` 一个 `notifier.mjs`，退出时按 5 秒间隔重拉，DSH 卸载时清理。
通知逻辑跑在独立进程里，插件崩了不会带崩 DSH。

## 前置条件

| 项 | 要求 |
| --- | --- |
| 系统 | **Windows 10/11**（依赖 `netstat` 解析端口、`mklink`） |
| DSH | 0.2.x（当前验证 0.2.1-rc.2） |
| SnowLuma | 已安装并**运行过一次**（会生成 `config/onebot_*.json`） |
| QQ | 已登录（SnowLuma 的 hook 需要活着的 QQ 进程） |
| Node.js | **不需要**，插件用 DSH 自带的 Electron 运行时（`ELECTRON_RUN_AS_NODE`） |

AstrBot 不是必需的——通知链路只依赖 SnowLuma。

## 安装

```bat
:: 1. 装依赖（只有一个 ws）
cd dsh-qq-notifier
npm install --omit=dev

:: 2. 注册到 DSH profile
node install.mjs
```

`install.mjs` 会：
- 在 `~\.dsh\profiles\<profile>\node_modules\dsh-qq-notifier` 建 junction 指向本目录；
- 在 profile 的 `package.json` 里登记 `dependencies` 与 `dsh.profile.bundles`。

卸载：`node install.mjs --uninstall`

## 配置

复制 `config.example.json` 为 `config.json`（没有 `config.json` 时会自动回退读 example），**通常只需要改一个值**：

```json
{
  "owner": { "qq": 123456789 },
  "dsh": { "baseUrl": "auto", "workspaces": [] },
  "snowluma": { "dir": "" }
}
```

| 字段 | 说明 |
| --- | --- |
| `owner.qq` | **必填**，接收通知的 QQ 号 |
| `dsh.workspaces` | 留空 = 监控所有会话；填绝对路径 = 只监控该工作区 |
| `dsh.baseUrl` | 保持 `"auto"`，DSH 换端口会自动探测（用 `netstat` 列监听端口 + 401 特征识别） |
| `snowluma.dir` | 留空 = 自动在 `..\snowluma`、`D:\QQBot\snowluma`、`C:\SnowLuma` 里找 |

**SnowLuma 的地址、端口、`access_token` 全部自动从 `config/onebot_*.json` 读取**，不用手填。
SnowLuma 重建 token 也不需要改配置。

## 使用

重启 DSH 后，插件自动拉起通知器。日志在插件目录的 `notifier.log`：

```
SnowLuma: D:\QQBot\snowluma ws://127.0.0.1:3001/
[QQ] OneBot WS 已连接 ws://127.0.0.1:3001
[DSH] 探测到 DSH 端口: 49960
[DSH] remote.mux 已连接 http://127.0.0.1:49960
```

然后在 QQ 私聊里发：

| 命令 | 作用 |
| --- | --- |
| `#进度` / `#状态` | 查看当前工作区任务状态 |
| `#progress` / `#status` | 同上（英文） |

## 排障

| 现象 | 排查 |
| --- | --- |
| 没有 `[qq-notifier]` 日志 | 插件未加载：检查 profile `package.json` 的 `dsh.profile.bundles` 是否含 `dsh-qq-notifier`，junction 是否存在 |
| `[QQ] 未找到 SnowLuma 的 OneBot 配置` | SnowLuma 没跑过，或 `snowluma.dir` 指错；确认目录下有 `config/onebot_*.json` |
| `[QQ] WS 错误: ... 401` | token 不对：删掉 `config.json` 里手填的 token，让自动发现接管 |
| `[DSH] 未探测到 DSH 端口` | DSH 没启动，或版本不是 0.2.x |
| 查询返回 `fetch failed` | 连的是旧端口：看 `notifier.log` 的 `探测到 DSH 端口` 是否等于当前 GUI 端口 |

## 安全与边界

- 只读：不向 DSH 发送任何消息，QQ 侧也不转发指令；
- 通知器以独立进程运行，插件只负责启停；
- 本插件**不自动部署 SnowLuma**（其 EULA §5.4 禁止自动化部署），也不托管 QQ 登录。

## 兼容性

| 版本 | DSH | 说明 |
| --- | --- | --- |
| 0.2.0 | 0.2.1-rc.2 | 当前验证版本 |

DSH 每次重启会换 Web 端口，`baseUrl: "auto"` 已处理；若 DSH 升级后改了 `remote.mux` / `session/list` 协议，需要同步修改 `notifier.mjs` 的接入层。

## License

MIT
