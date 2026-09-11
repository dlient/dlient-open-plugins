# todo-list — 待办时间轴

## 1. 插件介绍

dlient-open（开源版）的本地待办时间轴，类型为 **app**（由基座启动器直接打开）。所有任务保存在插件自己的隔离数据目录，不联网、不需要账号，数据不离开本机。

- **UI**（`src/renderer`）：横向排布的「每天一列」时间轴。打开时**把今天那一列滚到视口正中**，页面左右两侧的悬浮箭头按屏翻页；每列列头都有「＋」，一键把该天填进新增表单。另有增删改勾选、过滤（全部 / 进行中 / 已完成）、搜索、四种「列内排序」、完成度进度条、行内编辑与插件日志查看。
- **worker**（`src/main`，产物 `dist/worker.js`）：数据的唯一权威来源。校验每次变更，经 `rpc.app.data.*` 落盘到 `plugin-data/todo-list/todos.json`，并广播 `todo-list.changed`，多个视图同时打开也能保持一致。
- **共享模型**（`src/shared/todo.ts`）：数据结构、校验上限、日期工具与统计口径由 UI 与 worker 共用。所有日期都是**本地零点毫秒时间戳**（不是精确时刻），跨夏令时 / 时区不会出现"同一天被判成两天"。
- **时间轴规划器**（`src/renderer/timeline.ts`）：纯函数，把任务列表 + 今天换算成列结构（基础窗口、空档折叠、未排期列），有独立单测。
- **多语言**：`src/renderer/i18n.ts` 注册 `zh-CN` / `en-US`；worker 错误以业务码 + 多语言 msg（`{ enUS, zhCN }`）返回，由 UI 按 locale 渲染。
- **主题**：不写死亮/暗颜色。结构色由 `currentColor` 的 `color-mix` 派生，语义色用宿主 shadcn 变量，亮暗自动适配。
- **构建自包含**：`vite.config.ts` 有意把 `lucide-react` 从预设的 external 列表里摘掉。宿主 SystemJS import map 中并没有这个裸标识符，直接 import 会让 `remoteEntry.js` 加载失败（`SystemJS Error#8：Unable to resolve bare specifier`）；图标因此改为按需打包进插件产物（约 7KB）。只有 `react` / `react-dom` / `@dlient-open/*` 保持 external（宿主共享单实例）。

### 时间轴行为

| 行为 | 说明 |
| --- | --- |
| 今天居中 | 首屏加载完成后把今天那一列滚到视口正中；随时点「回到今天」可再次居中 |
| 左右箭头 | 悬浮在时间轴左右两侧，按一屏（视口宽度的 85%）平滑滚动；到达两端自动禁用 |
| 日期列 | 显示星期 + 日期 + 任务数，今天列高亮；列头「＋」把该天填入表单并聚焦标题输入框 |
| 未排期列 | `startAt === null` 的任务收在最左侧一列；把任务开始日期清空即"移入未排期" |
| 空档折叠 | 今天窗口之外的成片空白折叠成一列「N 天」，所以排到几个月后的任务也不会渲染出几百个空列 |
| 基础窗口 | 今天 −7 ~ +14 天始终逐日展开（保证今天附近稳定）；用户显式选过的日期一定展开 |

## 2. 导出的方法

每个方法都返回**完整状态**（`TodoState`），调用方无需再补一次读取：

```ts
interface TodoState {
  todos: Todo[]
  stats: {
    total: number; active: number; completed: number
    overdue: number; dueToday: number      // 按截止日期统计
    todayActive: number                    // 今天开始且未完成
    unscheduled: number                    // startAt === null
    percent: number                        // 完成率
  }
  revision: number   // 每次成功变更自增
  updatedAt: number
}

// Todo:
// { id, title, note, done, priority,
//   startAt: number | null,   // 开始日期（本地零点）→ 决定它落在时间轴的哪一列；null = 未排期
//   dueAt:   number | null,   // 截止日期（本地零点）
//   createdAt, updatedAt, completedAt }
```

