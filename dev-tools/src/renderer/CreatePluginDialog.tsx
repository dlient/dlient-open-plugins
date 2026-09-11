/**
 * 创建 dev 插件弹框（modal.dialog）。
 *
 * 新增插件：填写插件 ID + 插件名称 → 提交时经 worker dev-tools.devCreatePlugin 校验
 * 是否与插件市场（及本地）已存在插件重名；重复则弹框内提示「无法创建」并保持打开，
 * 用户可修改后重试。
 *
 * body / footer 渲染在 modal.dialog 的独立 React root，经 CreateDlgApi
 * （getSnapshot/subscribe + submit/cancel，与安装向导 WizardApi 同款模式）互通状态与操作。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, MessagePlugin, modal, useDlientApi, isApiOk, toApiError, type PluginApi } from '@dlient-open/ui'
import { useI18n } from '@dlient-open/i18n'
import './i18n'

const NS = 'dev-tools'

/** 创建弹框表单状态（footer 按钮可用性/文案依据） */
export interface CreateDlgState {
  id: string
  name: string
  /** 校验/提交错误（如市场重名），显示在表单下方 */
  error: string
  submitting: boolean
}

/** 创建弹框操作句柄（footer 经 getSnapshot/subscribe 订阅，submit/cancel 触发操作） */
export interface CreateDlgApi {
  getSnapshot: () => CreateDlgState
  subscribe: (cb: () => void) => () => void
  submit: () => Promise<boolean>
  cancel: () => void
}

const DEFAULT_STATE: CreateDlgState = { id: '', name: '', error: '', submitting: false }

/** 插件 ID 合法性：须以小写字母开头，仅含小写字母/数字/连字符 */
const ID_RE = /^[a-z][a-z0-9-]*$/

interface CreateFormProps {
  /** 创建成功回调（关闭弹框 + 刷新列表） */
  onCreated: (id: string) => void
  /** 取消回调（关闭弹框） */
  onClose: () => void
}

const CreatePluginForm = forwardRef<CreateDlgApi, CreateFormProps>(function CreatePluginForm(
  { onCreated, onClose },
  ref,
) {
  const api = useDlientApi()
  const { t } = useI18n()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 订阅器：状态变化推送给 footer（独立 React root）
  const stateRef = useRef<CreateDlgState>(DEFAULT_STATE)
  stateRef.current = { id, name, error, submitting }
  const listenersRef = useRef(new Set<() => void>())
  const notify = useCallback(() => listenersRef.current.forEach((l) => l()), [])
  useEffect(() => {
    notify()
  }, [id, name, error, submitting, notify])

  // submit 闭包内读取最新输入值
  const idRef = useRef(id)
  idRef.current = id
  const nameRef = useRef(name)
  nameRef.current = name

  const submit = useCallback(async (): Promise<boolean> => {
    const pid = idRef.current.trim()
    const pname = nameRef.current.trim()
    if (!ID_RE.test(pid)) {
      setError(String(t(`${NS}.create.idInvalid`)))
      return false
    }
    if (!pname) {
      setError(String(t(`${NS}.create.nameRequired`)))
      return false
    }
    setError('')
    setSubmitting(true)
    try {
      const res = await api.request<{ id?: string; name?: string } | null>('dev-tools.devCreatePlugin', [pid, pname])
      if (!isApiOk(res)) {
        const err = toApiError(res)
        // 市场/本地重名（-3011）→ 弹框内提示无法创建，保持打开可修改重试
        if (err.code === -3011) setError(err.message)
        else MessagePlugin.error(`${String(t(`${NS}.create.fail`))}：${err.message}`)
        return false
      }
      const created = res.data
      if (created?.id) {
        MessagePlugin.success(String(t(`${NS}.create.ok`, { name: pname })))
        onCreated(pid)
        return true
      }
      // 目录选择被取消：保持弹框，无错误
      return false
    } catch {
      MessagePlugin.error(String(t(`${NS}.create.unknown`)))
      return false
    } finally {
      setSubmitting(false)
    }
  }, [api, onCreated, t])

  const cancel = useCallback(() => onClose(), [onClose])

  useImperativeHandle(
    ref,
    () => ({
      getSnapshot: () => stateRef.current,
      subscribe: (cb: () => void) => {
        listenersRef.current.add(cb)
        return () => {
          listenersRef.current.delete(cb)
        }
      },
      submit,
      cancel,
    }),
    [submit, cancel],
  )

  return (
    <div className="pdr-cdlg__body" style={{padding: '10px 30px'}}>
      <label className="pdr-field">
        <span className="pdr-field__label">{String(t(`${NS}.create.id`))}</span>
        <Input
          value={id}
          placeholder={String(t(`${NS}.create.idPlaceholder`))}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <label className="pdr-field">
        <span className="pdr-field__label">{String(t(`${NS}.create.name`))}</span>
        <Input
          value={name}
          placeholder={String(t(`${NS}.create.namePlaceholder`))}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {error && <div className="pdr-cdlg__error">{error}</div>}
    </div>
  )
})

function CreateDialogHeader() {
  const { t } = useI18n()
  return (
    <div className="pdr-cdlg__head">
      <div className="pdr-cdlg__title">{String(t(`${NS}.create.title`))}</div>
      <div className="pdr-cdlg__desc">{String(t(`${NS}.create.sub`))}</div>
    </div>
  )
}

function CreatePluginFooter({
  formRef,
  instanceRef,
}: {
  formRef: { current: CreateDlgApi | null }
  instanceRef: { current: ReturnType<typeof modal.dialog> | null }
}) {
  const { t } = useI18n()
  // body 的 CreatePluginForm 挂载完成后 ref 才有值
  const [form, setForm] = useState<CreateDlgApi | null>(null)
  useEffect(() => {
    setForm(formRef.current)
  }, [formRef])

  const state = useSyncExternalStore(
    (cb) => (form ? form.subscribe(cb) : () => {}),
    () => (form ? form.getSnapshot() : DEFAULT_STATE),
  )

  return (
    <div className="pdr-cdlg__foot">
      <Button variant="outline" disabled={state.submitting} onClick={() => form?.cancel()}>
        {String(t(`${NS}.create.cancel`))}
      </Button>
      <Button
        variant="default"
        loading={state.submitting}
        onClick={() => {
          void form?.submit().then((ok) => {
            if (ok) instanceRef.current?.close()
          })
        }}
      >
        {String(t(`${NS}.create.submit`))}
      </Button>
    </div>
  )
}

export interface OpenCreatePluginDialogOptions {
  api: PluginApi
  /** 创建成功回调（刷新 dev 插件列表） */
  onCreated: (id: string) => void
}

export function openCreatePluginDialog({ api, onCreated }: OpenCreatePluginDialogOptions): void {
  const formRef: { current: CreateDlgApi | null } = { current: null }
  const instanceRef: { current: ReturnType<typeof modal.dialog> | null } = { current: null }

  const ins = modal.dialog({
    width: 460,
    placement: 'top',
    api,
    closeBtn: false,
    header: <CreateDialogHeader />,
    body: (
      <CreatePluginForm
        ref={formRef}
        onCreated={(pid) => {
          instanceRef.current?.close()
          onCreated(pid)
        }}
        onClose={() => instanceRef.current?.close()}
      />
    ),
    footer: <CreatePluginFooter formRef={formRef} instanceRef={instanceRef} />,
  })
  instanceRef.current = ins
}
