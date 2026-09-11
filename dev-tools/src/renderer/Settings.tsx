/**
 * 插件设置：左侧导航 + 右侧内容区。
 *
 * 左侧导航：插件设置 / 插件介绍 / 多语言设置（英文、中文）。
 * 右侧内容区（每个区域独立保存/重置，底部无全局操作栏）：
 *  - 插件设置：插件 ID / 插件名称 / 插件简介 / 插件图标（图片上传）/ 插件类型（自定义卡片单选）/ 适用平台（多选 + CPU 架构）。
 *  - 插件介绍：MarkdownEditor 编辑 assets/index.md（支持主题与多语言）。
 *  - 多语言设置 > 英文 / 中文：标题 + 副标题 + 「使用默认设置」按钮 + 名称 / 简介 / 介绍（MarkdownEditor）。
 *
 * 写回：
 *  - 插件设置区：package.json dlient 全字段 → dev-tools.writeSettings。
 *  - 插件介绍区：index.md → dev-tools.writeMarkdown。
 *  - 多语言区：package.json dlient.name/description 对应语言字段 → dev-tools.writeSettings
 *             + 对应语言 markdown → dev-tools.writeMarkdown。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Input,
  Loading,
  MessagePlugin,
  Textarea,
  useDlientApi,
  isApiOk,
  toApiError,
} from '@dlient-open/ui'
import { useI18n } from '@dlient-open/i18n'
import {
  ARCH_OPTIONS,
  PLATFORM_OPTIONS,
  TYPE_OPTIONS,
  buildLocalized3,
  localeValue,
  type SettingsPayload,
} from './types'
import { MarkdownEditor } from './MarkdownEditor'
import './i18n'

const NS = 'dev-tools'

/** 侧边导航项 */
type NavKey = 'settings' | 'intro' | 'locale-en' | 'locale-zh'

/** 表单模型：把 manifest 多语言字段摊平成可控输入 */
interface FormState {
  /** 默认（插件设置页编辑） */
  nameDefault: string
  descDefault: string
  /** 中文（多语言页编辑） */
  nameZh: string
  descZh: string
  /** 英文（多语言页编辑） */
  nameEn: string
  descEn: string
  /** 类型与平台 */
  type: string
  /** 平台 + 架构组合值（win32.x64 / darwin.arm64 等） */
  platforms: string[]
  tags: string
  /** 图标相对路径（assets/icon.svg 或 assets/icon.png） */
  iconStr: string
}

const EMPTY_FORM: FormState = {
  nameDefault: '',
  descDefault: '',
  nameZh: '',
  descZh: '',
  nameEn: '',
  descEn: '',
  type: 'full',
  platforms: [],
  tags: '',
  iconStr: '',
}

/** markdown 文件名 → 缓冲键 */
const MD_FILES = ['index.md', 'index.zh-CN.md', 'index.en-US.md'] as const
type MdKey = (typeof MD_FILES)[number]

/** 从 icon 字段取展示/写入用的相对路径（字符串原样；对象取 light，缺省取首个非空值） */
function iconPathOf(icon: string | Record<string, string> | undefined): string {
  if (!icon) return ''
  if (typeof icon === 'string') return icon
  return icon.light ?? Object.values(icon).find((v) => typeof v === 'string' && v) ?? ''
}

/** 平台 + 架构 → 组合值（win32 + x64 → 'win32.x64'） */
function combinedValue(platform: string, arch: string): string {
  return `${platform}.${arch}`
}

function toForm(p: SettingsPayload): FormState {
  const d = p.dlient
  const name = d.name
  const desc = d.description
  return {
    nameDefault:
      localeValue(name, 'default') || (typeof name === 'string' ? name : ''),
    descDefault:
      localeValue(desc, 'default') || (typeof desc === 'string' ? desc : ''),
    nameZh: localeValue(name, 'zh-CN'),
    descZh: localeValue(desc, 'zh-CN'),
    nameEn: localeValue(name, 'en-US'),
    descEn: localeValue(desc, 'en-US'),
    type: d.type ?? 'full',
    platforms: Array.isArray(d.platforms) ? d.platforms : [],
    tags: Array.isArray(d.tags) ? d.tags.join(', ') : '',
    iconStr: iconPathOf(d.icon),
  }
}

