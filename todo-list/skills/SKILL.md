---
name: "todo-list"
description: "Local day-by-day todo timeline for the dlient host: create, schedule (start date), update, complete, delete and query tasks with priorities and due dates. Invoke when the user wants to capture, track, schedule, list or complete to-dos/tasks, or when another plugin needs the user's task list."
---

# todo-list — Todo Timeline

A self-contained task manager for the dlient-open host. The plugin keeps its data in its own isolated
folder (`plugin-data/todo-list/todos.json`, permission `app.data`) — nothing is uploaded anywhere.

The UI shows the tasks as a **timeline of days**: one column per day with today scrolled to the centre,
`startAt` deciding which column a task belongs to. `startAt === null` means “unscheduled” (a leading column).

## When to Use

- The user asks to add, schedule, reschedule, change, complete, reopen, delete or list their tasks / to-dos.
- The user wants to know what is planned for a given day, what is still open, or what is overdue.
- Another plugin wants to read or append to the user's task list (e.g. “add a reminder to my todos”).

## Methods

All methods return the **full state**, so there is never a need for a follow-up read:

```ts
interface TodoState {
  todos: Todo[]   // { id, title, note, done, priority, startAt, dueAt, createdAt, updatedAt, completedAt }
  stats: {
    total: number; active: number; completed: number
    overdue: number; dueToday: number      // 按截止日期
    todayActive: number                    // 开始日期是今天且未完成
    unscheduled: number                    // startAt === null
    percent: number
  }
  revision: number
  updatedAt: number
}
```

| Method | Args | Returns | Description |
|--------|------|---------|-------------|
| `todo-list.state` | — | `TodoState` | Read all todos + stats |
| `todo-list.add` | `[{ title, startAt?, priority?, dueAt?, note? }]` | `TodoState` | Create a todo (`title` required, ≤200 chars) |
| `todo-list.update` | `[{ id, title?, note?, priority?, startAt?, dueAt?, done? }]` | `TodoState` | Patch a todo (only sent fields change) |
| `todo-list.toggle` | `[id, done?]` | `TodoState` | Complete / reopen (`done` omitted = flip) |
| `todo-list.remove` | `[id]` | `TodoState` | Delete one todo |
| `todo-list.clearCompleted` | — | `TodoState` | Delete every completed todo |

Argument details:

- `startAt`: **which day the task is planned for.** Epoch-ms timestamp normalised to local midnight.
  Omitted on `add` = **today**; `null` = unscheduled (move it back later with `update`).
- `dueAt`: deadline, epoch-ms normalised to local midnight, or `null` for “no due date”.
- `priority`: `'high' | 'normal' | 'low'` (default `'normal'`).
- `note`: free text, ≤1000 chars.
- Both dates are **day-level**, not instants: pass a local-midnight timestamp
  (`const d = new Date(); d.setHours(0,0,0,0); d.getTime()`).

## Example

```ts
const rpc = createWorkerRpc('caller-plugin')   // from inside your own worker

const day = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  d.setHours(0, 0, 0, 0)          // 时间轴按"本地零点"分列
  return d.getTime()
}

// 1. create — planned for the day after tomorrow, due at the end of the week
const added = await rpc.plugin.invoke('todo-list', 'todo-list.add', [
  { title: 'Reply to the design review', startAt: day(2), priority: 'high', dueAt: day(5) },
])
const todo = added.data.todos[added.data.todos.length - 1]

// 2. move it to today
await rpc.plugin.invoke('todo-list', 'todo-list.update', [{ id: todo.id, startAt: day(0) }])

// 3. complete it later
await rpc.plugin.invoke('todo-list', 'todo-list.toggle', [todo.id, true])

// 4. read the current state
const state = await rpc.plugin.invoke('todo-list', 'todo-list.state')
```

From a plugin UI, talk to your own worker (`api.request`) as usual; to reach this plugin,
declare it in `manifest.dlient.dependencies` first — the host authorises `plugin.invoke` against
`dependencies` plus this plugin's `expose` access (`public`).

## Events

After every successful change the worker pushes **`todo-list.changed`** with the new `TodoState`:

```ts
useEffect(() => api.onEvent('todo-list.changed', (state) => setState(state)), [api])
```

## Errors

Business codes (plugin range, `<= -3001`), each with a localized message:

| Code | Meaning |
|------|---------|
| `-3001` | Todo not found |
| `-3002` | Invalid input (empty / too-long title, bad priority or start / due date) |
| `-3003` | Storage failure (the write was rolled back in memory) |

## Notes

- This is a dev-source plugin (`source: 'dev'`); it is not published to any market.
- Declared permissions: `app.data` (isolated JSON storage) and `log`. No file-system, subprocess or
  network access is used.
- The UI is only a view over the worker: the worker is the single source of truth for the data.
- Old records without `startAt` (the field was added later) are migrated to their creation day, so a
  pre-existing library does not suddenly appear in the unscheduled column.
