/**
 * 日期选择器（开始日期 / 截止日期共用）：Popover + 宿主 Calendar（react-day-picker，主题自适应），
 * 底部提供「设为今天」「清除日期」快捷操作。
 * 取值统一为"本地零点毫秒时间戳"，null = 未设置（开始日期为 null 即时间轴上的「未排期」）。
 */
import { useState } from 'react'
import { CalendarDays, CalendarPlus } from 'lucide-react'
import { Button, Calendar, Popover, PopoverContent, PopoverTrigger, cn } from '@dlient-open/ui'
import { dateToDay, startOfToday } from '../../shared/todo'
import { formatDayLabel, type Translate } from './common'

export type DateFieldKind = 'start' | 'due'

export interface DateFieldProps {
  kind: DateFieldKind
  value: number | null
  onChange: (value: number | null) => void
  tr: Translate
  locale: string
  disabled?: boolean
  className?: string
}

export function DateField({ kind, value, onChange, tr, locale, disabled, className }: DateFieldProps) {
  const [open, setOpen] = useState(false)

  const label = kind === 'start' ? tr('todo-list.startLabel') : tr('todo-list.dueLabel')
  const emptyLabel = kind === 'start' ? tr('todo-list.unscheduled') : tr('todo-list.dueNone')
  const Icon = kind === 'start' ? CalendarPlus : CalendarDays

  const pick = (next: number | null) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn('tl-date-trigger', value === null && 'tl-date-trigger-empty', className)}
          aria-label={label}
          title={label}
        >
          <Icon className="tl-icon-sm tl-muted" aria-hidden />
          <span className="tl-date-text">{value === null ? emptyLabel : formatDayLabel(value, locale, tr)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="tl-date-popover">
        <div className="tl-date-popover-title">{label}</div>
        <Calendar
          mode="single"
          selected={value === null ? undefined : new Date(value)}
          onSelect={(day) => pick(day ? dateToDay(day) : null)}
          autoFocus
        />
        <div className="tl-date-quick">
          <Button type="button" variant="ghost" size="sm" onClick={() => pick(startOfToday())}>
            {tr('todo-list.dateTodayAction')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => pick(null)}>
            {tr('todo-list.dateClear')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
