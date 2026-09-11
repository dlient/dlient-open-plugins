/**
 * todo-list worker 入口（src/main/index.ts）。
 *
 * 职责：待办数据的唯一权威来源（single source of truth）。
 *  - 持久化：`rpc.app.data.*`（隔离 JSON 存储，落 plugin-data/todo-list/todos.json，权限 app.data）；
 *  - 校验：标题 / 优先级 / 截止日 / 备注在 worker 侧统一校验，UI 只负责展示错误码文案；
 *  - 广播：每次变更后 `rpc.push('todo-list.changed', state)`，UI 订阅后自动刷新；
 *  - 跨插件：expose 的方法（state/add/update/toggle/remove/clearCompleted）可被其它插件经
 *    `rpc.plugin.invoke('todo-list', 'todo-list.add', [...])` 调用，与 manifest.dlient.expose 保持一致。
 *
 * 约束（见 .agent/references/dev-standards.md）：不直接使用 node:fs / 同步阻塞 I/O，
 * 一切特权操作走 host-api；不硬编码面向用户的文案，错误以业务码 + 多语言 msg 返回。
 */

import { createWorkerRpc, PluginError } from '@dlient-open/plugin-sdk'
import {
  TODO_CHANGED_EVENT,
  TODO_NOTE_MAX,
  TODO_TITLE_MAX,
  computeStats,
  isTodoPriority,
  normalizeDay,
  startOfDay,
  startOfToday,
  type AddTodoInput,
  type Todo,
  type TodoPriority,
  type TodoState,
  type UpdateTodoInput,
} from '../shared/todo'

const rpc = createWorkerRpc('todo-list')

/** 存储文件（相对 plugin-data/todo-list/），JSON 结构 { version, todos } */
const STORE_FILE = 'todos.json'
const STORE_VERSION = 1

/**
 * 业务错误码：插件自管，须 <= PLUGIN_ERROR_START(-3001)；
 * 宿主保留 -1xxx / -2xxx，插件区间从 -3001 起向更小。
 */
const ErrCode = {
  NOT_FOUND: -3001,
  INVALID_INPUT: -3002,
  STORAGE_FAILED: -3003,
} as const

/** 错误文案：多语言对象，UI 按 locale 解析（worker 不输出面向用户的硬编码文案） */
const ErrMsg = {
  notFound: { enUS: 'This todo no longer exists', zhCN: '该任务不存在或已被删除' },
  invalidInput: { enUS: 'Invalid input', zhCN: '入参不合法' },
  titleRequired: { enUS: 'Title is required', zhCN: '请填写任务标题' },
  titleTooLong: { enUS: `Title must be at most ${TODO_TITLE_MAX} characters`, zhCN: `标题最多 ${TODO_TITLE_MAX} 个字符` },
  noteTooLong: { enUS: `Note must be at most ${TODO_NOTE_MAX} characters`, zhCN: `备注最多 ${TODO_NOTE_MAX} 个字符` },
  storageFailed: { enUS: 'Failed to save todos', zhCN: '待办保存失败' },
} as const

interface StoreFile {
  version: number
  todos: Todo[]
}

// ---------------------------------------------------------------------------
// 内存状态 + 持久化
// ---------------------------------------------------------------------------

/** 内存中的待办列表（按创建顺序升序；排序交给 UI，避免多视图互相干扰） */
let todos: Todo[] = []
/** 变更版本号：每次成功落盘自增，UI 据此判断是否需要刷新推送 */
let revision = 0
/** 首次加载的 single-flight：并发请求只读一次磁盘 */
let readyPromise: Promise<void> | null = null

function cloneTodos(list: readonly Todo[]): Todo[] {
  return list.map((t) => ({ ...t }))
}

function snapshot(): TodoState {
  return {
    todos: cloneTodos(todos),
    stats: computeStats(todos),
    revision,
    updatedAt: Date.now(),
  }
}

function toPriority(v: unknown): TodoPriority | undefined {
  return isTodoPriority(v) ? v : undefined
}

/** 校验单条标题：返回规整后的标题，非法则抛业务错误 */
function parseTitle(v: unknown): string {
  if (typeof v !== 'string') throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.titleRequired)
  const title = v.trim()
  if (!title) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.titleRequired)
  if (title.length > TODO_TITLE_MAX) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.titleTooLong)
  return title
}

function parseNote(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
  const note = v.trim()
  if (note.length > TODO_NOTE_MAX) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.noteTooLong)
  return note
}

