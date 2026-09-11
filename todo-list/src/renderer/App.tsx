/**
 * todo-list 主界面（src/renderer/App.tsx）。
 *
 * 视图：以「天」为单位的时间轴 —— 每天一列，今天默认滚到屏幕正中，左右两侧箭头翻页滚动。
 * 结构：header（标题 / 进度 / 全局操作）→ 新增表单 → 工具栏（过滤 / 搜索 / 排序）→ 时间轴 → 可选日志。
 *
 * 数据：worker 是唯一权威来源；本组件只做「调用 + 展示 + 前端过滤排序与分列」。
 *   - 首屏：api.request('todo-list.state') 拉取全量状态，随后把今天居中；
 *   - 变更：每次增删改的响应即最新状态（直接 setState），无需二次拉取；
 *   - 同步：订阅 worker 推送 'todo-list.changed'，多视图 / 多窗口保持一致（卸载时退订）。
 * 错误：请求统一 resolve 信封，失败按 code + 多语言 msg 用 MessagePlugin 提示。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarCheck, ChevronLeft, ChevronRight, ClipboardList, ListTodo, RefreshCw, Terminal } from 'lucide-react'
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Loading,
  LogViewer,
  MessagePlugin,
  Progress,
  defaultApiErrorMsg,
  isApiOk,
  modal,
  resolveApiMsg,
  toast,
  toApiError,
  useDlientApi,
  type ResponseErrorMsg,
} from '@dlient-open/ui'
import { useI18n } from '@dlient-open/i18n'
import './styles.css'
import './i18n'
import {
  EMPTY_TODO_STATE,
  TODO_CHANGED_EVENT,
  isTodoState,
  startOfToday,
  type AddTodoInput,
  type Todo,
  type TodoState,
  type UpdateTodoInput,
} from '../shared/todo'
import { buildTimeline, groupByDay, timelineSlotKey } from './timeline'
import { DayColumn } from './components/DayColumn'
import { TodoComposer } from './components/TodoComposer'
import { TodoToolbar } from './components/TodoToolbar'
import { priorityRank, type TodoFilter, type TodoSort, type Translate } from './components/common'

/** 滚动目标：某一天的本地零点时间戳，或「未排期」列 */
type CenterTarget = number | 'none'

