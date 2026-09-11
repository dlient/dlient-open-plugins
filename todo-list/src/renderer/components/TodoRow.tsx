/**
 * 单条待办：展示态（勾选 / 优先级 / 截止日 / 操作）与内联编辑态。
 * 编辑态复用新增表单的选择器（DateField / PrioritySelect），保证两处交互一致；
 * 开始日期可在此修改（把任务挪到别的日子），设为空即回到「未排期」列。
 */
import { useEffect, useState } from 'react'
import { CalendarDays, Pencil, Trash2 } from 'lucide-react'
import { Badge, Button, Checkbox, Input, Textarea, cn } from '@dlient-open/ui'
import { isDueToday, isOverdue, type Todo, type TodoPriority, type UpdateTodoInput } from '../../shared/todo'
import { DateField } from './DateField'
import { PrioritySelect } from './PrioritySelect'
import { PRIORITY_BADGE, formatShortDate, priorityLabel, type Translate } from './common'

export interface TodoRowProps {
  todo: Todo
  tr: Translate
  locale: string
  busy: boolean
  onToggle: (todo: Todo, done: boolean) => void
  onUpdate: (id: string, patch: Omit<UpdateTodoInput, 'id'>) => Promise<boolean>
  onDelete: (todo: Todo) => void
}

export function TodoRow({ todo, tr, locale, busy, onToggle, onUpdate, onDelete }: TodoRowProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(todo.title)
  const [note, setNote] = useState(todo.note)
  const [priority, setPriority] = useState<TodoPriority>(todo.priority)
  const [startAt, setStartAt] = useState<number | null>(todo.startAt)
  const [dueAt, setDueAt] = useState<number | null>(todo.dueAt)
  const [touched, setTouched] = useState(false)

  // 外部数据变化（推送 / 其它视图修改）时，非编辑态需同步草稿，避免下次进入编辑态拿到旧值
  useEffect(() => {
    if (editing) return
    setTitle(todo.title)
    setNote(todo.note)
    setPriority(todo.priority)
    setStartAt(todo.startAt)
    setDueAt(todo.dueAt)
  }, [editing, todo])

  const overdue = isOverdue(todo)
  const dueToday = isDueToday(todo)

  const startEdit = () => {
    setTitle(todo.title)
    setNote(todo.note)
    setPriority(todo.priority)
    setStartAt(todo.startAt)
    setDueAt(todo.dueAt)
    setTouched(false)
    setEditing(true)
  }

  const cancelEdit = () => setEditing(false)

  const saveEdit = async () => {
    const text = title.trim()
    setTouched(true)
    if (!text || busy) return
    const ok = await onUpdate(todo.id, { title: text, note: note.trim(), priority, startAt, dueAt })
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <li className="tl-item tl-item-editing">
        <form
          className="tl-editor"
          onSubmit={(e) => {
            e.preventDefault()
            void saveEdit()
          }}
        >
          <Input
            value={title}
            autoFocus
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tr('todo-list.addPlaceholder')}
            aria-label={tr('todo-list.edit')}
            className={cn('tl-editor-title', touched && !title.trim() && 'tl-editor-invalid')}
          />

          <div className="tl-editor-fields">
            <DateField kind="start" value={startAt} onChange={setStartAt} tr={tr} locale={locale} disabled={busy} />
            <DateField kind="due" value={dueAt} onChange={setDueAt} tr={tr} locale={locale} disabled={busy} />
            <PrioritySelect value={priority} onChange={setPriority} tr={tr} disabled={busy} />
          </div>

          <Textarea
            value={note}
            rows={2}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr('todo-list.notePlaceholder')}
            aria-label={tr('todo-list.noteLabel')}
            className="tl-editor-note"
          />

          <div className="tl-editor-actions">
            {touched && !title.trim() ? <span className="tl-editor-hint">{tr('todo-list.titleRequired')}</span> : null}
            <Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={busy}>
              {tr('todo-list.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>
              {tr('todo-list.save')}
            </Button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className={cn('tl-item', todo.done && 'tl-item-done', overdue && 'tl-item-overdue')}>
      <Checkbox
        className={cn('tl-check', todo.done && 'tl-check-on')}
        checked={todo.done}
        disabled={busy}
        onCheckedChange={(checked) => onToggle(todo, checked === true)}
        aria-label={todo.done ? tr('todo-list.markActive') : tr('todo-list.markDone')}
      />

      <div className="tl-item-main">
        <div className="tl-item-title" title={todo.title}>
          {todo.title}
        </div>
        {todo.note !== '' && <div className="tl-item-note">{todo.note}</div>}
        <div className="tl-item-meta">
          <Badge variant={PRIORITY_BADGE[todo.priority]}>{priorityLabel(tr, todo.priority)}</Badge>
          {todo.dueAt !== null && (
            <Badge variant={overdue ? 'destructive' : dueToday ? 'warning' : 'outline'}>
              <CalendarDays className="tl-icon-xs" aria-hidden />
              {formatShortDate(todo.dueAt, locale)}
              {overdue ? ` · ${tr('todo-list.dueOverdueTag')}` : dueToday ? ` · ${tr('todo-list.dueTodayTag')}` : ''}
            </Badge>
          )}
        </div>
      </div>

      <div className="tl-item-actions">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={startEdit}
          title={tr('todo-list.edit')}
          aria-label={tr('todo-list.edit')}
        >
          <Pencil className="tl-icon-sm" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() => onDelete(todo)}
          title={tr('todo-list.delete')}
          aria-label={tr('todo-list.delete')}
        >
          <Trash2 className="tl-icon-sm" aria-hidden />
        </Button>
      </div>
    </li>
  )
}
