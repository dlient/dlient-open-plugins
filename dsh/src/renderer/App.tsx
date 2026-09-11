/**
 * dsh 主界面（src/renderer/App.tsx）。
 * 启动 DSH web 服务（worker），就绪后用 webview 插件（Webview 组件）内嵌 http://127.0.0.1:<port>。
 *
 * 同时是插件 UI 入口模块：具名导出 Chat（dsh chat 面）供其它插件经
 * `<PluginView pluginId="dsh" entry="Chat" />` 内嵌。
 */

import { useEffect, useRef, useState } from 'react'
import { Button, Empty, Icon, Loading, useDlientApi, Webview, isApiOk, resolveApiMsg, defaultApiErrorMsg } from '@dlient-open/ui'
import { useI18n } from '@dlient-open/i18n'
import './styles.css'
import './i18n'
import { useDshAppearance } from './use-appearance'

export { Chat } from './Chat'

const NS = 'dsh'

interface DshStatus {
  phase: 'idle' | 'checking-node' | 'installing-dsh' | 'starting' | 'ready' | 'error'
  url?: string
  error?: string
  /** 是否启动过：stop 后为 true，用于区分「从未启动（自动启动）」与「已停止（不自动重启）」 */
  startedOnce?: boolean
}

export default function App() {
  const api = useDlientApi()
  const { t, locale } = useI18n()
  const [status, setStatus] = useState<DshStatus>({ phase: 'idle' })
  const startingRef = useRef(false)

  // 宿主语言/主题 → dsh settings.yaml 同步（worker 写文件，dsh 页面自动刷新）
  useDshAppearance()

  // 订阅 worker 推送的状态
  useEffect(() => {
    return api.onEvent('dsh.status', (data) => {
      if (data && typeof data === 'object' && 'phase' in (data as object)) {
        setStatus(data as DshStatus)
      }
    })
  }, [api])

  const start = () => {
    if (startingRef.current) return
    startingRef.current = true
    setStatus({ phase: 'starting' })
    void api
      .request<{ ok: boolean; url?: string; error?: string }>('dsh.start')
      .then((res) => {
        const d = res?.data
        if (isApiOk(res) && d?.ok && d.url) setStatus({ phase: 'ready', url: d.url })
        else
          setStatus({
            phase: 'error',
            error:
              d?.error ?? resolveApiMsg(res?.msg, locale) ?? defaultApiErrorMsg(res?.code, locale) ?? t(`${NS}.startFailed`),
          })
      })
      .catch((err) => setStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        startingRef.current = false
      })
  }

  // 挂载时：查 worker 当前状态 —— 若已停止过（startedOnce）则不自动重启，显示「已停止」；
  // 首次打开（idle 且未启动过）自动启动 dsh web 服务；
  // 查询超时（3s）/ 失败时兜底直接启动（与旧行为一致，避免「无反应」）
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled) start()
    }, 3000)
    void api
      .request<DshStatus>('dsh.status')
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
  }, [])

  return (
    <div className="dsh-root">
      {status.phase === 'ready' && status.url ? (
        <div className="dsh-body">
          <Webview src={status.url} />
        </div>
      ) : (
        <div className="dsh-empty">
          {status.phase === 'error' ? (
            <Empty
              title={t(`${NS}.error`)}
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
              <Loading loading text={statusText(status, t)} />
              <p className="dsh-empty-sub">{phaseHint(status.phase, t)}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 状态栏文案（随 phase 变化） */
function statusText(s: DshStatus, t: (key: string) => string): string {
  switch (s.phase) {
    case 'ready': return t(`${NS}.statusReady`)
    case 'checking-node': return t(`${NS}.statusNode`)
    case 'installing-dsh': return t(`${NS}.statusInstall`)
    case 'starting': return t(`${NS}.statusStarting`)
    case 'error': return t(`${NS}.statusError`)
    default: return t(`${NS}.statusIdle`)
  }
}

/** 空态提示（启动中的阶段说明） */
function phaseHint(phase: string, t: (key: string) => string): string {
  if (phase === 'installing-dsh') return t(`${NS}.hintInstall`)
  if (phase === 'checking-node') return t(`${NS}.hintNode`)
  return t(`${NS}.hintStarting`)
}