/** 脏数据兜底：从磁盘/快照恢复时逐条规整，非法条目直接丢弃（不让坏数据打崩 UI） */
function sanitizeTodos(input: unknown): Todo[] {
  if (!Array.isArray(input)) return []
  const out: Todo[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Partial<Todo>
    if (typeof t.id !== 'string' || !t.id) continue
    if (typeof t.title !== 'string' || !t.title.trim()) continue
    const createdAt = typeof t.createdAt === 'number' && Number.isFinite(t.createdAt) ? t.createdAt : Date.now()
    // startAt 是后加的字段：老数据没有该字段时按"创建当天"补上（否则整库突然落到「未排期」列）；
    // 显式 null 仍表示未排期，不做迁移。
    const start = t.startAt === undefined ? startOfDay(createdAt) : normalizeDay(t.startAt)
    const due = normalizeDay(t.dueAt)
    const done = t.done === true
    out.push({
      id: t.id,
      title: t.title.trim().slice(0, TODO_TITLE_MAX),
      note: typeof t.note === 'string' ? t.note.slice(0, TODO_NOTE_MAX) : '',
      done,
      priority: toPriority(t.priority) ?? 'normal',
      startAt: start === undefined ? null : start,
      dueAt: due === undefined || due === null ? null : due,
      createdAt,
      updatedAt: typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt) ? t.updatedAt : createdAt,
      completedAt: done && typeof t.completedAt === 'number' && Number.isFinite(t.completedAt) ? t.completedAt : null,
    })
  }
  return out
}

/**
 * 落盘提交：先在内存生效，写盘失败则回滚（保持内存与磁盘一致），
 * 成功后自增 revision、广播变更、写日志。
 */
async function commit(next: Todo[], action: string, extra?: Record<string, unknown>): Promise<TodoState> {
  const prevTodos = todos
  const prevRevision = revision
  todos = next
  revision = prevRevision + 1
  try {
    const payload: StoreFile = { version: STORE_VERSION, todos }
    await rpc.app.data.write(STORE_FILE, payload)
  } catch (err) {
    // 只有"本次提交仍是当前内存状态"时才回滚：若期间已有更晚的提交落盘成功，
    // 回滚反而会把新状态覆盖回旧值（并发写入的失败不应牵连已成功的那次）。
    if (todos === next) {
      todos = prevTodos
      revision = prevRevision
    }
    void rpc.log.write('error', 'persist failed', { action, err: err instanceof Error ? err.message : String(err) })
    throw new PluginError(ErrCode.STORAGE_FAILED, ErrMsg.storageFailed)
  }
  const state = snapshot()
  void rpc.log.write('info', action, { total: state.stats.total, active: state.stats.active, ...extra })
  rpc.push(TODO_CHANGED_EVENT, state)
  return state
}

