# todo-list — Todo Timeline

## 1. Introduction

A local, day-by-day task timeline for the dlient-open host (`type: 'app'`, opened from the launcher). Tasks live in the plugin's own isolated data folder — no network, no account, nothing leaves the machine.

- **UI** (`src/renderer`): a horizontal timeline of day columns. On open the **today column is scrolled to the centre** of the viewport, and two floating arrows at the left/right edges page through the timeline. Every column header carries a “＋” that pre-fills the composer with that date. Plus add / edit / complete / delete, filter (all / active / completed), search, four in-column sort modes, a progress bar, inline editing and a plugin log viewer.
- **Worker** (`src/main`, `dist/worker.js`): owns the data. It validates every mutation, persists to `plugin-data/todo-list/todos.json` through `rpc.app.data.*`, and broadcasts `todo-list.changed` so multiple open views stay in sync.
- **Shared model** (`src/shared/todo.ts`): types, validation limits, date helpers and stats are shared by both halves, so the UI and the worker can never disagree about the data shape. All dates are **local-midnight epoch-ms timestamps** (never a precise instant), which keeps a task on the same day across DST / timezone changes.
- **Timeline planner** (`src/renderer/timeline.ts`): a pure function that turns the task list + today into the column list — base window, gap collapsing, unscheduled column.
- **Multi-language**: `src/renderer/i18n.ts` registers `zh-CN` / `en-US`; worker errors travel as codes + localized messages (`{ enUS, zhCN }`).
- **Theming**: no hardcoded light/dark colors — structure colors derive from `currentColor` (`color-mix`), semantic colors come from the host shadcn variables, so light and dark both work automatically.
- **Self-contained build**: `vite.config.ts` deliberately drops `lucide-react` from the preset's `external` list. The host's SystemJS import map does not contain that bare specifier, so importing it directly makes `remoteEntry.js` fail with `SystemJS Error#8` (“Unable to resolve bare specifier”); the icons are tree-shaken into the plugin bundle instead (~7 kB). Only `react` / `react-dom` / `@dlient-open/*` stay external (host-shared singletons).

### Timeline behaviour

| Behaviour | Detail |
| --- | --- |
| Today centred | After the first load the today column is scrolled to the middle of the viewport; the **“Back to today”** button repeats it at any time |
| Side arrows | Floating buttons over the left/right edges scroll one page (85 % of the viewport) with smooth scrolling; they disable at either end |
| Day columns | Weekday + date + task count; the today column is highlighted; “＋” prefills the composer with that day and focuses the title input |
| Unscheduled column | Tasks whose `startAt` is `null` are collected in a leading column (clearing a task's start date is how you “unschedule” it) |
| Gap collapsing | Long empty stretches *outside* the today window collapse into a single “N days” column, so a task months away never renders hundreds of empty columns |
| Base window | Today −7 … +14 days always renders day-by-day, keeping today's neighbourhood stable; dates you explicitly pick are always expanded |

## 2. Exported Methods

Every method returns the **full state** (`TodoState`) so a caller never needs a follow-up read:

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
  revision: number   // bumps on every successful change
  updatedAt: number
}

// Todo:
// { id, title, note, done, priority,
//   startAt: number | null,   // 开始日期（本地零点）→ 决定它落在时间轴的哪一列；null = 未排期
//   dueAt:   number | null,   // 截止日期（本地零点）
//   createdAt, updatedAt, completedAt }
```

| Method | Args | Returns | Description |
| --- | --- | --- | --- |
| `todo-list.state` | — | `TodoState` | Read all todos + stats |
| `todo-list.add` | `[{ title, startAt?, priority?, dueAt?, note? }]` | `TodoState` | Create a todo; `startAt` **defaults to today**, `null` = unscheduled |
| `todo-list.update` | `[{ id, title?, note?, priority?, startAt?, dueAt?, done? }]` | `TodoState` | Patch a todo (only sent fields change); `startAt` moves it to another day |
| `todo-list.toggle` | `[id, done?]` | `TodoState` | Complete / reopen (`done` omitted = flip) |
| `todo-list.remove` | `[id]` | `TodoState` | Delete one todo |
| `todo-list.clearCompleted` | — | `TodoState` | Delete every completed todo |

Example — schedule a task for a specific day:

```ts
const day = new Date()
day.setDate(day.getDate() + 3)
day.setHours(0, 0, 0, 0)                       // 本地零点

const res = await rpc.plugin.invoke('todo-list', 'todo-list.add', [
  { title: 'Ship the release', startAt: day.getTime(), priority: 'high' },
])
```

Business error codes (plugin range, `<= -3001`): `-3001` not found, `-3002` invalid input, `-3003` storage failure. Each carries a localized `msg`.

The worker also pushes **`todo-list.changed`** (payload = `TodoState`) after every successful change; subscribe with `api.onEvent('todo-list.changed', cb)` from the UI.

Keep `dlient.expose` in `package.json`, this table, `skills/SKILL.md` and `assets/mcp.json` in sync when you add or remove a method.

## 3. Permissions

| Permission | Why |
| --- | --- |
| `app.data` | Read / write `plugin-data/todo-list/todos.json` (isolated JSON storage, atomic writes) |
| `log` | `rpc.log.write` in the worker and `api.log.write` + `LogViewer` in the UI |

No `fs.*`, no `child.*`, no network: the plugin touches nothing outside its own data folder.

### Data migration

`startAt` was added after the first release. When loading old records that lack the field, the worker fills it with the **creation day** of that task (so an existing library does not suddenly land in the unscheduled column); an explicit `null` is preserved as “unscheduled”.

## 4. Skills

See [skills/SKILL.md](skills/SKILL.md) for the AI Agent skill this plugin provides.

## Development

1. Install dependencies: `npm install`.
2. Dev (hot reload): `npm run dev:watch` + `npm run dev:watch:worker` (or `npm run dev` for both).
3. Build: `npm run build` (typecheck → UI → worker; output to `dist/`).
4. Package: `npm run pack` → `<id>-<version>.dlient` (no signature).
5. Import in dlient-open (open source host, bottom-left “＋ Import plugin”); it appears under “Installed apps”.

## Directory structure

```
todo-list/
├── package.json              # manifest (dlient: id / name / type / source / icon / permissions / expose...)
├── vite.config.ts            # plugin Vite build config (UI preset + lucide bundling override)
├── tsconfig.json
├── AGENTS.md                 # AI coding-agent entry (points to .agent/)
├── .agent/                   # dlient plugin development docs for coding agents
├── script/                   # build scripts (build-clean / build-worker / make-dlient …)
├── README.md / README.cn.md  # source docs (synced into assets/index*.md)
├── skills/SKILL.md           # AI Agent skill of this plugin
├── assets/                   # public resources (icon + plugin description + mcp)
│   ├── icon.svg              # plugin icon (checklist)
│   ├── index.md              # plugin description (default / English)
│   ├── index.en-US.md        # English description
│   ├── index.zh-CN.md        # Chinese description
│   └── mcp.json              # MCP tool descriptions
└── src/
    ├── shared/todo.ts        # domain model shared by UI + worker
    ├── renderer/
    │   ├── App.tsx           # timeline view: scrolling / centring, data flow
    │   ├── timeline.ts       # pure column planner (window, gap collapse)
    │   ├── i18n.ts / styles.css
    │   └── components/       # DayColumn / TodoRow / TodoComposer / DateField / PrioritySelect / TodoToolbar
    └── main/index.ts         # worker entry (authoritative state + persistence)
```