/** 表单 → writeSettings 的全字段 patch */
function toPatch(
  f: FormState,
  originalIcon?: string | Record<string, string>,
): Record<string, unknown> {
  const tags = f.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  // 图标：未改动时保留原始形态（对象/字符串）；改动（上传）时写字符串路径
  const iconPath = f.iconStr.trim()
  let icon: string | Record<string, string> | undefined
  if (iconPath) {
    icon =
      originalIcon &&
      typeof originalIcon !== 'string' &&
      iconPathOf(originalIcon) === iconPath
        ? originalIcon
        : iconPath
  }
  return {
    name: buildLocalized3(f.nameDefault, f.nameZh, f.nameEn),
    description: buildLocalized3(f.descDefault, f.descZh, f.descEn),
    type: f.type || undefined,
    platforms: f.platforms.length > 0 ? f.platforms : undefined,
    tags: tags.length > 0 ? tags : undefined,
    icon,
  }
}

/** 仅 name/description 的 patch（多语言区保存用） */
function toLocalePatch(f: FormState): Record<string, unknown> {
  return {
    name: buildLocalized3(f.nameDefault, f.nameZh, f.nameEn),
    description: buildLocalized3(f.descDefault, f.descZh, f.descEn),
  }
}

export interface SettingsProps {
  pluginId: string
  /** 保存成功且确有变更时回调（外层据此刷新列表） */
  onSaved?: () => void
}

/** 图标上传约束 */
const MAX_ICON_BYTES = 200 * 1024
const ICON_ACCEPT = '.svg,.png'

/** 取文件扩展名（小写，无点） */
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 文件 → base64（去掉 dataURL 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(new Error('set.imgUnreadable'))
    r.readAsDataURL(file)
  })
}

/** PNG：校验正方形并压缩为 64×64，返回 base64 */
function compressPng64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      if (img.naturalWidth !== img.naturalHeight) {
        reject(new Error('set.pngNotSquare'))
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('set.imgProcessFail'))
        return
      }
      ctx.drawImage(img, 0, 0, 64, 64)
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('set.imgCompressFail'))
            return
          }
          fileToBase64(blob as File)
            .then(resolve)
            .catch(() => reject(new Error('set.imgCompressFail')))
        },
        'image/png',
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('set.imgUnreadable'))
    }
    img.src = url
  })
}

/** 校验 SVG 内容是否安全合规 */
function validateSvg(text: string): string | null {
  const low = text.toLowerCase()
  if (!text.trim()) return 'set.svgEmpty'
  // <!DOCTYPE svg PUBLIC "..." 是标准 SVG 声明，允许通过；
  // <!ENTITY 是 XXE 攻击向量，必须拦截。
  // DOCTYPE + SYSTEM 引用也是 XXE 向量，单独拦截。
  if (/<!ENTITY|<!DOCTYPE[^>]*\bSYSTEM\b/i.test(low)) {
    return 'set.svgUnsafe'
  }
  if (/<script|<foreignObject|<iframe|<object|<embed|<link\b|<meta\b/i.test(low)) {
    return 'set.svgUnsafe'
  }
  if (/\son[a-z]+\s*=/i.test(text)) return 'set.svgUnsafe'
  if (/javascript\s*:/i.test(low)) return 'set.svgUnsafe'
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const root = doc.documentElement
    if (
      !root ||
      root.nodeName.toLowerCase() !== 'svg' ||
      doc.querySelector('parsererror')
    )
      return 'set.svgInvalid'
    for (const el of Array.from(doc.querySelectorAll('image, use, feImage'))) {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || ''
      if (/^(https?:)?\/\//i.test(href)) return 'set.svgExternal'
    }
  } catch {
    return 'set.svgInvalid'
  }
  return null
}

async function handleSvgUpload(file: File): Promise<string> {
  const text = await file.text()
  const errKey = validateSvg(text)
  if (errKey) throw new Error(errKey)
  return fileToBase64(file)
}

