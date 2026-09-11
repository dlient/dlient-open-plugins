/**
 * UI 侧共享的小工具与常量（src/renderer/components/common.ts）。
 * 只放渲染相关的小函数：文案 key 映射、优先级样式、日期格式化。
 */
import { diffDays, startOfToday, type TodoPriority } from '../../shared/todo'

/** i18n 的 t 收敛为"一定返回字符串"的形式：占位符 / title / aria-label 等属性位需要 string。 */
export type Translate = (key: string, options?: Record<string, unknown>) => string

/** 过滤（列表视图） */
export type TodoFilter = 'all' | 'active' | 'completed'

/** 排序（纯 UI 行为，worker 只负责存储顺序；时间轴下表示"每天列内"的排序） */
export type TodoSort = 'createdDesc' | 'createdAsc' | 'dueAsc' | 'priority'

export const TODO_FILTERS: readonly TodoFilter[] = ['all', 'active', 'completed']
export const TODO_SORTS: readonly TodoSort[] = ['createdDesc', 'createdAsc', 'dueAsc', 'priority']

/** 优先级 → Badge variant（全部取自宿主主题语义色，自动适配亮/暗） */
export const PRIORITY_BADGE: Record<TodoPriority, 'destructive' | 'secondary' | 'outline'> = {
  high: 'destructive',
  normal: 'secondary',
  low: 'outline',
}

const PRIORITY_LABEL_KEY: Record<TodoPriority, string> = {
  high: 'todo-list.priorityHigh',
  normal: 'todo-list.priorityNormal',
  low: 'todo-list.priorityLow',
}

const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, normal: 1, low: 2 }

export function priorityLabel(tr: Translate, priority: TodoPriority): string {
  return tr(PRIORITY_LABEL_KEY[priority])
}

/** 排序用权重：高 → 低 */
export function priorityRank(priority: TodoPriority): number {
  return PRIORITY_RANK[priority]
}

export function filterLabelKey(filter: TodoFilter): string {
  if (filter === 'active') return 'todo-list.filterActive'
  if (filter === 'completed') return 'todo-list.filterCompleted'
  return 'todo-list.filterAll'
}

export function sortLabelKey(sort: TodoSort): string {
  if (sort === 'createdAsc') return 'todo-list.sortCreatedAsc'
  if (sort === 'dueAsc') return 'todo-list.sortDueAsc'
  if (sort === 'priority') return 'todo-list.sortPriority'
  return 'todo-list.sortCreatedDesc'
}

function shortDate(ts: number, locale: string): string {
  return new Date(ts).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  })
}

/** 短日期：3月5日 / Mar 5（用于徽标） */
export function formatShortDate(ts: number, locale: string): string {
  return shortDate(ts, locale)
}

/** 日期选择器上的文案：今天 / 明天 / 昨天 / 短日期 */
export function formatDayLabel(ts: number, locale: string, tr: Translate): string {
  const offset = diffDays(startOfToday(), ts)
  if (offset === 0) return tr('todo-list.today')
  if (offset === 1) return tr('todo-list.tomorrow')
  if (offset === -1) return tr('todo-list.yesterday')
  return shortDate(ts, locale)
}

/** 星期几：周四 / Thu */
export function weekdayLabel(ts: number, locale: string): string {
  return new Date(ts).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { weekday: 'short' })
}
