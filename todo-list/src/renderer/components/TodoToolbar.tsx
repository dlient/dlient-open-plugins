/**
 * 列表工具栏：过滤（全部 / 进行中 / 已完成，带数量）+ 搜索 + 排序。
 * 过滤与排序都是纯前端行为（worker 只保存创建顺序），因此不产生任何 RPC。
 */
import { ArrowUpDown, Search, X } from 'lucide-react'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from '@dlient-open/ui'
import {
  TODO_FILTERS,
  TODO_SORTS,
  filterLabelKey,
  sortLabelKey,
  type TodoFilter,
  type TodoSort,
  type Translate,
} from './common'

export interface TodoToolbarProps {
  tr: Translate
  filter: TodoFilter
  onFilterChange: (filter: TodoFilter) => void
  query: string
  onQueryChange: (query: string) => void
  sort: TodoSort
  onSortChange: (sort: TodoSort) => void
  counts: Record<TodoFilter, number>
}

export function TodoToolbar({
  tr,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  sort,
  onSortChange,
  counts,
}: TodoToolbarProps) {
  return (
    <div className="tl-toolbar">
      <ToggleGroup
        type="single"
        value={filter}
        onValueChange={(next) => {
          if (next) onFilterChange(next as TodoFilter)
        }}
        variant="outline"
        size="sm"
        className="tl-filters"
        aria-label={tr('todo-list.filterAll')}
      >
        {TODO_FILTERS.map((item) => (
          <ToggleGroupItem key={item} value={item} className="tl-filter-item">
            <span>{tr(filterLabelKey(item))}</span>
            <span className="tl-filter-count">{counts[item]}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="tl-toolbar-right">
        <div className="tl-search">
          <Search className="tl-search-icon" aria-hidden />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={tr('todo-list.searchPlaceholder')}
            aria-label={tr('todo-list.searchPlaceholder')}
            className="tl-search-input"
          />
          {query !== '' && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="tl-search-clear"
              onClick={() => onQueryChange('')}
              aria-label={tr('todo-list.clearSearch')}
              title={tr('todo-list.clearSearch')}
            >
              <X className="tl-icon-sm" aria-hidden />
            </Button>
          )}
        </div>

        <Select value={sort} onValueChange={(next) => onSortChange(next as TodoSort)}>
          <SelectTrigger size="sm" className="tl-sort-trigger" aria-label={tr('todo-list.sortLabel')}>
            <ArrowUpDown className="tl-icon-sm tl-muted" aria-hidden />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TODO_SORTS.map((item) => (
              <SelectItem key={item} value={item}>
                {tr(sortLabelKey(item))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