| 方法 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `todo-list.state` | — | `TodoState` | 读取全部待办与统计 |
| `todo-list.add` | `[{ title, startAt?, priority?, dueAt?, note? }]` | `TodoState` | 新增；`startAt` **缺省 = 今天**，`null` = 未排期 |
| `todo-list.update` | `[{ id, title?, note?, priority?, startAt?, dueAt?, done? }]` | `TodoState` | 局部修改（只改传入字段）；`startAt` 可把任务挪到别的日子 |
| `todo-list.toggle` | `[id, done?]` | `TodoState` | 勾选 / 取消勾选（缺省 `done` 则取反） |
| `todo-list.remove` | `[id]` | `TodoState` | 删除单条 |
| `todo-list.clearCompleted` | — | `TodoState` | 清除全部已完成 |

示例：把任务排到指定日期

```ts
const day = new Date()
day.setDate(day.getDate() + 3)
day.setHours(0, 0, 0, 0)                       // 本地零点

const res = await rpc.plugin.invoke('todo-list', 'todo-list.add', [
  { title: '发布新版本', startAt: day.getTime(), priority: 'high' },
])
```

业务错误码（插件区间，`<= -3001`）：`-3001` 任务不存在、`-3002` 入参不合法、`-3003` 保存失败，均带多语言 `msg`。

此外每次成功变更后 worker 会推送 **`todo-list.changed`**（payload = `TodoState`），UI 用 `api.onEvent('todo-list.changed', cb)` 订阅即可。

新增 / 删除方法时，请同步 `package.json` 的 `dlient.expose`、本表、`skills/SKILL.md` 与 `assets/mcp.json`。

## 3. 权限

| 权限 | 用途 |
| --- | --- |
| `app.data` | 读写 `plugin-data/todo-list/todos.json`（插件隔离 JSON 存储，原子写入） |
| `log` | worker 的 `rpc.log.write` 与 UI 的 `api.log.write` / `LogViewer` |

没有 `fs.*`、`child.*`，也不联网：插件只碰自己的数据目录。

### 数据迁移

`startAt` 是后加的字段。读取缺少该字段的旧数据时，worker 会按该任务的**创建当天**补齐（避免整个库突然落进「未排期」列）；显式 `null` 仍表示未排期，不做迁移。

## 4. skills 说明

本插件提供的 AI Agent 技能见 [skills/SKILL.md](skills/SKILL.md)。

## 开发步骤

1. 安装依赖：`npm install`。
2. 启动开发（热重载）：`npm run dev:watch` + `npm run dev:watch:worker`（或 `npm run dev` 同时启动两者）。
3. 构建产物：`npm run build`（typecheck → UI → worker，输出到 `dist/`）。
4. 打包：`npm run pack` → 生成 `<id>-<version>.dlient`（免签名）。
5. 在 dlient-open（开源版）左下角「＋ 导入插件」导入该 .dlient，即可在「已安装的应用」中打开。

## 目录结构

```
todo-list/
├── package.json              # manifest（dlient 子对象：id / name / type / source / icon / permissions / expose…）
├── vite.config.ts            # 插件 Vite 构建配置（UI 预设 + lucide 打包覆盖）
├── tsconfig.json
├── AGENTS.md                 # AI 编码代理入口（指向 .agent/）
├── .agent/                   # dlient 插件开发文档（供编码代理阅读）
├── script/                   # 构建脚本（build-clean / build-worker / make-dlient …）
├── README.md / README.cn.md  # 源文档（同步进 assets/index*.md）
├── skills/SKILL.md           # AI Agent 技能
├── assets/                   # 公开资源（图标 + 说明 + mcp）
│   ├── icon.svg              # 插件图标（清单样式）
│   ├── index.md              # 插件说明（默认/英文）
│   ├── index.en-US.md        # 英文插件说明
│   ├── index.zh-CN.md        # 中文插件说明
│   └── mcp.json              # MCP 工具描述
└── src/
    ├── shared/todo.ts        # UI 与 worker 共用的领域模型
    ├── renderer/
    │   ├── App.tsx           # 时间轴视图：滚动 / 居中、数据流
    │   ├── timeline.ts       # 纯函数列规划器（基础窗口、空档折叠）
    │   ├── i18n.ts / styles.css
    │   └── components/       # DayColumn / TodoRow / TodoComposer / DateField / PrioritySelect / TodoToolbar
    └── main/index.ts         # worker 入口（权威状态 + 持久化）
```
