/**
 * todo-list 共享领域模型（src/shared/todo.ts）。
 *
 * worker（src/main）与 UI（src/renderer）同时引用本文件，保证两侧对数据结构、
 * 校验规则与统计口径的理解完全一致；此处只放纯数据 + 纯函数，
 * 不得引用 DOM / Node API（worker 与渲染层环境不同）。
 *
 * 日期口径：所有"日期"字段都是**本地零点毫秒时间戳**（不是精确时刻），
 * 这样跨时区 / 夏令时不会出现"同一天被判成两天"的问题；null = 未设置。
 */

/** 优先级：高 / 中 / 低（存储用英文枚举，展示文案由 UI 按 locale 渲染）。 */
export const TODO_PRIORITIES = ['high', 'normal', 'low'] as const
export type TodoPriority = (typeof TODO_PRIORITIES)[number]

export const TODO_TITLE_MAX = 200
export const TODO_NOTE_MAX = 1000

/** 单条待办。时间戳均为毫秒（Number）。 */
export interface Todo {
  id: string
  title: string
  /** 备注（可空字符串） */
  note: string
  done: boolean
  priority: TodoPriority
  /** 开始日期：本地零点时间戳；null = 未排期（时间轴的「未排期」列） */
  startAt: number | null
  /** 截止日期：本地零点时间戳；null = 未设置 */
  dueAt: number | null
  createdAt: number
  updatedAt: number
  /** 完成时间；未完成 = null */
  completedAt: number | null
}

export interface TodoStats {
  total: number
  active: number
  completed: number
  /** 未完成且截止日期早于今天 */
  overdue: number
  /** 未完成且截止日期就是今天 */
  dueToday: number
  /** 未完成且开始日期就是今天（"今天的活"） */
  todayActive: number
  /** 未排期（startAt === null）的任务数，含已完成 */
  unscheduled: number
  /** 完成率（0-100 整数，total=0 → 0） */
  percent: number
}

/** worker 返回给 UI 的完整状态（每次变更后 revision 自增，UI 可据此判断是否为新状态）。 */
export interface TodoState {
  todos: Todo[]
  stats: TodoStats
  revision: number
  updatedAt: number
}

/** 新增入参（startAt 缺省 = 今天；显式 null = 未排期） */
export interface AddTodoInput {
  title: string
  startAt?: number | null
  priority?: TodoPriority
  dueAt?: number | null
  note?: string
}

/** 修改入参（只传需要改的字段） */
export interface UpdateTodoInput {
  id: string
  title?: string
  note?: string
  priority?: TodoPriority
  startAt?: number | null
  dueAt?: number | null
  done?: boolean
}

/** worker → UI 推送事件名（UI 用 api.onEvent 订阅） */
export const TODO_CHANGED_EVENT = 'todo-list.changed'

/** 空状态（UI 首帧占位，避免 loading 期间渲染 undefined） */
export const EMPTY_TODO_STATE: TodoState = {
  todos: [],
  stats: {
    total: 0,
    active: 0,
    completed: 0,
    overdue: 0,
    dueToday: 0,
    todayActive: 0,
    unscheduled: 0,
    percent: 0,
  },
  revision: 0,
  updatedAt: 0,
}

export const DAY_MS = 24 * 60 * 60 * 1000

/** 本地零点时间戳（按运行环境时区） */
export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 今天零点 */
export function startOfToday(now: number = Date.now()): number {
  return startOfDay(now)
}

/** 在"本地零点"时间戳上加减天数（用 Date 逐日推算，避免夏令时导致的 23/25 小时误差） */
export function addDays(day: number, amount: number): number {
  const d = new Date(day)
  d.setDate(d.getDate() + amount)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 两个本地零点日期相差的天数（b - a） */
export function diffDays(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS)
}

/** 是否已逾期：未完成 + 有截止日期 + 截止日期早于今天 */
export function isOverdue(todo: Todo, now: number = Date.now()): boolean {
  return !todo.done && todo.dueAt !== null && todo.dueAt < startOfToday(now)
}

/** 是否今天到期 */
export function isDueToday(todo: Todo, now: number = Date.now()): boolean {
  return !todo.done && todo.dueAt !== null && todo.dueAt === startOfToday(now)
}

export function computeStats(todos: readonly Todo[], now: number = Date.now()): TodoStats {
  const today = startOfToday(now)
  let completed = 0
  let overdue = 0
  let dueToday = 0
  let todayActive = 0
  let unscheduled = 0
  for (const todo of todos) {
    if (todo.startAt === null) unscheduled += 1
    if (todo.done) {
      completed += 1
      continue
    }
    if (todo.startAt === today) todayActive += 1
    if (todo.dueAt === null) continue
    if (todo.dueAt < today) overdue += 1
    else if (todo.dueAt === today) dueToday += 1
  }
  const total = todos.length
  const active = total - completed
  return {
    total,
    active,
    completed,
    overdue,
    dueToday,
    todayActive,
    unscheduled,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

export function isTodoPriority(v: unknown): v is TodoPriority {
  return typeof v === 'string' && (TODO_PRIORITIES as readonly string[]).includes(v)
}

/**
 * 日期入参归一化：时间戳（数字）→ 本地零点；null / '' / undefined（空）→ null；
 * 非法值返回 undefined，表示"入参非法"（调用方据此报错，而不是静默忽略）。
 */
export function normalizeDay(v: unknown): number | null | undefined {
  if (v === null || v === '' || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return startOfDay(v)
}

/** Date（日历选择器）→ 本地零点时间戳 */
export function dateToDay(date: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function formatDateInput(ts: number | null): string {
  if (ts === null) return ''
  const d = new Date(ts)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 运行时类型守卫：校验 worker 推送 / 返回的数据确实是 TodoState（防止脏数据打崩渲染） */
export function isTodoState(v: unknown): v is TodoState {
  if (!v || typeof v !== 'object') return false
  const o = v as Partial<TodoState>
  return Array.isArray(o.todos) && !!o.stats && typeof o.stats === 'object' && typeof o.revision === 'number'
}