/** 各区域保存状态 */
interface SavingState {
  settings: boolean
  intro: boolean
  'locale-en': boolean
  'locale-zh': boolean
}

export function Settings({ pluginId, onSaved }: SettingsProps) {
  const api = useDlientApi()
  const { t, locale } = useI18n()
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [nav, setNav] = useState<NavKey>('settings')
  const [saving, setSaving] = useState<SavingState>({
    settings: false,
    intro: false,
    'locale-en': false,
    'locale-zh': false,
  })

  // 图标经 dlientopen:// 协议加载（dev 插件 assets/ 目录），URL 直接由 iconStr 派生；
  // 路径形如 assets/icon.svg → dlientopen://plugin/<id>/assets/icon.svg
  const iconUrl = form.iconStr
    ? `dlientopen://plugin/${pluginId}/${form.iconStr.replace(/^\/+/, '')}`
    : ''

  // markdown 缓冲：内容 / 基线（脏检测）/ 加载态
  const [md, setMd] = useState<Record<MdKey, string>>({
    'index.md': '',
    'index.zh-CN.md': '',
    'index.en-US.md': '',
  })
  const [mdBaseline, setMdBaseline] = useState<Record<MdKey, string>>({
    'index.md': '',
    'index.zh-CN.md': '',
    'index.en-US.md': '',
  })
  const [mdLoaded, setMdLoaded] = useState<Record<MdKey, boolean>>({
    'index.md': false,
    'index.zh-CN.md': false,
    'index.en-US.md': false,
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const res = await api.request<SettingsPayload>('dev-tools.readSettings', [
      pluginId,
    ])
    if (!isApiOk(res) || !res.data) {
      setError(isApiOk(res) ? String(t(`${NS}.set.readFail`)) : toApiError(res).message)
      setLoading(false)
      return
    }
    setPayload(res.data)
    setForm(toForm(res.data))
    setLoading(false)
  }, [api, pluginId, t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  // 懒加载 markdown 文件（仅在首次访问对应页时加载）
  const ensureMd = useCallback(
    async (key: MdKey) => {
      if (mdLoaded[key]) return
      const res = await api.request<{ content: string; exists: boolean }>(
        'dev-tools.readMarkdown',
        [pluginId, key],
      )
      if (!isApiOk(res)) return
      const content = res.data?.content ?? ''
      setMd((prev) => ({ ...prev, [key]: content }))
      setMdBaseline((prev) => ({ ...prev, [key]: content }))
      setMdLoaded((prev) => ({ ...prev, [key]: true }))
    },
    [api, pluginId, mdLoaded],
  )

  // 切到 intro / locale-* 时懒加载对应 md
  useEffect(() => {
    if (nav === 'intro') void ensureMd('index.md')
    else if (nav === 'locale-en') void ensureMd('index.en-US.md')
    else if (nav === 'locale-zh') void ensureMd('index.zh-CN.md')
  }, [nav, ensureMd])

  const baseline = useMemo(
    () => (payload ? toForm(payload) : EMPTY_FORM),
    [payload],
  )

  // —— 各区域脏检测 ——
  const settingsDirty = useMemo(
    () =>
      form.nameDefault !== baseline.nameDefault ||
      form.descDefault !== baseline.descDefault ||
      form.type !== baseline.type ||
      form.tags !== baseline.tags ||
      form.iconStr !== baseline.iconStr ||
      JSON.stringify(form.platforms) !== JSON.stringify(baseline.platforms),
    [form, baseline],
  )
  const introDirty = useMemo(
    () => md['index.md'] !== mdBaseline['index.md'],
    [md, mdBaseline],
  )
  const localeEnDirty = useMemo(
    () =>
      form.nameEn !== baseline.nameEn ||
      form.descEn !== baseline.descEn ||
      md['index.en-US.md'] !== mdBaseline['index.en-US.md'],
    [form, baseline, md, mdBaseline],
  )
  const localeZhDirty = useMemo(
    () =>
      form.nameZh !== baseline.nameZh ||
      form.descZh !== baseline.descZh ||
      md['index.zh-CN.md'] !== mdBaseline['index.zh-CN.md'],
    [form, baseline, md, mdBaseline],
  )

  const patch = (next: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...next }))

  // —— 图标上传 ——
  const handleIconUpload = async (file: File) => {
    const ext = extOf(file.name)
    if (ext !== 'svg' && ext !== 'png') {
      MessagePlugin.error(String(t(`${NS}.set.uploadOnlySvgPng`)))
      return
    }
    if (file.size > MAX_ICON_BYTES) {
      MessagePlugin.error(String(t(`${NS}.set.uploadTooLarge`)))
      return
    }
    try {
      const base64 = ext === 'svg' ? await handleSvgUpload(file) : await compressPng64(file)
      const fileName = `icon.${ext}`
      const res = await api.request<{ ok?: boolean; path?: string }>(
        'dev-tools.writeAsset',
        [pluginId, fileName, base64],
      )
      if (!isApiOk(res) || !res.data?.ok) {
        MessagePlugin.error(
          `${t(`${NS}.set.uploadFail`)}：${isApiOk(res) ? t(`${NS}.set.uploadUnknown`) : toApiError(res).message}`,
        )
        return
      }
      const path = res.data.path ?? `assets/${fileName}`
      patch({ iconStr: path })
      MessagePlugin.success(String(t(`${NS}.set.uploadOk`)))
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      const reason = /^set\./.test(code) ? t(`${NS}.${code}`) : t(`${NS}.set.uploadUnknown`)
      MessagePlugin.error(`${t(`${NS}.set.uploadFail`)}：${reason}`)
    }
  }

  // —— 保存：插件设置区（package.json 全字段） ——
  const saveSettings = useCallback(async () => {
    setSaving((s) => ({ ...s, settings: true }))
    const res = await api.request<{ ok?: boolean; changed?: boolean }>(
      'dev-tools.writeSettings',
      [pluginId, toPatch(form, payload?.dlient.icon)],
    )
    setSaving((s) => ({ ...s, settings: false }))
    if (!isApiOk(res)) {
      MessagePlugin.error(`${t(`${NS}.set.saveFail`)}：${toApiError(res).message}`)
      return
    }
    if (res.data?.changed) {
      MessagePlugin.success(String(t(`${NS}.set.saveOk`)))
      onSaved?.()
    } else {
      MessagePlugin.info(String(t(`${NS}.set.noChange`)))
    }
    await load()
  }, [api, form, load, onSaved, payload, pluginId, t])

  // —— 保存：插件介绍区（index.md） ——
  const saveIntro = useCallback(async () => {
    setSaving((s) => ({ ...s, intro: true }))
    const res = await api.request<{ ok?: boolean }>('dev-tools.writeMarkdown', [
      pluginId,
      'index.md',
      md['index.md'],
    ])
    setSaving((s) => ({ ...s, intro: false }))
    if (!isApiOk(res)) {
      MessagePlugin.error(`${t(`${NS}.set.saveFail`)}：${toApiError(res).message}`)
      return
    }
    setMdBaseline((prev) => ({ ...prev, 'index.md': md['index.md'] }))
    MessagePlugin.success(String(t(`${NS}.set.saveMdOk`)))
  }, [api, md, pluginId, t])

  // —— 保存：多语言区（package.json name/description + 对应语言 markdown） ——
  const saveLocale = useCallback(
    async (localeKey: 'en' | 'zh') => {
      const navKey = localeKey === 'en' ? 'locale-en' : 'locale-zh'
      const mdKey = localeKey === 'en' ? 'index.en-US.md' : 'index.zh-CN.md'
      setSaving((s) => ({ ...s, [navKey]: true }))

      // 1. 保存 package.json 的 name/description
      const resSettings = await api.request<{ ok?: boolean; changed?: boolean }>(
        'dev-tools.writeSettings',
        [pluginId, toLocalePatch(form)],
      )
      // 2. 保存对应语言的 markdown
      const resMd = await api.request<{ ok?: boolean }>(
        'dev-tools.writeMarkdown',
        [pluginId, mdKey, md[mdKey]],
      )
      setSaving((s) => ({ ...s, [navKey]: false }))

      if (!isApiOk(resSettings)) {
        MessagePlugin.error(`${t(`${NS}.set.saveFail`)}：${toApiError(resSettings).message}`)
        return
      }
      if (!isApiOk(resMd)) {
        MessagePlugin.error(`${t(`${NS}.set.saveFail`)}：${toApiError(resMd).message}`)
        return
      }
      setMdBaseline((prev) => ({ ...prev, [mdKey]: md[mdKey] }))
      MessagePlugin.success(String(t(`${NS}.set.saveOk`)))
      // 刷新 baseline（name/description 可能变化）
      await load()
    },
    [api, form, md, load, pluginId, t],
  )

  // —— 重置：插件设置区 ——
  const resetSettings = () => setForm(baseline)

  // —— 重置：插件介绍区 ——
  const resetIntro = () =>
    setMd((prev) => ({ ...prev, 'index.md': mdBaseline['index.md'] }))

  // —— 重置：多语言区 ——
  const resetLocale = (localeKey: 'en' | 'zh') => {
    const mdKey = localeKey === 'en' ? 'index.en-US.md' : 'index.zh-CN.md'
    if (localeKey === 'en') {
      setForm((prev) => ({ ...prev, nameEn: baseline.nameEn, descEn: baseline.descEn }))
    } else {
      setForm((prev) => ({ ...prev, nameZh: baseline.nameZh, descZh: baseline.descZh }))
    }
    setMd((prev) => ({ ...prev, [mdKey]: mdBaseline[mdKey] }))
  }

  // —— 使用默认设置：把默认值复制到当前语言（含 markdown） ——
  const useDefaultForLocale = useCallback(
    async (localeKey: 'en' | 'zh') => {
      // 确保 index.md 已加载
      await ensureMd('index.md')
      const mdSrc = md['index.md'] || mdBaseline['index.md']
      if (localeKey === 'en') {
        patch({ nameEn: form.nameDefault, descEn: form.descDefault })
        setMd((prev) => ({ ...prev, 'index.en-US.md': mdSrc }))
      } else {
        patch({ nameZh: form.nameDefault, descZh: form.descDefault })
        setMd((prev) => ({ ...prev, 'index.zh-CN.md': mdSrc }))
      }
    },
    [form.nameDefault, form.descDefault, md, mdBaseline, ensureMd],
  )

  if (loading) {
    return (
      <div className="pdr-set__state">
        <Loading text={t(`${NS}.set.reading`)} />
      </div>
    )
  }
  if (error) {
    return (
      <div className="pdr-set__state">
        <div className="pdr-set__error">{error}</div>
        <Button variant="outline" onClick={() => void load()}>
          {t(`${NS}.set.retry`)}
        </Button>
      </div>
    )
  }

  return (
    <div className="pdr-set">
      {/* 左侧导航 */}
      <aside className="pdr-set__sidebar">
        <button
          type="button"
          className={`pdr-set__navitem${nav === 'settings' ? ' is-active' : ''}`}
          onClick={() => setNav('settings')}
        >
          {t(`${NS}.nav.settings`)}
        </button>
        <button
          type="button"
          className={`pdr-set__navitem${nav === 'intro' ? ' is-active' : ''}`}
          onClick={() => setNav('intro')}
        >
          {t(`${NS}.nav.intro`)}
        </button>
        <div className="pdr-set__navgroup">
          <div className="pdr-set__navgrouptitle">{t(`${NS}.nav.locale`)}</div>
          <button
            type="button"
            className={`pdr-set__navitem pdr-set__navitem--sub${nav === 'locale-en' ? ' is-active' : ''}`}
            onClick={() => setNav('locale-en')}
          >
            {t(`${NS}.nav.localeEn`)}
          </button>
          <button
            type="button"
            className={`pdr-set__navitem pdr-set__navitem--sub${nav === 'locale-zh' ? ' is-active' : ''}`}
            onClick={() => setNav('locale-zh')}
          >
            {t(`${NS}.nav.localeZh`)}
          </button>
        </div>
      </aside>

      {/* 右侧内容区 */}
      <div className="pdr-set__content">
        {nav === 'settings' && (
          <PluginSettingsView
            form={form}
            payload={payload}
            iconUrl={iconUrl}
            patch={patch}
            onIconUpload={(f) => void handleIconUpload(f)}
            dirty={settingsDirty}
            saving={saving.settings}
            onSave={() => void saveSettings()}
            onReset={resetSettings}
            t={t}
          />
        )}
        {nav === 'intro' && (
          <IntroView
            value={md['index.md']}
            loaded={mdLoaded['index.md']}
            saving={saving.intro}
            dirty={introDirty}
            onChange={(v) => setMd((prev) => ({ ...prev, 'index.md': v }))}
            onSave={() => void saveIntro()}
            onReset={resetIntro}
            locale={locale === 'en-US' ? 'en-US' : 'zh-CN'}
            t={t}
          />
        )}
        {nav === 'locale-en' && (
          <LocaleView
            localeKey="en"
            name={form.nameEn}
            desc={form.descEn}
            mdValue={md['index.en-US.md']}
            mdLoaded={mdLoaded['index.en-US.md']}
            dirty={localeEnDirty}
            saving={saving['locale-en']}
            onNameChange={(v) => patch({ nameEn: v })}
            onDescChange={(v) => patch({ descEn: v })}
            onMdChange={(v) =>
              setMd((prev) => ({ ...prev, 'index.en-US.md': v }))
            }
            onSave={() => void saveLocale('en')}
            onReset={() => resetLocale('en')}
            onUseDefault={() => void useDefaultForLocale('en')}
            editorLocale="en-US"
            t={t}
          />
        )}
        {nav === 'locale-zh' && (
          <LocaleView
            localeKey="zh"
            name={form.nameZh}
            desc={form.descZh}
            mdValue={md['index.zh-CN.md']}
            mdLoaded={mdLoaded['index.zh-CN.md']}
            dirty={localeZhDirty}
            saving={saving['locale-zh']}
            onNameChange={(v) => patch({ nameZh: v })}
            onDescChange={(v) => patch({ descZh: v })}
            onMdChange={(v) =>
              setMd((prev) => ({ ...prev, 'index.zh-CN.md': v }))
            }
            onSave={() => void saveLocale('zh')}
            onReset={() => resetLocale('zh')}
            onUseDefault={() => void useDefaultForLocale('zh')}
            editorLocale="zh-CN"
            t={t}
          />
        )}
      </div>
    </div>
  )
}

