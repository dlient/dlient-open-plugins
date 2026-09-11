/**
 * Chat —— dsh chat 面（`dsh --profile dlient-chat`）的可嵌入组件（具名导出）。
 *
 * 供其它插件经 `<PluginView pluginId="dsh" entry="Chat" componentProps={{ workspace }} />` 内嵌：
 *   1. 挂载时请求 worker 启动 dsh chat 服务（worker 侧幂等 + 单飞，多消费方并发调用只安装/启动一次）；
 *   2. 就绪后用 Webview 内嵌 http://127.0.0.1:<port>[?workspace=<编码后的路径>]（webview:* 由 dsh worker 内建转发到主进程）。
 *
 * 与 App（dsh web）独立：两者可同时使用，进程与状态由 worker 分别持有。
 */

import { useEffect, useRef, useState } from 'react'
import { Button, Empty, Icon, Loading, Webview, isApiOk, resolveApiMsg, defaultApiErrorMsg, useDlientApi } from '@dlient-open/ui'
import { useI18n } from '@dlient-open/i18n'
import './styles.css'
import './i18n'
import { useDshAppearance } from './use-appearance'

const NS = 'dsh'

export interface ChatProps {
  /**
   * 启动时注册并打开的 workspace 目录：既作为 `--workspace` 传给 dsh（注册成真实 workspace group），
   * 也编码后拼进页面 URL（`?workspace=`）让客户端选中它。
   * 注意：在服务启动时生效；运行中变更需先 `dsh.chatStop` 再重新启动。
   */
  workspace?: string
  /**
   * 是否可见（默认 true）。供内嵌方「只隐藏不卸载」用：false 时把内嵌 Webview 交给宿主隐藏
   * （WebContentsView 从窗口层移除但 webContents 保持存活，不 reload），组件本身仍保持挂载。
   */
  visible?: boolean
}

interface ChatStatus {
  phase: 'idle' | 'preparing' | 'installing' | 'starting' | 'ready' | 'error'
  url?: string
  error?: string
  /** 是否启动过：stop 后为 true，用于区分「从未启动（自动启动）」与「已停止（不自动重启）」 */
  startedOnce?: boolean
}

export function Chat({ workspace, visible }: ChatProps) {
  const api = useDlientApi()
  const { t, locale } = useI18n()
  const [status, setStatus] = useState<ChatStatus>({ phase: 'idle' })
  const startingRef = useRef(false)
  /** 最近一次状态（visible 变化时判断「是否已就绪」用；不进 effect deps，避免无谓重跑） */
  const statusRef = useRef(status)
  statusRef.current = status

  // 宿主语言/主题 → dsh settings.yaml 同步（chat 页面同样读取该配置）。
  // visible=false（折叠）时不推外观、不监听，避免挂载即触发 settings.yaml 授权弹框。
  useDshAppearance(visible !== false)

  // 订阅 worker 推送的 chat 状态
  useEffect(() => {
    return api.onEvent('dsh.chatStatus', (data) => {
      if (data && typeof data === 'object' && 'phase' in (data as object)) {
        setStatus(data as ChatStatus)
      }
    })
  }, [api])

  const start = () => {
    if (startingRef.current) return
    startingRef.current = true
    // 保留已有 url（仅切阶段）：就绪时重复 chatStart 是幂等的，但若把 url 丢掉，
    // 内嵌 <Webview> 会被卸载、就绪后再重建 → 每次展开分栏都重新加载 chat 页面。
    setStatus((prev) => ({ ...prev, phase: 'preparing' }))
    void api
      .request<{ ok: boolean; url?: string; error?: string }>('dsh.chatStart', [{ workspace }])
      .then((res) => {
        const d = res?.data
        if (isApiOk(res) && d?.ok && d.url) setStatus({ phase: 'ready', url: d.url })
        else
          setStatus({
            phase: 'error',
            error:
              d?.error ?? resolveApiMsg(res?.msg, locale) ?? defaultApiErrorMsg(res?.code, locale) ?? t(`${NS}.chatFailed`),
          })
      })
      .catch((err) => setStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        startingRef.current = false
      })
  }

  // 挂载/展开时：查 worker 当前状态 —— 已停止过（startedOnce）则不自动重启，显示「已停止」；
  // 首次挂载（idle 且未启动过）自动启动；查询超时（3s）/ 失败时兜底直接启动（避免「无反应」）。
  // 折叠（visible === false）时不启动：内嵌方（如 dev-tools 预览）折叠 AI 分栏时组件仍挂载，
  // 不应触发 dsh 启动与授权弹框；展开（visible 变 true）时才自动启动。
  // 已启动的进程保持存活：worker 侧 chatStart 幂等，重复调用直接返回当前状态，不会重复安装/重启。
  // 已就绪（有 url）时整段短路：内嵌方反复「折叠 / 展开」分栏只应切可见性，
  // 走到 start() 会把渲染态打回 preparing → <Webview> 卸载重建 → 每次都重新加载 chat 页面。
  useEffect(() => {
    if (visible === false) return
    if (statusRef.current.url) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled) start()
    }, 3000)
    void api
      .request<ChatStatus>('dsh.chatStatus')
      .then((s) => {
        if (cancelled) return
        window.clearTimeout(timer)
        const d = s?.data
        if (isApiOk(s) && d?.phase === 'idle' && d.startedOnce) return
        start()
      })
      .catch(() => {
        if (cancelled) return
        window.clearTimeout(timer)
        start()
      })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  return (
    <div className="dsh-root">
      {/* 有 url 即服务在线（worker 仅在 ready 时推 url，idle/error 会清掉）：
          不按 phase 渲染，避免瞬态（如 preparing）把 <Webview> 卸载重建 → chat 页面重新加载 */}
      {status.url ? (
        <div className="dsh-body">
          <Webview src={status.url} visible={visible !== false} />
        </div>
      ) : (
        <div className="dsh-empty">
          {status.phase === 'error' ? (
            <Empty
              title={t(`${NS}.chatError`)}
              description={status.error}
              action={
                <Button variant="default" onClick={start}>
                  <Icon name="refresh" />
                  {t(`${NS}.retry`)}
                </Button>
              }
            />
          ) : status.phase === 'idle' ? (
            <Empty
              title={t(`${NS}.statusIdle`)}
              description={t(`${NS}.idleHint`)}
              action={
                <Button variant="default" onClick={start}>
                  <Icon name="refresh" />
                  {t(`${NS}.retry`)}
                </Button>
              }
            />
          ) : (
            <>
              <Loading loading text={chatPhaseText(status.phase, t)} />
              <p className="dsh-empty-sub">{chatPhaseHint(status.phase, t)}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 启动中的阶段标题 */
function chatPhaseText(phase: string, t: (key: string) => string): string {
  if (phase === 'preparing') return t(`${NS}.chatPreparing`)
  if (phase === 'installing') return t(`${NS}.chatInstalling`)
  return t(`${NS}.statusStarting`)
}

/** 启动中的阶段说明（安装首次可能较慢） */
function chatPhaseHint(phase: string, t: (key: string) => string): string {
  if (phase === 'preparing') return t(`${NS}.chatHintPreparing`)
  if (phase === 'installing') return t(`${NS}.chatHintInstalling`)
  return t(`${NS}.chatHintStarting`)
}
