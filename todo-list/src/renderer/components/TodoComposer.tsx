/**
 * 新增待办表单：标题（Enter 提交）+ 开始日期 + 截止日期 + 优先级。
 *
 * 开始日期由外部（App）持有：时间轴列头的"＋"需要把该天直接填进表单，
 * 所以这里做成受控 prop；标题 / 截止日 / 优先级是本地草稿，提交成功后清空（开始日期保留，
 * 方便连续为同一天排任务）。
 */
import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button, Input } from '@dlient-open/ui'
import type { AddTodoInput, TodoPriority } from '../../shared/todo'
import { DateField } from './DateField'
import { PrioritySelect } from './PrioritySelect'
import type { Translate } from './common'

export interface TodoComposerProps {
  tr: Translate
  locale: string
  busy: boolean
  /** 受控的开始日期（null = 未排期） */
  startAt: number | null
  onStartAtChange: (value: number | null) => void
  /** 数值变化即请求聚焦标题输入框（时间轴列头的"＋"用） */
  focusToken: number
  onSubmit: (input: AddTodoInput) => Promise<boolean>
}

export function TodoComposer({
  tr,
  locale,
  busy,
  startAt,
  onStartAtChange,
  focusToken,
  onSubmit,
}: TodoComposerProps) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TodoPriority>('normal')
  const [dueAt, setDueAt] = useState<number | null>(null)
  const inputWrapRef = useRef<HTMLDivElement>(null)

  /** 把焦点交回标题输入框（连续录入）。
   *  注意：@dlient-open/ui 的 Input 是普通函数组件、不转发 ref（传 ref 会触发
   *  "Function components cannot be given refs" 警告且拿不到实例），所以用容器查询真实 input。 */
  const focusInput = () => {
    inputWrapRef.current?.querySelector('input')?.focus()
  }

  useEffect(() => {
    if (focusToken > 0) focusInput()
  }, [focusToken])

  const submit = async () => {
    const text = title.trim()
    if (!text || busy) return
    const ok = await onSubmit({ title: text, startAt, priority, dueAt })
    if (!ok) return
    setTitle('')
    setPriority('normal')
    setDueAt(null)
    focusInput()
  }

  return (
    <div className="tl-composer">
      <form
        className="tl-composer-row"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="tl-composer-input" ref={inputWrapRef}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tr('todo-list.addPlaceholder')}
            aria-label={tr('todo-list.addPlaceholder')}
            maxLength={200}
          />
        </div>
        <div className="tl-composer-controls">
          <DateField kind="start" value={startAt} onChange={onStartAtChange} tr={tr} locale={locale} disabled={busy} />
          <DateField kind="due" value={dueAt} onChange={setDueAt} tr={tr} locale={locale} disabled={busy} />
          <PrioritySelect value={priority} onChange={setPriority} tr={tr} disabled={busy} />
          <Button type="submit" disabled={busy || !title.trim()} title={tr('todo-list.addHint')}>
            <Plus className="tl-icon-sm" aria-hidden />
            {tr('todo-list.addButton')}
          </Button>
        </div>
      </form>
    </div>
  )
}
