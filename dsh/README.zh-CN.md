# dsh（DeepSeek Harness）

在 dlient 中运行 **DeepSeek Harness（dsh）** 的 AI Agent Web UI，并对外暴露可内嵌的 **Chat** 组件（`dsh --profile dlient-chat`），任何插件都可把它嵌进自己的界面。

> **简体中文** · [English](README.md)

## 概览

```
dsh（app）─ worker：Node.js → npm i -g @deepseek-ai/dsh → dsh web --no-open
            渲染端：<Webview src=http://127.0.0.1:<port>>
Chat（内嵌）─ worker：安装 dlient-chat profile → 启动 chat 服务
              渲染端：<PluginView pluginId="dsh" entry="Chat">
```

- **托管运行时** — worker 通过内置 `nodejs.*` host-api 解析 / 安装 Node.js（优先内置 LTS，回退系统运行时），按需安装 `@deepseek-ai/dsh` 并启动 `dsh web --no-open`。npm 随 Node 自带；`pnpm` 与 DSH 安装进插件数据目录下的同一 npm prefix —— **绝不改动系统 PATH**。
- **两种形态** — `dsh` App（完整 `dsh web` UI）与可内嵌的 `Chat`（单栏 `dlient-chat` 界面）。两者相互独立，可同时运行。
- **无空闲自动停止** — chat 服务没有 idle 计时器，只会在显式停止、或 dsh worker / 宿主退出时结束。折叠、切 tab、隐藏 Chat 视图都只是隐藏原生 WebContentsView（webContents 保持存活），**不会重新加载**。
- **语言 / 主题同步** — 宿主语言与主题同步进 `~/.dsh/settings.yaml`（原文件备份为 `settings.dlient.yaml`），停止时还原。

## 功能特性

- 无需预装任何东西即可在 dlient 内运行 dsh（Node.js 自动解析）。
- `Chat` 是插件 UI 模块的具名导出 —— 任意插件用 `PluginView` 即可内嵌，传入 `workspace` 路径，就能得到一个与该工作区联动的真实 dsh 会话面板（插件侧无需处理进程 / URL）。
- `CMD_NODE` / `CMD_NPM` / `CMD_PNPM` 命令别名由宿主解析，**不弹命令授权框**，且授权在运行时升级后仍然有效。
- `DSH_HOME` 默认 `~/.dsh`，**与命令行 dsh 共享** —— 终端里 `dsh plugin --profile web add <pkg>` 加的插件，App 里同样可见。

## 使用说明

1. 无需预装运行时：首次运行解析 Node.js → 安装 DSH → 安装 `dlient-chat` profile（首次会下载依赖，可能需要几分钟）。
2. 在 dlient 中打开 dsh App（或在其他插件里内嵌 `Chat`）。
3. 在 DSH 界面中：Settings → Models 配置 API Key，然后选择一个 Workspace 开始。

### 内嵌 Chat

```tsx
import { PluginView } from '@dlient-open/ui'

// 可选：传入工作区（绝对目录路径）
<PluginView pluginId="dsh" entry="Chat" componentProps={{ workspace: '/path/to/project' }} />
```

- `pluginId` 是 dsh 的运行实例 id（已安装插件为 `dsh`，dev 实例为 `dsh@dev`）。
- 挂载时 `Chat` 调用 `dsh.chatStart`（worker 内幂等 + 单飞：多个消费者并发挂载也只会安装 / 启动一次），并用 `Webview` 内嵌 `http://127.0.0.1:<port>[?workspace=…]`。
- `workspace?: string`：（1）作为 `--workspace` 传给 dsh（注册为真实工作区分组），（2）以 `?workspace=…` 拼进页面 URL（客户端自动选中该工作区）。在服务**启动时**生效；运行中修改需 `dsh.chatStop` 后重启。
- `visible?: boolean`（默认 true）—— 传 `false` 可**不卸载**地隐藏内嵌 Webview（WebContentsView 从窗口层移除，webContents 保持存活；不会重新加载）。
- 加载 / 失败状态（含重试按钮）由 `Chat` 自行渲染。

## 导出的方法

