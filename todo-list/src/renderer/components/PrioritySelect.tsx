/**
 * 优先级选择（新增 / 编辑共用）：宿主 @dlient-open/ui 的 Select，主题与暗色自动跟随。
 */
import { Flag } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@dlient-open/ui'
import { TODO_PRIORITIES, type TodoPriority } from '../../shared/todo'
import { priorityLabel, type Translate } from './common'

export interface PrioritySelectProps {
  value: TodoPriority
  onChange: (value: TodoPriority) => void
  tr: Translate
  disabled?: boolean
  className?: string
}

export function PrioritySelect({ value, onChange, tr, disabled, className }: PrioritySelectProps) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as TodoPriority)} disabled={disabled}>
      <SelectTrigger size="sm" className={className} aria-label={tr('todo-list.priorityLabel')}>
        <Flag className="tl-icon-sm tl-muted" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TODO_PRIORITIES.map((priority) => (
          <SelectItem key={priority} value={priority}>
            {priorityLabel(tr, priority)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