// ============================================================
// 区域底部操作栏（保存 + 重置）
// ============================================================

interface AreaFooterProps {
  dirty: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
  saveLabel: ReactNode
  resetLabel: ReactNode
  t: (key: string, ...args: unknown[]) => ReactNode
}

function AreaFooter({ dirty, saving, onSave, onReset, saveLabel, resetLabel }: AreaFooterProps) {
  return (
    <div className="pdr-set__areafoot">
      <Button
        variant="outline"
        size="lg"
        disabled={!dirty || saving}
        onClick={onReset}
      >
        {resetLabel}
      </Button>
      <Button
        size="lg"
        variant="default"
        loading={saving}
        disabled={!dirty}
        onClick={onSave}
      >
        {saveLabel}
      </Button>
    </div>
  )
}

// ============================================================
// 子组件：插件设置视图
// ============================================================

interface PluginSettingsViewProps {
  form: FormState
  payload: SettingsPayload | null
  iconUrl: string
  patch: (next: Partial<FormState>) => void
  onIconUpload: (file: File) => void
  dirty: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
  t: (key: string, ...args: unknown[]) => ReactNode
}

function PluginSettingsView({
  form,
  payload,
  iconUrl,
  patch,
  onIconUpload,
  dirty,
  saving,
  onSave,
  onReset,
  t,
}: PluginSettingsViewProps) {
  const iconInputRef = useRef<HTMLInputElement>(null)

  const toggleType = (value: string) => {
    patch({ type: form.type === value ? '' : value })
  }

  // 点击 x64/arm64 标签：在 platforms 中增删组合值（win32.x64 / darwin.arm64 等）
  const toggleArch = (platform: string, arch: string) => {
    const combo = combinedValue(platform, arch)
    const has = form.platforms.includes(combo)
    patch({
      platforms: has
        ? form.platforms.filter((p) => p !== combo)
        : [...form.platforms, combo],
    })
  }

  return (
    <div className="pdr-set__panel">
      <div className="pdr-set__head">
        <div className="pdr-set__title">{t(`${NS}.nav.settings`)}</div>
        <div className="pdr-set__sub">
          {t(`${NS}.set.sub`, { dir: payload?.dir ?? '' })}
        </div>
      </div>

      <section className="pdr-set__group">
        <label className="pdr-field">
          <span className="pdr-field__label">{t(`${NS}.set.pluginName`)}</span>
          <Input
            value={form.nameDefault}
            onChange={(e) => patch({ nameDefault: e.target.value })}
          />
        </label>
        <label className="pdr-field">
          <span className="pdr-field__label">{t(`${NS}.set.pluginDesc`)}</span>
          <Textarea
            className="dui-textarea"
            value={form.descDefault}
            rows={2}
            onChange={(e) => patch({ descDefault: e.target.value })}
          />
        </label>

        <div className="pdr-field">
          <span className="pdr-field__labelline">
            <span className="pdr-field__label">{t(`${NS}.set.pluginIcon`)}</span>
            <span className="pdr-field__hint">{t(`${NS}.set.iconHint`)}</span>
          </span>
          <input
            ref={iconInputRef}
            type="file"
            accept={ICON_ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onIconUpload(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className="pdr-set__iconpicker"
            onClick={() => iconInputRef.current?.click()}
            title={String(t(`${NS}.set.iconClickToUpload`))}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="icon" className="pdr-set__iconimg" />
            ) : (
              <span className="pdr-set__iconempty">
                {t(`${NS}.set.iconNoIcon`)}
              </span>
            )}
          </button>
        </div>
      </section>

      <section className="pdr-set__group">
        <div className="pdr-set__grouptitle">{t(`${NS}.set.pluginType`)}</div>
        <div className="pdr-set__typecards">
          {TYPE_OPTIONS.map((o) => {
            const active = form.type === o.value
            return (
              <button
                key={o.value}
                type="button"
                className={`pdr-set__typecard${active ? ' is-active' : ''}`}
                onClick={() => toggleType(o.value)}
              >
                <span className="pdr-set__typename">{t(`${NS}.${o.labelKey}`)}</span>
                <span className="pdr-set__typedesc">
                  {t(`${NS}.${o.descKey}`)}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="pdr-set__group">
        <div className="pdr-set__grouptitle">{t(`${NS}.set.platform`)}</div>
        <div className="pdr-set__platformgrid">
          {PLATFORM_OPTIONS.map((o) => {
            const activeCount = ARCH_OPTIONS.filter((a) =>
              form.platforms.includes(combinedValue(o.value, a.value)),
            ).length
            return (
              <div
                key={o.value}
                className={`pdr-set__platformcol${activeCount > 0 ? ' is-active' : ''}`}
              >
                <span
                  className="pdr-set__platformicon"
                  dangerouslySetInnerHTML={{ __html: o.icon }}
                />
                <span className="pdr-set__platformname">{o.label}</span>
                <div className="pdr-set__archrow">
                  {ARCH_OPTIONS.map((a) => {
                    const on = form.platforms.includes(
                      combinedValue(o.value, a.value),
                    )
                    return (
                      <button
                        key={a.value}
                        type="button"
                        className={`pdr-set__archchip${on ? ' is-on' : ''}`}
                        onClick={() => toggleArch(o.value, a.value)}
                      >
                        {a.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        <div className="pdr-field__hint">{t(`${NS}.set.platformHint`)}</div>
      </section>

      <AreaFooter
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onReset={onReset}
        saveLabel={t(`${NS}.common.save`)}
        resetLabel={t(`${NS}.common.reset`)}
        t={t}
      />
    </div>
  )
}

// ============================================================
// 子组件：插件介绍视图（MarkdownEditor 编辑 index.md）
// ============================================================

interface IntroViewProps {
  value: string
  loaded: boolean
  saving: boolean
  dirty: boolean
  onChange: (v: string) => void
  onSave: () => void
  onReset: () => void
  locale: 'zh-CN' | 'en-US'
  t: (key: string, ...args: unknown[]) => ReactNode
}

function IntroView({
  value,
  loaded,
  saving,
  dirty,
  onChange,
  onSave,
  onReset,
  locale,
  t,
}: IntroViewProps) {
  return (
    <div className="pdr-set__panel">
      <div className="pdr-set__head">
        <div className="pdr-set__title">{t(`${NS}.intro.title`)}</div>
        <div className="pdr-set__sub">{t(`${NS}.intro.sub`)}</div>
      </div>
      <div className="pdr-set__mdwrap">
        {!loaded ? (
          <div className="pdr-set__mdloading">
            <Loading />
          </div>
        ) : (
          <MarkdownEditor value={value} onChange={onChange} locale={locale} />
        )}
      </div>
      <AreaFooter
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onReset={onReset}
        saveLabel={t(`${NS}.common.save`)}
        resetLabel={t(`${NS}.common.reset`)}
        t={t}
      />
    </div>
  )
}

// ============================================================
// 子组件：多语言设置视图（英文 / 中文复用）
// ============================================================

interface LocaleViewProps {
  localeKey: 'en' | 'zh'
  name: string
  desc: string
  mdValue: string
  mdLoaded: boolean
  dirty: boolean
  saving: boolean
  onNameChange: (v: string) => void
  onDescChange: (v: string) => void
  onMdChange: (v: string) => void
  onSave: () => void
  onReset: () => void
  onUseDefault: () => void
  editorLocale: 'zh-CN' | 'en-US'
  t: (key: string, ...args: unknown[]) => ReactNode
}

function LocaleView({
  localeKey,
  name,
  desc,
  mdValue,
  mdLoaded,
  dirty,
  saving,
  onNameChange,
  onDescChange,
  onMdChange,
  onSave,
  onReset,
  onUseDefault,
  editorLocale,
  t,
}: LocaleViewProps) {
  const titleKey = localeKey === 'en' ? 'locale.enTitle' : 'locale.zhTitle'
  const subKey = localeKey === 'en' ? 'locale.enSub' : 'locale.zhSub'
  return (
    <div className="pdr-set__panel">
      <div className="pdr-set__localehead">
        <div className="pdr-set__localeheadtext">
          <div className="pdr-set__title">{t(`${NS}.${titleKey}`)}</div>
          <div className="pdr-set__sub">{t(`${NS}.${subKey}`)}</div>
        </div>
        <Button
          variant="outline"
          onClick={onUseDefault}
          title={String(t(`${NS}.locale.useDefaultTip`))}
        >
          {t(`${NS}.locale.useDefault`)}
        </Button>
      </div>

      <section className="pdr-set__group">
        <label className="pdr-field">
          <span className="pdr-field__label">{t(`${NS}.locale.name`)}</span>
          <Input className="dui-input" value={name} onChange={(e) => onNameChange(e.target.value)} />
        </label>
        <label className="pdr-field">
          <span className="pdr-field__label">{t(`${NS}.locale.desc`)}</span>
          <Textarea
            value={desc}
            rows={2}
            onChange={(e) => onDescChange(e.target.value)}
          />
        </label>
      </section>

      <section className="pdr-set__group">
        <div className="pdr-set__grouptitle">{t(`${NS}.locale.intro`)}</div>
        <div className="pdr-set__mdwrap">
          {!mdLoaded ? (
            <div className="pdr-set__mdloading">
              <Loading />
            </div>
          ) : (
            <MarkdownEditor
              value={mdValue}
              onChange={onMdChange}
              locale={editorLocale}
            />
          )}
        </div>
      </section>

      <AreaFooter
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onReset={onReset}
        saveLabel={t(`${NS}.common.save`)}
        resetLabel={t(`${NS}.common.reset`)}
        t={t}
      />
    </div>
  )
}