| 方法 | 说明 |
|------|------|
| `dsh.start` | 确保 Node.js 与 DSH 就绪，启动 `dsh web` 服务并返回 URL |
| `dsh.stop` | 停止 `dsh web` 服务，并还原用户 `settings.yaml` |
| `dsh.status` | 查询 `dsh web` 服务状态（phase / url / error） |
| `dsh.chatStart` | 安装 `dlient-chat` profile 并启动 chat 服务，返回 URL |
| `dsh.chatStop` | 停止 chat 服务 |
| `dsh.chatStatus` | 查询 chat 服务状态（phase / url / error） |
| `dsh.applyAppearance` | 下发宿主语言 / 主题（同步进 `~/.dsh/settings.yaml`） |
| `dsh.restoreAppearance` | 还原 `~/.dsh/settings.yaml`（写回用户备份基线） |

## 运行时与授权说明

- **安装链**：内置 Node.js → `npm -g @deepseek-ai/dsh`（同时安装 `dsh plugin` 所需的 `pnpm`）→ 内联的 `@dlient/dsh-chat-ui` 资源写入 `<DATA>/chat-ui` 并安装进 `dlient-chat` profile。
- **沙箱合规**：worker 运行在宿主沙箱内（Node Permission Model），不能直接碰文件 —— 所有文件 / 进程 / 端口操作都走 host-api。
- **运行时授权**：读写 `~/.dsh/settings.yaml`（及备份 `settings.dlient.yaml`）需要一次性授权（`permission.request`）—— **仅这两个文件**。拒绝后语言 / 主题同步优雅降级，服务照常启动。
- **命令授权**：manifest 声明 `spawnCmds: ["CMD_NODE", "CMD_NPM", "CMD_PNPM"]` —— 宿主解析的**命令别名**而非绝对路径；授权按别名记账。
- **Chat 生命周期**：`start()` 幂等且单飞；**无空闲自动停止** —— 服务只在显式 `chatStop`、worker 退出（插件停用 / 卸载 / 覆盖安装、宿主退出）、或崩溃时结束。超时仅存在于启动 / 执行（如端口就绪 120s、安装 300s），绝不是 idle 杀手。

## 工程结构

```
dsh/
├─ assets/            图标、面向用户的文档（index.md / en-US / zh-CN）、SKILL.md、
│                     mcp.json、dsh-chat-ui（构建时内联进 dist/worker.js）
├─ src/
│  ├─ main/           worker（Node）：chat.ts / dsh-runtime.ts / index.ts
│  └─ renderer/       UI（React + Vite）：App.tsx / Chat.tsx / i18n.ts / styles.css
├─ script/            build-clean / build-worker / make-dlient
└─ package.json       dlient manifest（type: app）
```

内置 `assets/dsh-chat-ui` 在 **构建时** 经 esbuild 虚拟模块 `dlient:chat-assets` 内联进 `dist/worker.js`，运行时不读安装目录 —— manifest 因此无需 `fsDirs` 读授权（该目录仅作为构建源留在仓库）。

## 开发

```bash
npm install          # 依赖来自官方 registry
npm run dev          # vite build --watch + worker build --watch（concurrently）
npm run build        # build:ui + build:worker
npm run pack         # build + script/make-dlient.mjs → dsh-<version>.dlient
```

## 依赖与权限

- **共享包**：`@dlient-open/ui`（组件与 `Webview`）、`@dlient-open/api-bridge`、`@dlient-open/i18n`、`@dlient-open/plugin-sdk`（worker RPC）——从宿主 SystemJS 共享实例解析；`Webview` 组件**无需声明 webview 权限**（走 `PluginView` 注入的视图绑定客户端）。
- **host-api**：`nodejs.resolveRuntime` / `nodejs.install`、`child.spawn` / `child.execFile`、`net.getFreePort` / `net.probePort`、`fs.read` / `fs.mkdir` / `fs.write` / `fs.delete`、`app.getPath`、`permission.request`、`log.write`、`i18n.getLocale`。
- **技能**：本插件提供的 AI Agent 技能见 [assets/SKILL.md](assets/SKILL.md)。

## License

dlient 开源生态的一部分。见仓库根目录 `LICENSE`。
