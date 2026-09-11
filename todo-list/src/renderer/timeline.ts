/**
 * 时间轴切片（src/renderer/timeline.ts）。
 *
 * 纯函数、无 React / DOM 依赖：把「今天」画在中间，向左右展开成一个个"日期列"，
 * 并把远处成片空白折叠成间隔列，避免出现几百个空列。
 *
 * 规则：
 *  - 基础窗口：今天前 before 天 ~ 今天后 after 天，永远逐日展开（保证"今天居中"附近稳定）；
 *  - 有任务的日期一定展开；keepDays（用户当前选中的日期）也一定展开；
 *  - 窗口之外连续超过 collapseAfter 天的空档 → 折叠成一列间隔（总列数超过 collapseMinDays 才启用）。
 */

import { addDays, diffDays, startOfDay, startOfToday, type Todo } from '../shared/todo'

export interface TimelineDaySlot {
  kind: 'day'
  day: number
}
export interface TimelineGapSlot {
  kind: 'gap'
  from: number
  to: number
  /** 被折叠掉的天数 */
  days: number
}
export interface TimelineUnscheduledSlot {
  kind: 'unscheduled'
}
export type TimelineSlot = TimelineDaySlot | TimelineGapSlot | TimelineUnscheduledSlot

export interface BuildTimelineOptions {
  /** 今天（本地零点），缺省自动取系统时间 */
  today?: number
  /** 今天之前至少展示的天数 */
  before?: number
  /** 今天之后至少展示的天数 */
  after?: number
  /** 连续空档超过该天数才考虑折叠 */
  collapseAfter?: number
  /** 总天数超过该值才启用折叠 */
  collapseMinDays?: number
  /** 必须展开的日期（例如用户当前选中的开始日期） */
  keepDays?: Iterable<number>
}

export interface Timeline {
  slots: TimelineSlot[]
  hasUnscheduled: boolean
  firstDay: number
  lastDay: number
  /** 展开成具体日期列的数量（不含间隔列） */
  dayCount: number
}

const DEFAULTS = { before: 7, after: 14, collapseAfter: 14, collapseMinDays: 60 }

/** 按开始日期分组（startAt === null → 键为 null，即「未排期」） */
export function groupByDay(todos: readonly Todo[]): Map<number | null, Todo[]> {
  const map = new Map<number | null, Todo[]>()
  for (const todo of todos) {
    const key = todo.startAt === null ? null : startOfDay(todo.startAt)
    const bucket = map.get(key)
    if (bucket) bucket.push(todo)
    else map.set(key, [todo])
  }
  return map
}

export function timelineSlotKey(slot: TimelineSlot): string {
  if (slot.kind === 'unscheduled') return 'unscheduled'
  if (slot.kind === 'gap') return `gap-${slot.from}-${slot.to}`
  return `day-${slot.day}`
}

/** 该日期在时间轴上的定位标识（用于滚动居中查询 DOM） */
export function slotDayAttr(slot: TimelineSlot): string {
  return slot.kind === 'day' ? String(slot.day) : 'none'
}

export function buildTimeline(todos: readonly Todo[], options: BuildTimelineOptions = {}): Timeline {
  const today = startOfToday(options.today ?? Date.now())
  const before = options.before ?? DEFAULTS.before
  const after = options.after ?? DEFAULTS.after
  const collapseAfter = options.collapseAfter ?? DEFAULTS.collapseAfter
  const collapseMinDays = options.collapseMinDays ?? DEFAULTS.collapseMinDays

  const baseFrom = addDays(today, -before)
  const baseTo = addDays(today, after)

  // 有任务的日期 + 用户指定必须展开的日期：都视为"不能折叠"
  const pinned = new Set<number>()
  let hasUnscheduled = false
  for (const todo of todos) {
    if (todo.startAt === null) hasUnscheduled = true
    else pinned.add(startOfDay(todo.startAt))
  }
  for (const day of options.keepDays ?? []) pinned.add(startOfDay(day))

  let first = baseFrom
  let last = baseTo
  for (const day of pinned) {
    if (day < first) first = day
    if (day > last) last = day
  }

  const slots: TimelineSlot[] = []
  if (hasUnscheduled) slots.push({ kind: 'unscheduled' })

  const totalDays = diffDays(first, last) + 1
  const collapseEnabled = totalDays > collapseMinDays

  /**
   * 只有"空白 + 落在基础窗口之外"的日子才允许折叠。
   * 注意不能按"整段空档是否与窗口相交"来判断：那样一段从窗口内一直延伸到远期的空档永远不会折叠，
   * 一个排到 100 天后的任务就会渲染出上百个空列。
   */
  const collapsible = (day: number) => !pinned.has(day) && (day < baseFrom || day > baseTo)

  let runStart: number | null = null
  let runEnd: number | null = null
  let dayCount = 0

  const flushRun = () => {
    if (runStart === null || runEnd === null) return
    const runDays = diffDays(runStart, runEnd) + 1
    if (collapseEnabled && runDays > collapseAfter) {
      slots.push({ kind: 'gap', from: runStart, to: runEnd, days: runDays })
    } else {
      for (let day = runStart; day <= runEnd; day = addDays(day, 1)) {
        slots.push({ kind: 'day', day })
        dayCount += 1
      }
    }
    runStart = null
    runEnd = null
  }

  for (let day = first; day <= last; day = addDays(day, 1)) {
    if (collapsible(day)) {
      if (runStart === null) runStart = day
      runEnd = day
      continue
    }
    flushRun()
    slots.push({ kind: 'day', day })
    dayCount += 1
  }
  flushRun()

  return { slots, hasUnscheduled, firstDay: first, lastDay: last, dayCount }
}
