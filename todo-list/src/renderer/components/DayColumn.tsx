/**
 * 时间轴上的单列（src/renderer/components/DayColumn.tsx）。
 * 三种形态：
 *  - day        ：某一天（含"今天"高亮），列头可一键在该天新增任务；
 *  - gap        ：被折叠的连续空白日期（远处空档，避免渲染几百个空列）；
 *  - unscheduled：未排期（startAt === null）的收纳列。
 * 列内复用 TodoRow，保证勾选 / 编辑 / 删除交互与列表视图完全一致。
 */
import { CalendarPlus, Inbox, MoveHorizontal } from 'lucide-react'
import { Button, cn } from '@dlient-open/ui'
import type { Todo, UpdateTodoInput } from '../../shared/todo'
import type { TimelineSlot } from '../timeline'
import { TodoRow } from './TodoRow'
import { formatShortDate, weekdayLabel, type Translate } from './common'

export interface DayColumnProps {
  slot: TimelineSlot
  todos: Todo[]
  today: number
  tr: Translate
  locale: string
  busy: boolean
  /** 空列提示文案 */
  emptyText: string
  /** 仅「今天」列为空时额外展示的引导说明 */
  todayEmptyHint?: string
  onToggle: (todo: Todo, done: boolean) => void
  onUpdate: (id: string, patch: Omit<UpdateTodoInput, 'id'>) => Promise<boolean>
  onDelete: (todo: Todo) => void
  /** 在该天新增：切到该日期并聚焦输入框 */
  onAddToDay: (day: number) => void
}

export function DayColumn({
  slot,
  todos,
  today,
  tr,
  locale,
  busy,
  emptyText,
  todayEmptyHint,
  onToggle,
  onUpdate,
  onDelete,
  onAddToDay,
}: DayColumnProps) {
  if (slot.kind === 'gap') {
    return (
      <div className="tl-col tl-col-gap" title={tr('todo-list.hiddenDays', { count: slot.days })}>
        <MoveHorizontal className="tl-icon-sm tl-muted" aria-hidden />
        <span className="tl-col-gap-count">{tr('todo-list.hiddenDays', { count: slot.days })}</span>
      </div>
    )
  }

  const isUnscheduled = slot.kind === 'unscheduled'
  const day = slot.kind === 'day' ? slot.day : null
  const isToday = day !== null && day === today

  return (
    <section
      className={cn('tl-col', isToday && 'tl-col-today', isUnscheduled && 'tl-col-unscheduled')}
      data-day={day === null ? 'none' : String(day)}
      aria-label={day === null ? tr('todo-list.unscheduled') : `${weekdayLabel(day, locale)} ${formatShortDate(day, locale)}`}
    >
      <header className="tl-col-head">
        <div className="tl-col-head-main">
          {isUnscheduled ? (
            <Inbox className="tl-icon-sm tl-muted" aria-hidden />
          ) : null}
          <span className="tl-col-weekday">
            {day === null ? tr('todo-list.unscheduled') : weekdayLabel(day, locale)}
          </span>
          {day !== null && <span className="tl-col-date">{formatShortDate(day, locale)}</span>}
          {isToday && <span className="tl-col-today-tag">{tr('todo-list.today')}</span>}
        </div>
        <div className="tl-col-head-actions">
          {todos.length > 0 && <span className="tl-col-count">{todos.length}</span>}
          {day !== null && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="tl-col-add"
              disabled={busy}
              onClick={() => onAddToDay(day)}
              title={tr('todo-list.addToDay')}
              aria-label={tr('todo-list.addToDay')}
            >
              <CalendarPlus className="tl-icon-sm" aria-hidden />
            </Button>
          )}
        </div>
      </header>

      <div className="tl-col-body">
        {todos.length === 0 ? (
          <p className="tl-col-empty">
            {emptyText}
            {isToday && todayEmptyHint ? <span className="tl-col-empty-hint">{todayEmptyHint}</span> : null}
          </p>
        ) : (
          <ul className="tl-col-list">
            {todos.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                tr={tr}
                locale={locale}
                busy={busy}
                onToggle={onToggle}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
