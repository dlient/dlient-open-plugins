# Dev Tools（插件开发工具箱）

dlient 的 dev 插件管理与预览工具箱：在宿主 UI 内完成开发插件的创建、登记、构建、预览、打包与排障。它不替代你的编辑器，而是消除「改代码 → 重建 → 重启宿主」的摩擦。

> **简体中文** · [English](README.md)

## 功能特性

- **模板创建** — 通过宿主解析的 `CMD_NPM` 别名执行 `@dlient-open/create-plugin`（`npm exec --yes …`，插件内**不内置 scaffold**），随后把依赖安装进新目录。不带模式参数时生成的是**纯 UI 插件**（脚手架 `default` 模式：无 worker、无 `skills/`）；需要后台或原生代码时请用 `--worker` / `--native-host` / `--native` 创建。
- **登记目录** — 指向任意现有 dev 插件目录（含 `E:\dlient-open\plugins` 这类工作区）；加入列表后自动监听其 `package.json`，manifest 变更即时同步。
- **自动构建与 dev 实例** — 每个条目以独立的 `npm run dev:watch` 式进程构建；构建产物以真实 **dev 实例**（`pluginId@dev`）加载进宿主，行为与已安装插件完全一致，可直接预览。
- **预览与刷新** — 左栏实时预览 dev 插件 UI。刷新按钮**只刷新左侧预览**（不触碰内嵌的 Chat 面板）；加载失败/改码后重试不会命中缓存的失败，无需重启宿主即可恢复。
- **AI 面板（Chat）** — 右侧栏经 `PluginView` 内嵌 dsh 的 `Chat` 组件，是与工作区联动的真实 dsh 会话面板。仅在**预览视图**出现（日志 / 设置页保持整宽），可拖拽分隔条调宽（默认 220 px，点击 AI 按钮前默认隐藏）；折叠/展开只隐藏/显示原生视图，**不会重新加载**。
- **日志** — 每个条目的构建 / dev 进程输出，带进程注册表，实时流入日志页。
- **打包 `.dlient`** — 一键执行条目自身的 `make-dlient.mjs`（或兜底打包路径），在插件目录产出 `<id>-<version>.dlient`，可直接导入。
- **设置** — 内置运行时 Node.js 版本要求、npm registry 选择（国内自动 `npmmirror`）、以及逐条目的环境检查（`ensureEnv`：Node → 依赖 → manifest）。

## 环境要求

- dlient（开源版宿主），且可解析到 Node.js 运行时。dev-tools 声明 `spawnCmds: ["CMD_NODE", "CMD_NPM"]` —— 宿主把这两个**命令别名**解析为真实可执行文件（内置运行时 → PATH → 常见位置），无需绝对路径、也不弹命令授权框。
- 若使用 AI 面板，需已安装 dsh（面板内嵌 dsh 的 `Chat`；dsh 缺失时优雅降级）。
- 模板创建的 dev 插件，其 `@dlient-open/*` 依赖来自官方 npm registry（不使用指向宿主包的 `file:` 链接）。

## 工程结构

```
dev-tools/
├─ assets/            图标 + 面向用户的文档（index.md / en-US / zh-CN）
├─ src/
│  ├─ main/           worker（Node）：dev 条目、构建/dev 进程、打包、日志
│  └─ renderer/       UI（React + Vite）：Workbench / CreatePluginDialog / MarkdownEditor / Settings
├─ script/            build-clean / build-worker / make-dlient
└─ package.json       dlient manifest（type: app）
```

- **worker** 运行在宿主 worker 池。通过 host-api（`child.spawn`、`fs.*`、`nodejs.*`、`permission.request` …）与宿主通信，`fsDirs: { read/write: ["PLUGINS"] }`。
- **渲染端** 是 SystemJS remoteEntry 产物，从宿主的共享实例解析 `@dlient-open/ui`、`@dlient-open/api-bridge`、`@dlient-open/i18n`，另用 `@dlient-open/plugin-sdk` 做 worker RPC 客户端。

## 开发

```bash
npm install          # 依赖来自官方 registry
npm run dev          # vite build --watch + worker build --watch（concurrently）
npm run build        # build:ui + build:worker
npm run pack         # build + script/make-dlient.mjs → dev-tools-<version>.dlient
```

## Worker 方法（暴露给渲染端）

`list`、`register`、`remove`、`selectDirectory`、`checkImportable`、`changeToDev`、`getDirInfo`、`readSettings`/`writeSettings`、`readAsset`/`writeAsset`、`readMarkdown`/`writeMarkdown`、`checkNode`、`installNode`、`devCreatePlugin`、`runtimeStates`、`previewInfo`、`buildDev`、`stop`、`listBuilds`、`log`、`ensureDeps`、`checkManifest`、`ensureEnv`、`closePlugin`、`refresh`（stream）、`packDlient`、`revealPath`。

## 预览刷新原理

`refresh` stream 处理器会重建条目、等待新产物就绪，再请宿主重载插件实例；渲染端以带 cache-bust 查询参数的方式重挂预览 `PluginView`。失败的 SystemJS 加载会在**不同 URL** 上重试（不再命中缓存失败），每次重载前也会清空错误态——所以「AI 改完代码、预览变红」时，点一下刷新即可恢复，无需重启宿主。

## License

dlient 开源生态的一部分。见仓库根目录 `LICENSE`。
