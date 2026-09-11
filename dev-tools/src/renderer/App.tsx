/**
 * dev-tools 主界面（src/renderer/App.tsx）。
 *
 * 视觉稿：plugin-html/modal/src/dev-tools（.pdr-* 体系）。
 * 稿中的标题栏 / 活动栏属宿主窗口壳职责，插件内不再重复实现，本组件从 Tab 栏起。
 *
 * 结构：Tab 栏（操作台 + 已打开插件）+ 操作区（预览 / 日志 / 设置）+ 内容区
 *  - 操作台：dev 插件卡片网格（新建 / 导入目录 / 打开 / 移除）
 *  - 预览：先 buildDev（幂等）拿 procId，dev 实例就绪后挂载 PluginView（<id>@dev）
 *  - 日志：LogViewer 传 filterId，读的是**被调试插件**的运行时日志（宿主按 '<id>@dev' 处理，未授权先待确认）
 *  - 设置：manifest 可编辑字段表单，保存写回目标插件 package.json
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  CloseIcon,
  Loading,
  LoadingIcon,
  LogViewer,
  MessagePlugin,
  Package,
  PluginIcon,
  PluginView,
  RefreshIcon,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Sparkles,
  Tabs,
  TabsList,
  TabsTrigger,
  AppIcon,
  TimeIcon,
  modal,
  useDlientApi,
  useWebviewClient,
  isApiOk,
  toApiError,
  apiOr,
  resolveApiMsg,
  type ResponseErrorMsg,
} from '@dlient-open/ui'
import { Settings } from './Settings'
import { Workbench } from './Workbench'
import { openCreatePluginDialog } from './CreatePluginDialog'
import { HOME_TAB, localize, type DevPlugin, type ViewKey } from './types'
import { useI18n } from '@dlient-open/i18n'
import './i18n'
import './styles.css'

const NS = 'dev-tools'

/** 深度相等（序列化比较）：轮询数据无变化时不触发 setState，避免周期性全量重渲染 */
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

interface BuildRec {
  procId: string
  caller: string
  kind: string
  pid: number
  status: string
  cwd: string
  startedAt: number
}

interface LogLine {
  ts: number
  stream: 'stdout' | 'stderr'
  data: string
}

interface PreviewInfo {
  pluginId: string
  remoteEntryUrl: string
  /** 是否有 UI（worker 类型无界面，预览 pane 显示占位） */
  hasUI?: boolean
  /** 未安装的依赖插件 id（开源版无插件市场，缺失时预览 pane 给出提示而非加载失败的 PluginView） */
  missingDeps?: string[]
}

const VIEWS: Array<{ key: ViewKey; labelKey: string }> = [
  { key: 'preview', labelKey: 'view.preview' },
  { key: 'log', labelKey: 'view.log' },
  { key: 'setting', labelKey: 'view.setting' },
]

/** 刷新步骤标题 i18n key（与 worker 端 REFRESH_STEP_TITLES 顺序一致） */
const REFRESH_STEPS = [
  'refreshStep.stopWorker',
  'refreshStep.stopBuild',
  'refreshStep.install',
  'refreshStep.build',
  'refreshStep.env',
  'refreshStep.done',
]