export default function App() {
  const api = useDlientApi()
  const { t, locale } = useI18n()

  // 错误提示按当前 locale 解析，但不需要因为语言切换重跑数据请求：用 ref 读取最新值
  const localeRef = useRef(locale)
  localeRef.current = locale

  /** t 收敛为 string（属性位需要 string，t 的返回类型是 string | ReactNode） */
  const tr = useCallback<Translate>((key, options) => String(t(key, options)), [t])

  const [state, setState] = useState<TodoState>(EMPTY_TODO_STATE)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [filter, setFilter] = useState<TodoFilter>('all')
  const [sort, setSort] = useState<TodoSort>('createdDesc')
  const [query, setQuery] = useState('')
  const [showLogs, setShowLogs] = useState(false)

  // 新增表单的开始日期（受控：时间轴列头的「＋」会直接写入该日期）
  const [composerStart, setComposerStart] = useState<number | null>(() => startOfToday())
  const [focusToken, setFocusToken] = useState(0)
  // 用户显式选过的日期必须始终展开（否则可能落进被折叠的空白区间里"消失"）
  const [keepDays, setKeepDays] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [centerRequest, setCenterRequest] = useState<{ target: CenterTarget } | null>(null)
  const [scrollState, setScrollState] = useState({ atStart: true, atEnd: true })

  const bootstrapped = useRef(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const centeredRef = useRef(false)

  /** 今天（本地零点） */
  const today = startOfToday()

  const showError = useCallback(
    (code: number, msg?: ResponseErrorMsg) => {
      void api.log.write('error', 'request failed', { code })
      MessagePlugin.error(resolveApiMsg(msg, localeRef.current) || defaultApiErrorMsg(code, localeRef.current))
    },
    [api],
  )

  /** 统一的 worker 调用：成功用返回状态刷新界面，失败弹提示并返回 false */
  const call = useCallback(
    async (method: string, args: unknown[] = []): Promise<boolean> => {
      setPending(true)
      try {
        const res = await api.request<TodoState>(method, args)
        if (isApiOk(res) && isTodoState(res.data)) {
          setState(res.data)
          return true
        }
        showError(res.code, res.msg)
        return false
      } catch (err) {
        // 契约保证请求 resolve 信封不 throw，此处仅防御异常
        const apiError = toApiError(err, localeRef.current)
        void api.log.write('error', 'request threw', { method, code: apiError.code })
        MessagePlugin.error(apiError.message)
        return false
      } finally {
        setPending(false)
      }
    },
    [api, showError],
  )

  const load = useCallback(async () => {
    setLoading(true)
    const ok = await call('todo-list.state')
    setLoadFailed(!ok)
    setLoading(false)
  }, [call])

  useEffect(() => {
    // 首屏只加载一次：即使 api / load 的身份发生变化（依赖里带上它们是为了不读旧闭包），
    // 也由 ref 兜底跳过重复请求——避免任何"请求 → setState → 重新请求"的自激循环。
    if (bootstrapped.current) return
    bootstrapped.current = true
    void api.log.write('info', 'view mounted', { page: 'todo-list' })
    void load()
  }, [api, load])

  // worker → UI 推送：其它视图 / 窗口改动后同步（必须在卸载时退订，否则热重载会累积监听）
  useEffect(() => {
    return api.onEvent(TODO_CHANGED_EVENT, (data) => {
      if (isTodoState(data)) setState(data)
    })
  }, [api])

  const stats = state.stats

  const counts = useMemo<Record<TodoFilter, number>>(
    () => ({ all: stats.total, active: stats.active, completed: stats.completed }),
    [stats.total, stats.active, stats.completed],
  )

  /** 前端过滤 + 排序：worker 只保存创建顺序；时间轴下排序表示"每天列内"的顺序 */
  const visibleTodos = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const filtered = state.todos.filter((todo) => {
      if (filter === 'active' && todo.done) return false
      if (filter === 'completed' && !todo.done) return false
      if (keyword !== '' && !`${todo.title}\n${todo.note}`.toLowerCase().includes(keyword)) return false
      return true
    })
    const sorted = [...filtered]
    sorted.sort((a, b) => {
      if (sort === 'createdAsc') return a.createdAt - b.createdAt
      if (sort === 'dueAsc') {
        if (a.dueAt === null && b.dueAt === null) return b.createdAt - a.createdAt
        if (a.dueAt === null) return 1
        if (b.dueAt === null) return -1
        return a.dueAt - b.dueAt
      }
      if (sort === 'priority') {
        const diff = priorityRank(a.priority) - priorityRank(b.priority)
        return diff !== 0 ? diff : b.createdAt - a.createdAt
      }
      return b.createdAt - a.createdAt
    })
    return sorted
  }, [state.todos, filter, query, sort])

  /** 每天一列（列结构由"全部任务"决定：过滤 / 搜索不会让时间轴忽宽忽窄） */
  const slots = useMemo(
    () => buildTimeline(state.todos, { today, keepDays }).slots,
    [state.todos, today, keepDays],
  )
  const buckets = useMemo(() => groupByDay(visibleTodos), [visibleTodos])

  // ---------------------------------------------------------------------------
  // 时间轴滚动：今天居中 / 左右翻页 / 边缘禁用
  // ---------------------------------------------------------------------------

  const updateScrollState = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const atStart = el.scrollLeft <= 4
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4
    setScrollState((prev) => (prev.atStart === atStart && prev.atEnd === atEnd ? prev : { atStart, atEnd }))
  }, [])

  /** 把某一列滚到视口正中（"当天的放在最中间"就靠它） */
  const centerOn = useCallback((target: CenterTarget, behavior: ScrollBehavior = 'smooth') => {
    const el = scrollerRef.current
    if (!el) return
    const col = el.querySelector<HTMLElement>(`[data-day="${target}"]`)
    if (!col) return
    const colRect = col.getBoundingClientRect()
    const scrollerRect = el.getBoundingClientRect()
    const delta = colRect.left + colRect.width / 2 - (scrollerRect.left + scrollerRect.width / 2)
    if (Math.abs(delta) < 1) return
    el.scrollBy({ left: delta, behavior })
  }, [])

  /** 左右箭头：按一屏（85%）平滑滚动 */
  const scrollByPage = useCallback((direction: 1 | -1) => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({
      left: direction * Math.max(240, Math.round(el.clientWidth * 0.85)),
      behavior: 'smooth',
    })
  }, [])

  // 数据就绪后把今天居中（只做一次）
  useEffect(() => {
    if (loading) return
    // 首屏失败时"解绑"：重试成功后再补一次居中（否则时间轴永远停在最左侧）
    if (loadFailed) {
      centeredRef.current = false
      return
    }
    if (centeredRef.current) return
    centeredRef.current = true
    // 等一帧：让列先完成布局再计算居中位置
    const raf = requestAnimationFrame(() => {
      centerOn(today, 'auto')
      updateScrollState()
    })
    return () => cancelAnimationFrame(raf)
  }, [loading, loadFailed, today, centerOn, updateScrollState])

  // 列结构变化（增删任务 / 展开新日期）后刷新边缘可用状态
  useEffect(() => {
    const raf = requestAnimationFrame(updateScrollState)
    return () => cancelAnimationFrame(raf)
  }, [slots, updateScrollState])

  useEffect(() => {
    window.addEventListener('resize', updateScrollState)
    return () => window.removeEventListener('resize', updateScrollState)
  }, [updateScrollState])

  // 请求居中：等 React 提交 DOM 之后再滚（新增任务 / 选完日期 / 回到今天都走这里）
  useEffect(() => {
    if (!centerRequest) return
    const { target } = centerRequest
    const raf = requestAnimationFrame(() => {
      centerOn(target)
      updateScrollState()
      setCenterRequest(null)
    })
    return () => cancelAnimationFrame(raf)
  }, [centerRequest, centerOn, updateScrollState])

  // ---------------------------------------------------------------------------
  // 变更操作
  // ---------------------------------------------------------------------------

  const handleAdd = useCallback(
    async (input: AddTodoInput): Promise<boolean> => {
      const ok = await call('todo-list.add', [input])
      if (!ok) return false
      toast.success(tr('todo-list.toastAdded'))
      // 跳到新任务所在的那一天，让用户立刻看到它落在哪儿（worker 缺省 startAt = 今天）
      const target = input.startAt === undefined ? startOfToday() : input.startAt
      if (target !== null) {
        setKeepDays((prev) => (prev.has(target) ? prev : new Set(prev).add(target)))
      }
      setCenterRequest({ target: target === null ? 'none' : target })
      return true
    },
    [call, tr],
  )

  const handleToggle = useCallback(
    (todo: Todo, done: boolean) => {
      void call('todo-list.toggle', [todo.id, done])
    },
    [call],
  )

  const handleUpdate = useCallback(
    async (id: string, patch: Omit<UpdateTodoInput, 'id'>): Promise<boolean> => {
      const ok = await call('todo-list.update', [{ id, ...patch }])
      if (ok) {
        toast.success(tr('todo-list.toastUpdated'))
        // 改到别的日子时把新日期保持在视野内
        if (patch.startAt !== undefined && patch.startAt !== null) {
          const day = patch.startAt
          setKeepDays((prev) => (prev.has(day) ? prev : new Set(prev).add(day)))
          setCenterRequest({ target: day })
        }
      }
      return ok
    },
    [call, tr],
  )

  const handleDelete = useCallback(
    (todo: Todo) => {
      modal.confirm({
        title: tr('todo-list.deleteTitle'),
        description: tr('todo-list.deleteDesc', { title: todo.title }),
        confirmBtn: tr('todo-list.delete'),
        cancelBtn: tr('todo-list.cancel'),
        api,
        onConfirm: async () => {
          const ok = await call('todo-list.remove', [todo.id])
          if (ok) toast.success(tr('todo-list.toastDeleted'))
        },
      })
    },
    [api, call, tr],
  )

  const handleClearCompleted = useCallback(() => {
    const count = stats.completed
    if (count === 0) return
    modal.confirm({
      title: tr('todo-list.clearCompletedTitle'),
      description: tr('todo-list.clearCompletedDesc', { count }),
      confirmBtn: tr('todo-list.clearCompleted'),
      cancelBtn: tr('todo-list.cancel'),
      api,
      onConfirm: async () => {
        const ok = await call('todo-list.clearCompleted')
        if (ok) toast.success(tr('todo-list.toastCleared', { count }))
      },
    })
  }, [api, call, stats.completed, tr])

  /** 时间轴列头「＋」：把该天填进表单并聚焦输入框 */
  const handleAddToDay = useCallback((day: number) => {
    setComposerStart(day)
    setKeepDays((prev) => (prev.has(day) ? prev : new Set(prev).add(day)))
    setFocusToken((n) => n + 1)
  }, [])

  /** 表单里改开始日期：该日期必须可见，并滚进视野 */
  const handleComposerStartChange = useCallback((value: number | null) => {
    setComposerStart(value)
    if (value !== null) {
      setKeepDays((prev) => (prev.has(value) ? prev : new Set(prev).add(value)))
      setCenterRequest({ target: value })
    }
  }, [])

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  const searchEmpty = query.trim() !== '' && visibleTodos.length === 0

  const columnEmptyText = useMemo(() => {
    if (stats.total === 0) return tr('todo-list.emptyAll')
    if (filter === 'active') return tr('todo-list.emptyActive')
    if (filter === 'completed') return tr('todo-list.emptyCompleted')
    return tr('todo-list.dayEmpty')
  }, [filter, stats.total, tr])

  /** 只在「今天」列为空时多说一句引导，避免每一列都堆长文案 */
  const todayEmptyHint = useMemo(() => {
    if (stats.total === 0) return tr('todo-list.emptyAllDesc')
    if (filter === 'active') return tr('todo-list.emptyActiveDesc')
    if (filter === 'completed') return tr('todo-list.emptyCompletedDesc')
    return undefined
  }, [filter, stats.total, tr])

  return (
    <div className="tl-root">
      <header className="tl-header">
        <div className="tl-heading">
          <span className="tl-logo" aria-hidden>
            <ListTodo className="tl-logo-icon" />
          </span>
          <div className="tl-heading-text">
            <div className="tl-heading-line">
              <h1 className="tl-title">{tr('todo-list.title')}</h1>
              {stats.total > 0 && <Badge variant="secondary">{stats.total}</Badge>}
              {stats.todayActive > 0 && (
                <Badge variant="default">{tr('todo-list.todayCount', { count: stats.todayActive })}</Badge>
              )}
              {stats.overdue > 0 && (
                <Badge variant="destructive">{tr('todo-list.overdueSummary', { count: stats.overdue })}</Badge>
              )}
            </div>
            <p className="tl-subtitle">{tr('todo-list.summary', { active: stats.active, completed: stats.completed })}</p>
          </div>
        </div>

        <div className="tl-header-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCenterRequest({ target: today })}
            disabled={pending}
            title={tr('todo-list.backToToday')}
          >
            <CalendarCheck className="tl-icon-sm" aria-hidden />
            {tr('todo-list.backToToday')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={pending}
            title={tr('todo-list.refresh')}
            aria-label={tr('todo-list.refresh')}
          >
            <RefreshCw className="tl-icon-sm" aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowLogs((v) => !v)}>
            <Terminal className="tl-icon-sm" aria-hidden />
            {showLogs ? tr('todo-list.logsHide') : tr('todo-list.logsShow')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClearCompleted}
            disabled={pending || stats.completed === 0}
          >
            {tr('todo-list.clearCompleted')}
          </Button>
        </div>
      </header>

      <div className="tl-progress">
        <Progress value={stats.percent} className="tl-progress-bar" />
        <span className="tl-progress-label">{tr('todo-list.progressLabel', { percent: stats.percent })}</span>
      </div>

      <TodoComposer
        tr={tr}
        locale={locale}
        busy={pending}
        startAt={composerStart}
        onStartAtChange={handleComposerStartChange}
        focusToken={focusToken}
        onSubmit={handleAdd}
      />

      <TodoToolbar
        tr={tr}
        filter={filter}
        onFilterChange={setFilter}
        query={query}
        onQueryChange={setQuery}
        sort={sort}
        onSortChange={setSort}
        counts={counts}
      />

      <div className="tl-timeline-area">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="tl-nav tl-nav-prev"
          disabled={scrollState.atStart}
          onClick={() => scrollByPage(-1)}
          title={tr('todo-list.scrollPrev')}
          aria-label={tr('todo-list.scrollPrev')}
        >
          <ChevronLeft className="tl-nav-icon" aria-hidden />
        </Button>

        <div className="tl-timeline-wrap">
          {loading ? (
            <div className="tl-center">
              <Loading text={tr('todo-list.loading')} />
            </div>
          ) : loadFailed && state.todos.length === 0 ? (
            <Empty className="tl-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ClipboardList className="tl-empty-icon" aria-hidden />
                </EmptyMedia>
                <EmptyTitle>{tr('todo-list.loadFailed')}</EmptyTitle>
              </EmptyHeader>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={pending}>
                <RefreshCw className="tl-icon-sm" aria-hidden />
                {tr('todo-list.retry')}
              </Button>
            </Empty>
          ) : searchEmpty ? (
            <Empty className="tl-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ClipboardList className="tl-empty-icon" aria-hidden />
                </EmptyMedia>
                <EmptyTitle>{tr('todo-list.emptySearch')}</EmptyTitle>
                <EmptyDescription>{tr('todo-list.emptySearchDesc')}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="tl-timeline" ref={scrollerRef} onScroll={updateScrollState}>
              {slots.map((slot) => (
                <DayColumn
                  key={timelineSlotKey(slot)}
                  slot={slot}
                  todos={(slot.kind === 'day' ? buckets.get(slot.day) : buckets.get(null)) ?? []}
                  today={today}
                  tr={tr}
                  locale={locale}
                  busy={pending}
                  emptyText={columnEmptyText}
                  todayEmptyHint={todayEmptyHint}
                  onToggle={handleToggle}
                  onUpdate={handleUpdate}
                  onDelete={handleDelete}
                  onAddToDay={handleAddToDay}
                />
              ))}
            </div>
          )}
        </div>

        <Button
          type="button"
          variant="outline"
          size="icon"
          className="tl-nav tl-nav-next"
          disabled={scrollState.atEnd}
          onClick={() => scrollByPage(1)}
          title={tr('todo-list.scrollNext')}
          aria-label={tr('todo-list.scrollNext')}
        >
          <ChevronRight className="tl-nav-icon" aria-hidden />
        </Button>
      </div>

      {showLogs && <LogViewer className="tl-logs" height={200} />}
    </div>
  )
}
