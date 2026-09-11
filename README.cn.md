# dlient-open 插件集

**dlient-open**（开源版）的插件集合。dlient 是一个可以加载插件的 Electron 桌面宿主：一个插件可以包含 **worker**（Node，运行在沙箱化的 `utilityProcess` 中）和 / 或 **UI**（由宿主渲染进程加载的 React 产物）。所有文件 / 进程 / 网络操作都必须经由 **host-api**，并由主进程校验。

> [English](README.md) · **简体中文**

## 插件列表

| 插件 | 类型 | 说明 |
| --- | --- | --- |
| [`dev-tools`](dev-tools/) | app | 插件开发工具箱：模板创建、添加目录、自动构建、实例预览、打包成 `.dlient`、日志。 |
| [`dsh`](dsh/) | app | 在 dlient 中运行 DeepSeek Harness（dsh）AI Agent，并提供可被其他插件内嵌的聊天界面。 |
| [`todo-list`](todo-list/) | app | 本地待办时间轴（开始 / 截止日期、优先级、搜索、完成度），当天居中显示，数据不离开本机。 |

每个插件都是一个**独立目录**：自带 `package.json` 清单、构建脚本、文档与锁文件。本仓库不是 npm workspace，各插件之间不共享根级工具链，各自独立构建。

## 仓库结构

```
plugins/
├─ dev-tools/        # 插件开发工具箱
├─ dsh/              # DeepSeek Harness AI agent
├─ todo-list/        # 待办时间轴
├─ .gitignore
├─ LICENSE           # MIT
└─ README.md / README.cn.md
```

单个插件的目录结构（详见各插件自己的 README）：

| 路径 | 用途 |
| --- | --- |
| `package.json` → `dlient` | 插件清单（id / name / type / icon / permissions / expose…） |
| `src/main/` | worker（Node，经 `rpc.*` 调用 host-api）→ 构建为 `dist/worker.js` |
| `src/renderer/` | UI（React + Vite）→ 构建为 `dist/remoteEntry.js`（SystemJS） |
| `script/` | 构建脚本（`build-clean` / `build-worker` / `make-dlient`） |
| `assets/` | 图标 + 插件描述（`index.md` / `index.en-US.md` / `index.zh-CN.md`） |
| `AGENTS.md`、`.agent/` | 编码 Agent 入口与 dlient 插件开发文档（部分插件提供） |

## 环境要求

- **dlient-open** —— 加载并运行这些插件的开源宿主。
- **Node.js + npm** —— 用于构建；声明了 `spawnCmds` 的插件还需要可解析的 Node 运行时。
- **dsh** —— 仅在需要 `dev-tools` 的 AI 面板时安装（缺失时面板会优雅降级）。

## 开发

每个插件在自己的目录里独立构建：

```bash
cd todo-list
npm install
npm run dev      # 监听构建（UI + worker）
npm run build    # 类型检查 → UI → worker，产物输出到 dist/
npm run pack     # 构建并打包为 <id>-<version>.dlient
```

各插件通用的脚本：

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run dev` | 监听构建：UI（`vite build --watch`）+ worker（`esbuild --watch`） |
| `npm run build` | 类型检查 + 构建 UI + worker → `dist/` |
| `npm run pack` | 构建并打包为 `<id>-<version>.dlient`（未签名） |

## 安装构建产物

在 dlient-open 中点击左下角的**「＋ 导入插件」**，选择 `.dlient` 包即可；随后插件会出现在「已安装应用」中。

## 许可证

[MIT](LICENSE) © 2026 dlient contributors