/** 操作区：视图分段 + 启动中标识 + 打包 .dlient / AI 面板 / 刷新 */
function ActionBar({
  view,
  onViewChange,
  booting,
  bootText,
  refreshing,
  onRefresh,
  packing,
  onPack,
  aiOpen,
  onToggleAi,
}: {
  view: ViewKey
  onViewChange: (v: ViewKey) => void
  booting?: boolean
  bootText?: string
  refreshing?: boolean
  onRefresh?: () => void
  /** 正在打包 .dlient */
  packing?: boolean
  onPack?: () => void
  /** AI 面板是否展开 */
  aiOpen?: boolean
  onToggleAi?: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="pdr-actionbar">
      <Tabs value={view} onValueChange={(v) => onViewChange(v as ViewKey)}>
        <TabsList>
          {VIEWS.map((v) => (
            <TabsTrigger key={v.key} value={v.key}>
              <span style={{padding: '0 20px'}}>{t(`${NS}.${v.labelKey}`)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="pdr-actionbar__right">
        {booting && (
          <div className="pdr-bootflag">
            <span className="pdr-bootflag__dot" />
            <span>{bootText ?? t(`${NS}.boot.starting`)}</span>
          </div>
        )}
        {/* 打包成 .dlient（本地，无签名/无上传） */}
        <button
          type="button"
          className={`pdr-iconbtn${packing ? ' is-spinning' : ''}`}
          title={String(t(`${NS}.action.packTitle`))}
          onClick={onPack}
          disabled={packing}
        >
          <Package size={14} />
        </button>
        {/* 刷新预览（重跑构建 / 环境就绪）与 AI 面板开关（预览右侧内嵌 dsh Chat）：
            这两个只属于预览页 —— 日志 / 设置标签选中时不显示 */}
        {view === 'preview' && (
          <>
            <button
              type="button"
              className={`pdr-iconbtn${refreshing ? ' is-spinning' : ''}`}
              title={String(t(`${NS}.action.refreshTitle`))}
              onClick={onRefresh}
            >
              <RefreshIcon size={14} />
            </button>
            <button
              type="button"
              className={`pdr-iconbtn pdr-iconbtn--ai${aiOpen ? ' is-active' : ''}`}
              title={String(t(aiOpen ? `${NS}.action.aiCloseTitle` : `${NS}.action.aiOpenTitle`))}
              onClick={onToggleAi}
            >
              <Sparkles size={14} />
              <span>{t(`${NS}.action.aiDev`)}</span>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 预览启动视图：把真实信号映射为三步进度，不做假动画。
 *  校验项目 → getDirInfo 成功；启动构建 → 有存活 procId；环境就绪 → 构建产物就绪 + watcher 已启动。
 *  （worker 由懒启动驱动：UI 挂载后首次 api 调用经 ensure-worker 才 fork，不在本视图等待）
 */
function BootView({
  pluginName,
  dirOk,
  buildOk,
  envReady,
  output,
  onCancel,
}: {
  pluginName: string
  dirOk: boolean
  buildOk: boolean
  envReady: boolean
  output?: string
  onCancel?: () => void
}) {
  const { t } = useI18n()
  const steps = [
    { title: t(`${NS}.boot.stepCheck`), desc: t(`${NS}.boot.stepCheckDesc`), done: dirOk },
    { title: t(`${NS}.boot.stepBuild`), desc: t(`${NS}.boot.stepBuildDesc`), done: buildOk },
    { title: t(`${NS}.boot.stepEnv`), desc: t(`${NS}.boot.stepEnvDesc`), done: envReady },
  ]
  const firstPending = steps.findIndex((s) => !s.done)
  const done = steps.filter((s) => s.done).length

  return (
    <div className="pdr-scroll">
      <div className="pdr-boot">
        <div className="pdr-boot__card">
          <div className="pdr-boot__head">
            <div className="pdr-boot__title">{t(`${NS}.boot.title`)}</div>
            <div className="pdr-boot__sub">
              {t(`${NS}.boot.sub`, { name: pluginName, done, total: steps.length })}
            </div>
          </div>

          <div className="pdr-boot__steps">
            {steps.map((s, i) => {
              const state = s.done ? 'done' : i === firstPending ? 'running' : 'pending'
              return (
                <div key={String(s.title)} className={`pdr-step pdr-step--${state}`}>
                  <div className={`pdr-step__icon pdr-step__icon--${state}`}>
                    {state === 'done' ? <CheckCircleFilledIcon /> : state === 'running' ? <LoadingIcon /> : <TimeIcon />}
                  </div>
                  <div className="pdr-step__body">
                    <div className="pdr-step__line">
                      <span className="pdr-step__title">{s.title}</span>
                    </div>
                    <div className="pdr-step__desc">{s.desc}</div>
                    {state === 'running' && output ? <div className="pdr-step__output">{output}</div> : null}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="pdr-boot__foot">
            <span className="pdr-boot__hint">{t(`${NS}.boot.hint`)}</span>
            {onCancel && (
              <button type="button" className="pdr-textbtn" onClick={onCancel}>
                {t(`${NS}.boot.stopBuild`)}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 刷新中视图：整链路（停 worker → 安装依赖 → 构建 → fork worker → 完成）期间显示各步骤实时状态 */
function RefreshView({
  pluginName,
  steps,
}: {
  pluginName: string
  steps: Array<{ title: string; status: 'pending' | 'running' | 'done' | 'error' }>
}) {
  const { t } = useI18n()
  return (
    <div className="pdr-scroll">
      <div className="pdr-boot">
        <div className="pdr-boot__card">
          <div className="pdr-boot__head">
            <div className="pdr-boot__title">{t(`${NS}.refresh.title`)}</div>
            <div className="pdr-boot__sub">{t(`${NS}.refresh.sub`, { name: pluginName })}</div>
          </div>
          <div className="pdr-boot__steps">
            {steps.map((s) => (
              <div key={s.title} className={`pdr-step pdr-step--${s.status}`}>
                <div className={`pdr-step__icon pdr-step__icon--${s.status}`}>
                  {s.status === 'done' ? (
                    <CheckCircleFilledIcon />
                  ) : s.status === 'error' ? (
                    <CloseCircleFilledIcon />
                  ) : s.status === 'running' ? (
                    <LoadingIcon />
                  ) : (
                    <TimeIcon />
                  )}
                </div>
                <div className="pdr-step__body">
                  <div className="pdr-step__line">
                    <span className="pdr-step__title">{t(`${NS}.${s.title}`)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="pdr-boot__foot">
            <span className="pdr-boot__hint">{t(`${NS}.refresh.hint`)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- Node.js 环境门禁：打开页面先检测内置运行时，缺失则就地安装（宿主内置 nodejs.install，无插件可内嵌） ----

/** 检测中视图：@dlient-open/ui Loading 居中（无文字） */
function NodeCheckView() {
  return (
    <div className="pdr-loading">
      <Loading size="small" loading={true} />
    </div>
  )
}

/** 内置 Node.js 运行时缺失视图：开源版 nodejs 并入宿主主进程（不再是插件、也没有 NodeInstall 向导），
 *  故直接经 dev-tools.installNode → 宿主 nodejs.install 下载安装内置 LTS，装完重新检测进主界面。 */
function NodeMissingView({
  installing,
  onInstall,
  onRetry,
}: {
  installing: boolean
  onInstall: () => void
  onRetry: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="pdr-boot">
      <div className="pdr-boot__card">
        <div className="pdr-boot__head">
          <div className="pdr-boot__title">{t(`${NS}.env.title`)}</div>
          <div className="pdr-boot__sub">{t(`${NS}.env.desc`)}</div>
        </div>
        <Button variant="default" className="dui:w-full" disabled={installing} onClick={onInstall}>
          {installing ? t(`${NS}.env.installing`) : t(`${NS}.env.install`)}
        </Button>
        <Button variant="outline" className="dui:w-full" disabled={installing} onClick={onRetry}>
          {t(`${NS}.env.retry`)}
        </Button>
      </div>
    </div>
  )
}

/** 日志视图：跨插件查看被调试插件（dev 实例，日志以 '<id>@dev' 身份推送）的运行时日志。
 *  传 LogViewer filterId（逻辑 id）即可：宿主按 '<id>@dev' 处理订阅/历史/清空/下载；
 *  未授权时 LogViewer 显示待确认页 → requestPermissions('logs.view.<id>')（runtime-confirm + 1 天授权）。 */
function LogsView({ pluginId }: { pluginId: string }) {
  return (
    <div className="pdr-logs">
      <LogViewer key={pluginId} className="pdr-logs__viewer" height="100%" filterId={pluginId} />
    </div>
  )
}

export default function App() {
  const api = useDlientApi()
  const { t, locale } = useI18n()
  const [plugins, setPlugins] = useState<DevPlugin[]>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [builds, setBuilds] = useState<BuildRec[]>([])
  /** dev 实例 worker 状态（instanceKey '<id>@dev' → status；来自宿主 plugin.runtimeList） */
  const [runtimes, setRuntimes] = useState<Record<string, string>>({})
  /** pluginId → 构建 procId（构建进程列表按 caller=dev-runtime 记录，无法反查目标插件，故本地维护映射） */
  const [procByPlugin, setProcByPlugin] = useState<Record<string, string>>({})
  const [previewByPlugin, setPreviewByPlugin] = useState<Record<string, PreviewInfo>>({})
  const [buildLog, setBuildLog] = useState<LogLine[]>([])
  /** 正在整链路刷新（卸载预览 → 停 worker → install → dev → 环境就绪）的插件 id */
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  /** pluginId → 预览环境是否就绪（构建产物就绪 + watcher 已启动；worker 由 UI 懒启动，不在此等待） */
  const [envReadyByPlugin, setEnvReadyByPlugin] = useState<Record<string, boolean>>({})
  /** pluginId → 未安装的依赖插件 id（预览前检测；非空则预览 pane 只给提示，不挂载 PluginView） */
  const [missingDepsByPlugin, setMissingDepsByPlugin] = useState<Record<string, string[]>>({})
  /** 刷新各步骤状态（流式进度；index 与 REFRESH_STEPS 对齐） */
  const [refreshSteps, setRefreshSteps] = useState<Array<'pending' | 'running' | 'done' | 'error'>>([])

  /** Node.js 环境门禁：checking（检测中，Loading）/ ready（可用）/ missing（缺失，就地安装内置运行时） */
  const [nodeGate, setNodeGate] = useState<'checking' | 'ready' | 'missing'>('checking')
  /** 开发环境所需的 Node 最低版本（自身 + dev 插件声明取最大；安装/校验门槛用） */
  const [requiredNodeVersion, setRequiredNodeVersion] = useState<string | undefined>(undefined)
  /** 正在安装内置 Node.js 运行时（按钮 loading） */
  const [nodeInstalling, setNodeInstalling] = useState(false)

  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string>(HOME_TAB)
  const [viewByTab, setViewByTab] = useState<Record<string, ViewKey>>({})
  /** 正在打包 .dlient 的插件 id（按钮 loading） */
  const [packingId, setPackingId] = useState<string | null>(null)
  /** AI 面板是否展开（预览右侧内嵌 dsh Chat） */
  const [aiOpen, setAiOpen] = useState(false)

  const view = viewByTab[active] ?? 'preview'
  /** AI 面板实际可见：开关打开 + 活动 tab 处于预览视图 */
  const showAi = aiOpen && active !== HOME_TAB && view === 'preview'
  /**
   * AI 面板内嵌的 dsh 实例 id：优先已安装实例 `dsh`，其次 dev 实例 `dsh@dev`
   * （开发宿主里 dsh 常以 @dev 运行）；都不在运行清单时回退 `dsh`（由 PluginView 渲染未就绪态）。
   */
  const aiPluginId = 'dsh' in runtimes ? 'dsh' : 'dsh@dev' in runtimes ? 'dsh@dev' : 'dsh'
  /**
   * AI 面板的 dsh 工作区 = 当前预览的 dev 插件目录（会话直接落在被开发的插件代码上）。
   * dsh 的 workspace 在服务启动时生效（运行中变更需先停止再启动），面板只在有活动插件时才可见，
   * 故首次展开时取到的就是该插件的目录。
   */
  const aiWorkspace = active === HOME_TAB ? undefined : plugins.find((p) => p.id === active)?.path
  /**
   * AI 面板的尺寸句柄（Resizable 面板命令式 API）：展开到最近一次宽度 / 折叠到 0。
   * 折叠而非卸载 → 内嵌 dsh Chat 的 webview 不重建、会话页面不重载。
   * 只在预览视图展开（showAi 已含 view === 'preview'）：日志 / 设置页保持整宽、不分栏。
   */
  const aiWidthRef = useRef(220)
  const aiPanelRef = useRef<{ collapse: () => void; resize: (size: number) => void } | null>(null)
  useEffect(() => {
    const panel = aiPanelRef.current
    if (!panel) return
    if (showAi) panel.resize(aiWidthRef.current)
    else panel.collapse()
  }, [showAi])

  // 预览 / AI 面板的 WebContentsView 是独立窗口层，不随 DOM 显隐（容器 display:none 时组件只跳过
  // bounds 更新，不会隐藏视图）。开源宿主里这些 webview 的 owner = 创建时的活动应用（即 dev-tools），
  // 故渲染层用绑定本视图的 webview 客户端按 owner 精确 hide/show：
  //   切出 tab → hideMine() 隐藏并返回本次隐藏的 view id（缓存）；切回 → showMine(ids) 只精确恢复这些。
  // 注意：hideMine 命中全部 dev-tools 归属 webview（含内嵌 dsh Chat），因此只在「切 tab / 切视图」时 hide，
  // 刷新构建路径不做 hide/show（否则会把正在使用的 AI 面板一起隐藏、切回时需重新恢复）。
  const webviewClient = useWebviewClient()
  const prevActiveRef = useRef(active)
  const hiddenViewsRef = useRef<Record<string, string[]>>({})

  const hidePreview = useCallback(
    (id: string) => {
      if (id === HOME_TAB || !webviewClient) return
      void webviewClient
        .hideMine()
        .then((res) => {
          const ids = Array.isArray(res?.data) ? res.data : []
          if (ids.length) hiddenViewsRef.current[id] = ids
        })
        .catch(() => undefined)
    },
    [webviewClient],
  )

  const showPreview = useCallback(
    (id: string) => {
      if (id === HOME_TAB || !webviewClient) return
      const ids = hiddenViewsRef.current[id]
      if (Array.isArray(ids) && ids.length) {
        delete hiddenViewsRef.current[id]
        void webviewClient.showMine(ids).catch(() => undefined)
      }
    },
    [webviewClient],
  )

  // 顶层 tab 切换：切出 tab 隐藏并缓存其 webview ids；切入 tab 按缓存精确恢复
  useEffect(() => {
    const prev = prevActiveRef.current
    if (prev === active) return
    prevActiveRef.current = active
    hidePreview(prev)
    showPreview(active)
  }, [active, hidePreview, showPreview])

  const loadPlugins = useCallback(async () => {
    const raw = await apiOr(api.request<unknown>('dev-tools.list'), [])
    setPlugins((Array.isArray(raw) ? raw : []) as DevPlugin[])
    setLoaded(true)
  }, [api])

  useEffect(() => {
    // 挂载即拉取 dev 插件列表：数据源是 worker（外部系统），正是 effect 的适用场景。
    // loadPlugins 内的 setState 都在 await 之后的异步回调里执行，effect 同步体只发起调用，
    // 不会造成级联渲染；规则按函数内是否出现 setState 静态判定，故误报（同 ui/log-viewer.tsx）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPlugins()
  }, [loadPlugins])

  /** Node.js 环境门禁检测：经 worker 判定内置运行时是否可用（worker 侧同时做 dev 目录批量授权）。
   *  数据源是 worker（外部系统），属 effect / 事件回调适用场景。 */
  const checkNode = useCallback(async () => {
    const res = await api.request<{ ready?: boolean; reason?: string; version?: string; requiredVersion?: string }>('dev-tools.checkNode')
    setRequiredNodeVersion(res?.data?.requiredVersion)
    setNodeGate(isApiOk(res) && res.data?.ready ? 'ready' : 'missing')
  }, [api])

  // 打开页面即检测 Node.js 环境
  useEffect(() => {
    void checkNode()
  }, [checkNode])

  /** 安装宿主内置 Node.js 运行时（nodejs 已并入宿主，无安装向导插件可内嵌；装完重新检测） */
  const runNodeInstall = useCallback(async () => {
    setNodeInstalling(true)
    try {
      const res = await api.request<{ ok?: boolean; version?: string }>('dev-tools.installNode', [requiredNodeVersion])
      if (!isApiOk(res) || !res.data?.ok) {
        MessagePlugin.error(`${String(t(`${NS}.msg.nodeInstallFail`))}：${toApiError(res, locale).message}`)
        return
      }
      MessagePlugin.success(String(t(`${NS}.msg.envOk`)))
      await checkNode()
    } catch (err) {
      MessagePlugin.error(`${String(t(`${NS}.msg.nodeInstallFail`))}：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setNodeInstalling(false)
    }
  }, [api, requiredNodeVersion, t, locale, checkNode])

  // 构建进程 / worker 状态 / 构建输出轮询
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      const bs = await apiOr(api.request<BuildRec[]>('dev-tools.listBuilds'), [])
      if (stopped) return
      const list = Array.isArray(bs) ? bs : []
      // 值比较后才 setState：轮询数据无变化时不触发重渲染（避免 2 秒一次的全量渲染）
      setBuilds((prev) => (sameJson(prev, list) ? prev : list))
      // 构建进程已退出/不在列表 → 清理映射（恢复「构建」入口，幂等）
      const alive = new Set(list.filter((b) => b.status === 'running').map((b) => b.procId))
      setProcByPlugin((prev) => {
        const next = { ...prev }
        let changed = false
        for (const [id, procId] of Object.entries(next)) {
          if (!alive.has(procId)) {
            delete next[id]
            changed = true
          }
        }
        return changed ? next : prev
      })

      const stRaw = await apiOr(api.request<unknown>('dev-tools.runtimeStates'), [])
      if (stopped) return
      const st = Array.isArray(stRaw) ? (stRaw as Array<{ id: string; status: string }>) : []
      const runtimesNext = st.reduce<Record<string, string>>((acc, r) => {
        if (r?.id) acc[r.id] = r.status
        return acc
      }, {})
      setRuntimes((prev) => (sameJson(prev, runtimesNext) ? prev : runtimesNext))

      const procId = active === HOME_TAB ? undefined : procByPlugin[active]
      if (procId) {
        const ls = await apiOr(api.request<LogLine[]>('dev-tools.log', [procId, 0]), [])
        if (stopped) return
        const log = Array.isArray(ls) ? ls : []
        setBuildLog((prev) => (sameJson(prev, log) ? prev : log))
      }
    }
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [api, active, procByPlugin])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    await loadPlugins()
    setRefreshing(false)
  }, [loadPlugins])

  /** 打开插件 Tab；预览视图顺带触发一次幂等构建 */
  const openPlugin = useCallback(
    async (id: string, target: ViewKey) => {
      setTabs((prev) => (prev.includes(id) ? prev : [...prev, id]))
      setActive(id)
      setViewByTab((prev) => ({ ...prev, [id]: target }))
      if (target !== 'preview') return

      const infoRes = await api.request<PreviewInfo>('dev-tools.previewInfo', [id])
      if (!isApiOk(infoRes)) {
        MessagePlugin.error(`${t(`${NS}.msg.previewInfoFail`)}：${toApiError(infoRes).message}`)
        return
      }
      if (infoRes.data) {
        const info = infoRes.data as PreviewInfo
        setPreviewByPlugin((prev) => ({ ...prev, [id]: info }))
        setMissingDepsByPlugin((prev) => ({ ...prev, [id]: info.missingDeps ?? [] }))
      }

      // 检查 manifest 是否合规（id 格式 / source=dev / 与注册一致），不合规直接中止并提示原因
      const chkRes = await api.request<{ ok?: boolean; error?: ResponseErrorMsg }>('dev-tools.checkManifest', [id])
      if (!isApiOk(chkRes) || !chkRes.data?.ok) {
        MessagePlugin.error(`${t(`${NS}.msg.manifestFail`)}：${resolveApiMsg(chkRes.data?.error, locale) || toApiError(chkRes).message}`)
        return
      }

      // 打开预览前先检查依赖：node_modules 缺失时 npm install（同步等待），确保构建可用
      const depsRes = await api.request<{ ok?: boolean; installed?: boolean }>('dev-tools.ensureDeps', [id])
      if (!isApiOk(depsRes)) {
        MessagePlugin.error(`${t(`${NS}.msg.depsFail`)}：${toApiError(depsRes).message}`)
        return
      }

      const res = await api.request<{ ok?: boolean; procId?: string; error?: ResponseErrorMsg }>('dev-tools.buildDev', [id])
      if (!isApiOk(res)) {
        MessagePlugin.error(`${t(`${NS}.msg.buildFail`)}：${toApiError(res).message}`)
        return
      }
      const data = res.data
      if (data?.ok && data.procId) {
        setProcByPlugin((prev) => ({ ...prev, [id]: data.procId as string }))
      } else {
        MessagePlugin.error(`${t(`${NS}.msg.buildFail`)}：${resolveApiMsg(data?.error, locale) || 'unknown'}`)
        return
      }

      // 环境就绪：等构建产物 + 启动热重载 watcher（不 fork worker，UI 挂载后懒启动）
      const envRes = await api.request<{ ok?: boolean; error?: ResponseErrorMsg }>('dev-tools.ensureEnv', [id])
      if (!isApiOk(envRes) || !envRes.data?.ok) {
        MessagePlugin.error(`${t(`${NS}.msg.envFail`)}：${resolveApiMsg(envRes.data?.error, locale) || toApiError(envRes).message}`)
        return
      }
      setEnvReadyByPlugin((prev) => ({ ...prev, [id]: true }))
    },
    [api, locale, t],
  )

  const closeTab = useCallback(
    async (id: string) => {
      // 正在刷新则先取消刷新态（worker 侧流会因构建被停而自然终止）
      if (refreshingId === id) setRefreshingId(null)
      setEnvReadyByPlugin((prev) => {
        if (!prev[id]) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setMissingDepsByPlugin((prev) => {
        if (!prev[id]) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      // 关闭流程：停 watcher → 移除 fork → 停 npm run dev（失败不阻塞）
      await api.request('dev-tools.closePlugin', [id]).catch(() => undefined)
      // 预览 webview 兜底：closePlugin 已停 dev worker，宿主按 owner 回收其 webview；
      // 这里清理本 tab 的可见性缓存，避免 ids 泄漏到后续复用
      delete hiddenViewsRef.current[id]
      setTabs((prev) => prev.filter((t) => t !== id))
      setActive((cur) => {
        if (cur !== id) return cur
        const rest = tabs.filter((t) => t !== id)
        return rest[rest.length - 1] ?? HOME_TAB
      })
    },
    [api, refreshingId, tabs],
  )

  const addDirectory = useCallback(async () => {
    const res = await api.request<string | null>('dev-tools.selectDirectory')
    if (!isApiOk(res)) {
      MessagePlugin.error(`${t(`${NS}.msg.selectDirFail`)}：${toApiError(res).message}`)
      return
    }
    const dir = res.data
    if (!dir) return

    // 导入失败（非有效插件目录）统一弹错误框
    const showImportFail = () => {
      modal.error({ title: t(`${NS}.msg.importFailTitle`), description: t(`${NS}.msg.importFailDesc`) })
    }

    // 1. 预检：是否有效插件目录 + source 是否需要改为 dev
    const check = await api.request<{ ok?: boolean; needsDevChange?: boolean; error?: ResponseErrorMsg }>(
      'dev-tools.checkImportable',
      [dir],
    )
    if (!isApiOk(check) || check.data?.ok !== true) {
      showImportFail()
      return
    }

    // 注册 + 成功提示 + 刷新列表
    const doRegister = async (): Promise<boolean> => {
      const regRes = await api.request('dev-tools.register', [dir])
      if (!isApiOk(regRes)) {
        showImportFail()
        return false
      }
      MessagePlugin.success(String(t(`${NS}.msg.registerOk`)))
      await loadPlugins()
      return true
    }

    // 2. source 非 dev → 弹确认框；确认后先改 source=dev 再导入
    if (check.data.needsDevChange) {
      modal.confirm({
        title: t(`${NS}.msg.importTitle`),
        description: t(`${NS}.msg.importConfirm`),
        confirmBtn: t(`${NS}.msg.importChangeAndImport`),
        cancelBtn: t(`${NS}.msg.importCancel`),
        onConfirm: async () => {
          const chg = await api.request('dev-tools.changeToDev', [dir]).catch(() => null)
          if (!isApiOk(chg)) {
            showImportFail()
            return true // 关闭确认框（错误框已提示）
          }
          await doRegister()
          return true
        },
      })
      return
    }

    // 3. 已是 dev 插件：直接注册
    await doRegister()
  }, [api, loadPlugins, t])

  const createPlugin = useCallback(() => {
    // 弹框填写插件 ID + 名称，worker 侧校验市场/本地重名（重复则提示无法创建）
    openCreatePluginDialog({
      api,
      onCreated: () => void loadPlugins(),
    })
  }, [api, loadPlugins])

  const removePlugin = useCallback(
    async (id: string) => {
      const res = await api.request('dev-tools.remove', [id])
      if (!isApiOk(res)) {
        MessagePlugin.error(`${t(`${NS}.msg.removeFail`)}：${toApiError(res).message}`)
        return
      }
      closeTab(id)
      MessagePlugin.success(String(t(`${NS}.msg.removeOk`, { id })))
      await loadPlugins()
    },
    [api, closeTab, loadPlugins, t],
  )

  const stopBuild = useCallback(
    async (id: string) => {
      const procId = procByPlugin[id]
      if (!procId) return
      const res = await api.request('dev-tools.stop', [procId])
      if (!isApiOk(res)) {
        MessagePlugin.error(`${t(`${NS}.msg.stopFail`)}：${toApiError(res).message}`)
        return
      }
      setProcByPlugin((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      MessagePlugin.success(String(t(`${NS}.msg.stopOk`)))
    },
    [api, procByPlugin, t],
  )

  /** 整链路刷新单个 dev 插件：流式进度（worker 逐步骤 emit）→ 卸载预览 → 停/install/dev → 环境就绪 → 重新加载 UI */
  const refreshPlugin = useCallback(
    async (id: string) => {
      setRefreshingId(id)
      // 刷新开始：环境就绪置为否（刷新期间显示 RefreshView）
      setEnvReadyByPlugin((prev) => (prev[id] ? { ...prev, [id]: false } : prev))
      setRefreshSteps(REFRESH_STEPS.map(() => 'pending'))
      let finalized = false
      let timer = 0
      const finish = (message?: string, ok?: boolean) => {
        if (finalized) return
        finalized = true
        window.clearTimeout(timer)
        setRefreshingId(null)
        // 成功：环境就绪（构建 + watcher），UI 切回预览后由懒启动 fork worker；失败：退出
        setEnvReadyByPlugin((prev) => (ok ? { ...prev, [id]: true } : prev))
        if (ok) {
          MessagePlugin.success(String(t(`${NS}.msg.refreshOk`)))
        } else if (message) {
          MessagePlugin.error(String(t(`${NS}.msg.refreshFail`, { msg: message })))
        }
        void loadPlugins()
      }
      try {
        // 流式进度：worker 经 ctx.emit 推步骤状态；step5 为终态（done/error 均驱动完成）
        const controller = api.listen('dev-tools.refresh', [id], (chunk: unknown) => {
          const c = chunk as { step?: number; status?: string; detail?: ResponseErrorMsg; procId?: string | null }
          if (typeof c.step !== 'number' || typeof c.status !== 'string') return
          const status: 'done' | 'error' | 'running' =
            c.status === 'done' ? 'done' : c.status === 'error' ? 'error' : 'running'
          setRefreshSteps((prev) => prev.map((s, i) => (i === c.step ? status : s)))
          if (c.step === 5) {
            // 终态：记录新构建 procId（旧映射已被轮询清理）
            if (c.procId) setProcByPlugin((prev) => ({ ...prev, [id]: c.procId as string }))
            finish(
              status === 'done' ? '' : c.detail != null ? resolveApiMsg(c.detail, locale) : String(t(`${NS}.msg.refreshFail`)),
              status === 'done',
            )
          }
        })
        // 兜底：worker 异常 / 流中断时防「一直 loading」
        timer = window.setTimeout(() => {
          controller.abort()
          finish(String(t(`${NS}.msg.refreshTimeout`)), false)
        }, 3 * 60 * 1000)
      } catch (err) {
        finish(err instanceof Error ? err.message : String(err), false)
      }
    },
    [api, loadPlugins, locale, t],
  )

  /** 打包单个 dev 插件为 .dlient（worker 侧执行插件自身 npm run pack；本地无签名/无上传） */
  const packPlugin = useCallback(
    async (id: string) => {
      if (packingId) return
      setPackingId(id)
      try {
        const res = await api.request<{ ok?: boolean; dir?: string; file?: string }>('dev-tools.packPlugin', [id])
        if (!isApiOk(res) || !res.data?.ok) {
          MessagePlugin.error(`${t(`${NS}.msg.packFail`)}：${toApiError(res).message}`)
          return
        }
        const file = String(res.data.file ?? '')
        const dir = String(res.data.dir ?? '')
        MessagePlugin.success(
          String(
            t(`${NS}.msg.packOk`, {
              path: dir && file ? `${dir}${dir.endsWith('\\') || dir.endsWith('/') ? '' : '\\'}${file}` : file,
            }),
          ),
        )
      } catch (err) {
        MessagePlugin.error(`${t(`${NS}.msg.packFail`)}：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setPackingId(null)
      }
    },
    [api, packingId, t],
  )

  const runtimeOf = useCallback((id: string) => runtimes[`${id}@dev`] ?? 'stopped', [runtimes])

  /**
   * 预览页单个 tab 的预览 pane（常驻：非 active 用 display 隐藏，切走不卸载 → 预览 UI 不重载）。
   * 只出现在预览页分栏的左栏（.pdr-preview-panel）内；其内嵌 WebContentsView 的显隐由宿主
   * webview-manager 管理（切 tab / 切视图时 hide 并缓存 view id、切回时精确 show，见上方 effect）。
   */
  const renderPreviewBodyFor = (id: string) => {
    const p = plugins.find((x) => x.id === id)
    if (!p) return null
    const name = localize(p.name, id)

    const info = previewByPlugin[id]
    const envReady = !!envReadyByPlugin[id]
    const missingDeps = missingDepsByPlugin[id] ?? []
    const build = builds.find((b) => b.procId === procByPlugin[id])
    const buildOk = !!build && build.status === 'running'
    const tail = buildLog.filter((l) => l.data.trim())

    const previewContent =
      refreshingId === id ? (
        <RefreshView
          pluginName={name}
          steps={REFRESH_STEPS.map((title, i) => ({ title, status: refreshSteps[i] ?? 'pending' }))}
        />
      ) : info && envReady && info.hasUI === false ? (
        // worker 类型无界面：不加载不存在的 remoteEntry，预览 pane 显示占位（运行状态在日志视图查看）
        <div className="pdr-preview">
          <div className="pdr-preview__empty">{t(`${NS}.preview.workerOnly`)}</div>
        </div>
      ) : info && envReady ? (
        // 依赖未安装（开源版无插件市场可自动安装）→ 只给提示；否则直接挂真实 PluginView
        // （dev 实例 worker 懒启动，由 UI 首次 api 调用触发）
        missingDeps.length > 0 ? (
          <div className="pdr-preview">
            <div className="pdr-preview__empty">{t(`${NS}.preview.missingDeps`, { deps: missingDeps.join(', ') })}</div>
          </div>
        ) : (
          <div className="pdr-preview">
            <PluginView key={id} pluginId={info.pluginId} remoteEntryUrl={info.remoteEntryUrl} />
          </div>
        )
      ) : (
        <BootView
          pluginName={name}
          dirOk={!!info}
          buildOk={buildOk}
          envReady={envReady}
          output={tail[tail.length - 1]?.data.trim()}
          onCancel={buildOk ? () => void stopBuild(id) : undefined}
        />
      )

    return (
      <div
        key={`preview-${id}`}
        className="pdr-tabbody"
        style={{ display: active === id ? undefined : 'none' }}
      >
        <div className="pdr-viewpane">{previewContent}</div>
      </div>
    )
  }

  /**
   * 日志 / 设置页单个 tab 的内容（整宽，不带分栏）；两个 pane 常驻，按该 tab 当前视图切换显隐。
   */
  const renderOtherBodyFor = (id: string) => {
    const p = plugins.find((x) => x.id === id)
    if (!p) return null
    const v = viewByTab[id] ?? 'preview'
    return (
      <div
        key={`other-${id}`}
        className="pdr-tabbody"
        style={{ display: active === id ? undefined : 'none' }}
      >
        <div className={`pdr-viewpane${v === 'log' ? '' : ' is-hidden'}`}>
          <LogsView pluginId={id} />
        </div>
        <div className={`pdr-viewpane${v === 'setting' ? '' : ' is-hidden'}`}>
          <Settings key={id} pluginId={id} onSaved={() => void loadPlugins()} />
        </div>
      </div>
    )
  }

  // 预览环境未就绪（构建产物/watcher 未完成）时显示「正在启动开发服务器」标志
  const booting = active !== HOME_TAB && view === 'preview' && !envReadyByPlugin[active]

  // 同一 tab 内视图切换（preview ↔ log/setting）：WebContentsView 原生层不随 DOM 隐藏，
  // 主动 hide/show 该插件 webview（一律走缓存精确恢复，不做全量 show，避免干扰其它 tab 的 webview）。
  // 刷新**不**做 hide：预览 PluginView 本就会卸载（改为渲染刷新步骤页），重挂载后新 webview 自然可见；
  // 而 hideMine 是按 owner 命中全部 dev-tools 归属视图，会把内嵌的 AI 面板（dsh Chat）一起隐藏掉。
  useEffect(() => {
    if (active === HOME_TAB) return
    if (view !== 'preview') {
      hidePreview(active)
    } else {
      showPreview(active)
    }
  }, [active, view, hidePreview, showPreview])

  // Node.js 环境门禁：检测中 → Loading；缺失 → 就地安装内置运行时；就绪 → 主界面
  if (nodeGate === 'checking') {
    return <NodeCheckView />
  }
  if (nodeGate === 'missing') {
    return (
      <div className="pdr">
        <div className="pdr-view">
          <NodeMissingView
            installing={nodeInstalling}
            onInstall={() => void runNodeInstall()}
            onRetry={() => void checkNode()}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="pdr">
      <div className="pdr-tabs">
        <Tabs
          value={active}
          onValueChange={(v) => setActive(String(v))}
          style={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}
        >
          <TabsList
            variant="line"
            scrollable
            style={{
              height: '100%',
              // 底部留 5px：line 模式指示器在 trigger 下 5px，滚动容器 overflow 会裁掉，
              // 用底部 padding 让它落在裁剪边界内
              padding: '0 0 5px',
              borderRadius: 0,
              backgroundColor: 'transparent',
              justifyContent: 'flex-start',
              gap: 2,
            }}
          >
            <TabsTrigger
              value={HOME_TAB}
              style={{ height: '100%', borderRadius: 6, padding: 0 }}
            >
              <span className="pdr-tabs__home" title={String(t(`${NS}.tab.homeTitle`))}>
                <AppIcon />
              </span>
            </TabsTrigger>
            {tabs.map((id) => {
              const p = plugins.find((x) => x.id === id)
              return (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="dui-tabs__tab"
                  style={{ height: '100%', borderRadius: 6, padding: '0 4px 0 8px' }}
                >
                  <span className="pdr-tabs__item">
                    <PluginIcon
                      className="pdr-tabs__badge"
                      pluginId={id}
                      icon={p?.icon}
                      name={localize(p?.name, id)}
                      size={15}
                      active={active === id}
                    />
                    <span className="pdr-tabs__name">{localize(p?.name, id)}</span>
                    <span
                      role="button"
                      aria-label={String(t(`${NS}.tab.closeTitle`))}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(id)
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        color: 'inherit',
                        cursor: 'pointer',
                        opacity: 0.8,
                      }}
                    >
                      <CloseIcon size={13} />
                    </span>
                  </span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
      </div>

      <div className="pdr-view">
        {active !== HOME_TAB && (
          <ActionBar
            view={view}
            onViewChange={(v) => setViewByTab((prev) => ({ ...prev, [active]: v }))}
            booting={booting}
            refreshing={refreshing || refreshingId === active}
            onRefresh={() => void refreshPlugin(active)}
            packing={packingId === active}
            onPack={() => void packPlugin(active)}
            aiOpen={aiOpen}
            onToggleAi={() => setAiOpen((prev) => !prev)}
          />
        )}
        {active === HOME_TAB ? (
          <Workbench
            plugins={plugins}
            loaded={loaded}
            runtimeOf={runtimeOf}
            onOpen={(id, v) => void openPlugin(id, v)}
            onRemove={(id) => void removePlugin(id)}
            onImport={() => void addDirectory()}
            onCreate={() => void createPlugin()}
            extra={
              <Button  variant="ghost" loading={refreshing} onClick={() => void refreshAll()}>
                <RefreshIcon />
                {t(`${NS}.common.refresh`)}
              </Button>
            }
          />
        ) : null}
        {/* 内容区：预览页与「日志 / 设置」页互斥显示，两个页面容器都常驻挂载（仅切显隐）→
            预览 PluginView 与内嵌 dsh Chat 都不重载。
            分栏（@dlient-open/ui Resizable）只属于**预览页**：左预览 + 右 AI（默认 220px，可拖）；
            日志 / 设置页是整宽页面，不带分栏。 */}
        <div className="pdr-pages" style={{ display: active === HOME_TAB ? 'none' : undefined }}>
          <div className={`pdr-preview-page${view === 'preview' ? '' : ' is-hidden'}`}>
            <ResizablePanelGroup orientation="horizontal" className="pdr-preview-page__group">
              <ResizablePanel className="pdr-preview-panel" minSize={320} style={{ overflow: 'hidden' }}>
                {tabs.map((id) => renderPreviewBodyFor(id))}
              </ResizablePanel>
              {/* 分隔条：AI 面板折叠（不可见）时一并隐藏，避免留下可拖拽的空手柄 */}
              <ResizableHandle withHandle className={`pdr-ai__handle${showAi ? '' : ' is-hidden'}`} />
              <ResizablePanel
                // 回调 ref：拿到命令式句柄控制展开/折叠（类型按结构子集声明，避免直接依赖底层库类型）
                panelRef={(h) => {
                  aiPanelRef.current = h
                }}
                className="pdr-ai"
                // 默认宽度 0 = 初始隐藏（AI 面板只在点「AI开发」按钮后展开，展开宽度 220px 起步）
                defaultSize={0}
                minSize={220}
                collapsible
                collapsedSize={0}
                // 拖拽时记住宽度（重新展开恢复）；拖到 0 视为关闭，同步按钮状态。
                // 注意：切到日志 / 设置页时整个预览页 display:none，也会量到 0——那种情况不能清开关状态，
                // 否则回到预览页 AI 面板就丢了。
                onResize={(size) => {
                  if (size.inPixels > 0) aiWidthRef.current = size.inPixels
                  else if (view === 'preview') setAiOpen((prev) => (prev ? false : prev))
                }}
                style={{ overflow: 'hidden' }}
              >
                {/* AI 面板：单实例常驻（避免每个 tab 各挂一份 → 多个 Chat webview）；显隐只经 dsh Chat 的
                    visible prop 控制其 WebContentsView（不卸载 → 不重载）。dsh 未安装/未就绪时 Chat 自渲染状态。
                    workspace 传当前预览的 dev 插件目录，让会话直接落在这个插件的代码上。 */}
                <PluginView
                  pluginId={aiPluginId}
                  entry="Chat"
                  componentProps={{ visible: showAi, workspace: aiWorkspace }}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
          {/* 日志 / 设置页：整宽页面（无分栏、无 AI 面板、无刷新按钮） */}
          <div className={`pdr-plain-page${view === 'preview' ? ' is-hidden' : ''}`}>
            {tabs.map((id) => renderOtherBodyFor(id))}
          </div>
        </div>
      </div>
    </div>
  )
}