/** 首次读取：文件不存在（首次运行）视为空列表；其它错误记 warn 后同样按空列表继续，不阻塞可用性 */
async function load(): Promise<void> {
  try {
    const raw = (await rpc.app.data.read(STORE_FILE)) as Partial<StoreFile> | null | undefined
    todos = sanitizeTodos(raw?.todos)
    void rpc.log.write('info', 'store loaded', { count: todos.length, version: raw?.version ?? STORE_VERSION })
  } catch (err) {
    todos = []
    void rpc.log.write('warn', 'store load skipped (treated as empty)', {
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 确保已加载（并发调用共享同一次读取） */
function ready(): Promise<void> {
  if (!readyPromise) readyPromise = load()
  return readyPromise
}

function newId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function requireIndex(id: unknown): number {
  if (typeof id !== 'string' || !id) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
  const idx = todos.findIndex((t) => t.id === id)
  if (idx === -1) throw new PluginError(ErrCode.NOT_FOUND, ErrMsg.notFound)
  return idx
}

// ---------------------------------------------------------------------------
// 方法与其它插件共享（manifest.dlient.expose 需保持一致）
// ---------------------------------------------------------------------------

/** 读取完整状态（UI 首屏 / 跨插件查询） */
rpc.registerHandler('todo-list.state', async () => {
  await ready()
  return snapshot()
})

/** 新增待办：{ title, startAt?, priority?, dueAt?, note? }（startAt 缺省 = 今天，显式 null = 未排期） */
rpc.registerHandler('todo-list.add', async (args) => {
  await ready()
  const input = (args?.[0] ?? {}) as AddTodoInput
  if (!input || typeof input !== 'object') throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)

  const title = parseTitle(input.title)
  // 显式传了非法优先级要报错（跨插件调用时静默降级成 normal 会很难排查）
  if (input.priority !== undefined && toPriority(input.priority) === undefined) {
    throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
  }
  const priority = toPriority(input.priority) ?? 'normal'
  const dueAt = normalizeDay(input.dueAt)
  if (dueAt === undefined) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
  // 未传 startAt → 落在"今天"这一天（时间轴上始终有归属）；显式传 null → 未排期
  const startAt = input.startAt === undefined ? startOfToday() : normalizeDay(input.startAt)
  if (startAt === undefined) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
  const note = parseNote(input.note)

  const now = Date.now()
  const todo: Todo = {
    id: newId(),
    title,
    note,
    done: false,
    priority,
    startAt,
    dueAt,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }
  return commit([...todos, todo], 'todo added', { id: todo.id, priority, startAt: todo.startAt })
})

/** 修改待办：{ id, title?, note?, priority?, startAt?, dueAt?, done? } */
rpc.registerHandler('todo-list.update', async (args) => {
  await ready()
  const input = (args?.[0] ?? {}) as UpdateTodoInput
  if (!input || typeof input !== 'object') throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)

  const idx = requireIndex(input.id)
  const current = todos[idx]
  const now = Date.now()
  const next: Todo = { ...current, updatedAt: now }

  if (input.title !== undefined) next.title = parseTitle(input.title)
  if (input.note !== undefined) next.note = parseNote(input.note)
  if (input.priority !== undefined) {
    const priority = toPriority(input.priority)
    if (!priority) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
    next.priority = priority
  }
  if (input.startAt !== undefined) {
    const startAt = normalizeDay(input.startAt)
    if (startAt === undefined) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
    next.startAt = startAt
  }
  if (input.dueAt !== undefined) {
    const dueAt = normalizeDay(input.dueAt)
    if (dueAt === undefined) throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
    next.dueAt = dueAt
  }
  if (input.done !== undefined) {
    if (typeof input.done !== 'boolean') throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
    applyDone(next, input.done, now)
  }

  const list = cloneTodos(todos)
  list[idx] = next
  return commit(list, 'todo updated', { id: next.id })
})

/** 勾选 / 取消勾选：{ id, done? }（done 缺省 = 取反） */
rpc.registerHandler('todo-list.toggle', async (args) => {
  await ready()
  const id = args?.[0]
  const explicit = args?.[1]
  if (explicit !== undefined && typeof explicit !== 'boolean') {
    throw new PluginError(ErrCode.INVALID_INPUT, ErrMsg.invalidInput)
  }
  const idx = requireIndex(id)
  const now = Date.now()
  const next: Todo = { ...todos[idx], updatedAt: now }
  applyDone(next, explicit === undefined ? !next.done : explicit, now)

  const list = cloneTodos(todos)
  list[idx] = next
  return commit(list, next.done ? 'todo completed' : 'todo reopened', { id: next.id })
})

/** 删除单条：{ id } */
rpc.registerHandler('todo-list.remove', async (args) => {
  await ready()
  const idx = requireIndex(args?.[0])
  const list = cloneTodos(todos)
  const [removed] = list.splice(idx, 1)
  return commit(list, 'todo removed', { id: removed?.id })
})

/** 清除全部已完成 */
rpc.registerHandler('todo-list.clearCompleted', async () => {
  await ready()
  const kept = todos.filter((t) => !t.done)
  const removed = todos.length - kept.length
  if (removed === 0) return snapshot()
  return commit(cloneTodos(kept), 'completed cleared', { removed })
})

/** 完成态必须与 completedAt 一起维护，否则会出现 done=false 却带 completedAt 的脏状态 */
function applyDone(todo: Todo, done: boolean, now: number): void {
  todo.done = done
  todo.completedAt = done ? now : null
}

// ---------------------------------------------------------------------------
// 生命周期：热重载 / 重启时保留内存状态
// ---------------------------------------------------------------------------

rpc.registerSnapshotHandler(() => ({ version: STORE_VERSION, revision, todos }))

rpc.registerRestoreHandler(async (raw) => {
  const snap = raw as { todos?: unknown; revision?: unknown } | null | undefined
  if (!snap || !Array.isArray(snap.todos)) return
  todos = sanitizeTodos(snap.todos)
  revision = typeof snap.revision === 'number' && Number.isFinite(snap.revision) ? snap.revision : revision
  readyPromise = Promise.resolve()
  void rpc.log.write('info', 'state restored from snapshot', { count: todos.length, revision })
})

void rpc.log.write('info', 'todo-list worker ready', { store: STORE_FILE })
