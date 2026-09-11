/**
 * dev-tools 渲染层共享类型与工具。
 *
 * 说明：这里的类型对齐 worker（src/main/index.ts）实际返回的数据形状，
 * 而非 plugin-sdk 的完整 PluginManifest —— worker 只透出必要字段。
 */

/** 操作台 Tab 的固定 value（不会与插件 id 冲突） */
export const HOME_TAB = '__home__'

/** 插件 Tab 内的视图（按需求去除「编辑」「AI」） */
export type ViewKey = 'preview' | 'log' | 'setting'

/** manifest 多语言文本：字符串或 { default, 'zh-CN', 'en-US' } */
export type LocalizedText = string | Record<string, string>

/**
 * dev 插件条目（dev-tools.list 返回项，即 plugins.json 的记录）。
 * 注意 name 已被 worker 的 readManifest 摊平为字符串（取 default），不是多语言对象。
 */
export interface DevPlugin {
  id: string
  name: string
  path: string
  dist: string
  version?: string
  type?: string
  system?: boolean
  icon?: string
  addedAt: number
}

/**
 * 日志增量读取结果。
 * 与宿主 readPluginLogs 语义一致；因 @dlient-open/ui 未转出该类型，此处自建等价声明。
 */
export interface PluginLogReadResult {
  lines: string[]
  offset: number
  reset: boolean
  truncated: boolean
}

/** 设置页数据（dev-tools.readSettings 返回值） */
export interface SettingsPayload {
  dir: string
  version?: string
  id?: string
  dlient: {
    name?: LocalizedText
    description?: LocalizedText
    type?: string
    /** 平台 + 架构组合值：win32.x64 / win32.arm64 / darwin.x64 / darwin.arm64 / linux.x64 / linux.arm64 */
    platforms?: string[]
    /** 图标：字符串（assets/icon.svg）或四态对象 { light, light_active, dark, dark_active } */
    icon?: string | Record<string, string>
    tags?: string[]
  }
}

/**
 * 插件类型选项（对齐 plugin-sdk 的 PluginType）。
 * labelKey/descKey 为 i18n key（NS=dev-tools），组件内经 t() 转文案。
 */
export const TYPE_OPTIONS: Array<{ value: string; labelKey: string; descKey: string }> = [
  { value: 'app', labelKey: 'type.app', descKey: 'type.appDesc' },
  { value: 'full', labelKey: 'type.full', descKey: 'type.fullDesc' },
  { value: 'ui', labelKey: 'type.ui', descKey: 'type.uiDesc' },
  { value: 'worker', labelKey: 'type.worker', descKey: 'type.workerDesc' }
]

/** 平台选项（value 为平台前缀，与架构组合成 win32.x64 等）；含图标 SVG 内联 */
export const PLATFORM_OPTIONS: Array<{ value: string; label: string; icon: string }> = [
  {
    value: 'win32',
    label: 'Windows',
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 5.5L10.5 4.5V11H3V5.5M3 12.5H10.5V19L3 18V12.5M11.5 4.4L21 3V11H11.5V4.4M11.5 12.5H21V20.6L11.5 19.5V12.5Z"/></svg>',
  },
  {
    value: 'darwin',
    label: 'macOS',
    icon:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.05 12.04c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.77-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.89-3.76 2.26-1.6 2.78-.41 6.9 1.16 9.16.77 1.11 1.69 2.36 2.89 2.32 1.16-.05 1.6-.75 3-.75 1.41 0 1.8.75 3.04.72 1.25-.02 2.05-1.14 2.82-2.26.89-1.3 1.26-2.56 1.28-2.62-.03-.01-2.45-.94-2.48-3.72M14.5 5.66c.64-.78 1.07-1.85.95-2.93-.92.04-2.04.61-2.7 1.38-.59.69-1.11 1.79-.97 2.85 1.03.08 2.08-.52 2.72-1.3"/></svg>',
  },
  {
    value: 'linux',
    label: 'Linux',
    icon:
      '<svg t="1788415155408" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="6560" width="64" height="64"><path d="M867.5 805.6c-4.6-13.7-44.6-30.9-57.2-58.4s-2.3-42.3-21.7-56.1c-2.6-1.9-5.5-3-8.6-3.7 6.8-18 7-42.6 6.1-75-2.3-84.7-39.3-135.5-59.2-160.3-23.8-29.7-32-40.9-50.3-69.7-17.7-27.8-36.5-62-37.1-98.8-0.8-43.5-2.3-93.5-22.9-131.2s-71.8-74.9-144.2-54.9c-77.4 21.4-79.3 86.5-82.7 134.6s18.5 82.3 0.1 143.1-50.4 83.4-65.8 113.9c-38.1 75.5-46.2 82.2-62.9 121.1-18.5 42.9-4.6 68.3-4.6 68.3l0.8 2.1c-6.6 12.2-10.1 24.4-17.9 27.7-15.6 6.6-52.6-3.4-65.2 9.2s6.1 88.9-2.3 103c-8.4 14.1-16 13.7-16 36.6s25.2 20.6 123.6 53.8 116.7 24 139.6-4.6c3.8-4.7 6.2-9.9 7.6-15.4 30.1-2.7 60.5-5.1 78.2-5.2 39.3-0.2 94.3 12.2 119.9 18.5 3.7 9.9 9.1 17.9 16.3 21.6 20.6 10.3 68.7 9.2 97.3-18.3s100.7-62.9 109.9-72.1 23.7-16.1 19.2-29.8z m-411.9-528c-1.1-13-8.2-22.9-15.9-22.3s-13.1 11.7-12 24.6c0.6 7.2 3.1 13.5 6.5 17.5-1.2 1.1-2.3 2.1-3.4 3.1-5.6-7.3-10.3-19-11.5-33.3-2.1-24.7 7.5-44.1 17.5-44.9h0.7v-7.4 7.4c9.7 0 22 17 24 41.4 0.4 5.2 0.3 10.1-0.1 14.7-1.9 0.8-3.8 1.7-5.6 2.6-0.1-1-0.1-2.2-0.2-3.4zM441.4 291c0 0.1 0 0.1 0 0 0 0.1 0 0.1 0 0z m-2.5 2.2l-0.1 0.1 0.1-0.1z m-2.4 2.2l-0.1 0.1c0-0.1 0-0.1 0.1-0.1z m-9.6 8.5c0.6-0.5 1.1-1 1.7-1.5-0.6 0.6-1.1 1.1-1.7 1.5z m2-1.7c0.6-0.5 1.2-1.1 1.8-1.6-0.6 0.6-1.2 1.1-1.8 1.6z m38-25.7z m-21.6 49.3c2.5-2.1 4.9-4.3 7.2-6.4 10.7-9.8 17.9-15.8 27.5-16.2 1.1-0.1 2.2-0.1 3.3-0.1 16.3 0 32.8 5.8 55.2 19.6 2 1.2 3.9 2.3 5.7 3.4-5 4.5-11 9.7-17.9 15.3-15.9 12.9-27.7 20.9-33.8 24.3-4.5-2-12.7-6.5-24.9-14.9-13.3-9.2-23.5-17.8-26.1-20.4 1-1.6 2.3-3.3 3.8-4.6z m96-34.6c0.5 0.3 1.1 0.6 1.6 0.9-0.5-0.3-1-0.6-1.6-0.9z m1.7-38c-9.6-0.5-18.7 9.8-20.3 23-0.3 2.1-0.3 4.2-0.1 6.1-3.7-1.5-7.4-2.7-11-3.8-0.4-4.4-0.4-9 0.2-13.6 1.4-12 6.1-23.2 13-31.3 6.2-7.2 13.4-11.2 20.3-11.2h1c5.2 0.3 9.9 2.8 13.8 7.5 7.1 8.4 10.3 22.1 8.6 36.6-1.4 12-6.1 23.2-13 31.3-0.3 0.3-0.6 0.7-0.9 1l-0.9-0.6c-1.4-0.9-2.8-1.7-4.2-2.5 4.2-4.2 7.2-10.5 8.1-17.7 1.4-13.2-5-24.3-14.6-24.8z m4 41.2c-0.6-0.3-1.2-0.7-1.8-1 0.7 0.3 1.3 0.6 1.8 1z m-13.8-7.4c-0.4-0.2-0.9-0.4-1.3-0.6 0.4 0.2 0.8 0.4 1.3 0.6z m-3.9-1.8c-0.4-0.2-0.7-0.3-1.1-0.5 0.4 0.2 0.8 0.4 1.1 0.5z m-23.6-8.1c0.1 0 0.2 0.1 0.4 0.1-0.2-0.1-0.3-0.1-0.4-0.1z m51.5 23.3c-0.9-0.5-1.8-1.1-2.7-1.6 0.9 0.6 1.8 1.1 2.7 1.6z m6.8 3.9c-0.5-0.3-1.1-0.6-1.7-0.9 0.6 0.3 1.1 0.6 1.7 0.9z m-1.9-1c-0.7-0.4-1.5-0.9-2.3-1.3 0.8 0.4 1.6 0.9 2.3 1.3z m-2.4-1.4c-0.8-0.5-1.6-1-2.5-1.5 0.9 0.5 1.7 1 2.5 1.5z m32.7 509c-18 16.4-31.8 23.2-41.9 29.6-18.9 12-49.4 19.3-81.1 14.5-20.1-3-38.1-11.4-53.9-20.9-3.8-7.4-7.6-13.4-10.4-17-7-9.3-54.6-76.6-84.4-118.6-1.6-8.6-2.4-17-2.3-25 0.6-49.2 14.3-106.7 25.5-120.2 3.4-4.1 28.4-75.3 34.3-90.4 10.9-27.5 27.7-59.8 36.5-78.7 6-15.6 6.9-26.5 6.1-33.9 9.9 10.3 56.3 45.3 72.9 45.3h0.3c13.8-0.3 66.7-43.4 84.8-63.2 1.7 7.2 10.6 21.5 16.3 35.3 16.6 40.2 35.9 115.4 66.8 157.1 2.1 2.9 7.3 12.7 8.3 16.5 12 43.1 9.6 75.7 2.2 139.7-3.3-1.1-7.1-2-12.1-2.4-21.1-1.7-28.6 6.9-28.6 6.9s-1.2 47.4-3.5 91.3c-1.8 2-3.7 4-5.6 6-10.8 10.8-20.8 20.1-30.2 28.1z" fill="" p-id="6561"></path></svg>',
  },
]

/** CPU 架构选项 */
export const ARCH_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'x64', label: 'x64' },
  { value: 'arm64', label: 'ARM64' },
]

/** 运行状态 → i18n key */
export const STATE_TEXT: Record<string, string> = {
  running: 'state.running',
  starting: 'state.starting',
  stopped: 'state.stopped',
  failed: 'state.failed',
}

/** 插件类型 → 短文案 i18n key（卡片角标） */
export const TYPE_TEXT: Record<string, string> = {
  full: 'typeShort.full',
  ui: 'typeShort.ui',
  worker: 'typeShort.worker',
  app: 'typeShort.app',
}

/** 取多语言文本的展示值：locale → default → 任意首个 → fallback */
export function localize(text: LocalizedText | undefined, fallback = '', locale = 'zh-CN'): string {
  if (typeof text === 'string') return text || fallback
  if (!text) return fallback
  return text[locale] ?? text.default ?? Object.values(text)[0] ?? fallback
}

/** 取多语言文本的指定语言分量（设置页双语编辑用，不做回退，空即为空） */
export function localeValue(text: LocalizedText | undefined, locale: string): string {
  if (typeof text === 'string') return locale === 'default' || locale === 'zh-CN' ? text : ''
  return text?.[locale] ?? ''
}

/**
 * 由双语输入回写多语言对象。
 * 保留 default 与 zh-CN 一致（宿主 localizeText 以 default 兜底），en-US 为空则不写该键。
 */
export function buildLocalized(zh: string, en: string): LocalizedText | undefined {
  const z = zh.trim()
  const e = en.trim()
  if (!z && !e) return undefined
  const out: Record<string, string> = { default: z || e, 'zh-CN': z || e }
  if (e) out['en-US'] = e
  return out
}

/**
 * 由默认 + 中文 + 英文三段输入回写多语言对象。
 *  - 全空 → undefined（删除字段）；
 *  - 仅有默认值无 locale 变体 → 返回字符串（最简形态）；
 *  - 否则返回 { default?, 'zh-CN'?, 'en-US'? }，仅写入非空分量。
 */
export function buildLocalized3(
  def: string,
  zh: string,
  en: string,
): LocalizedText | undefined {
  const d = def.trim()
  const z = zh.trim()
  const e = en.trim()
  if (!d && !z && !e) return undefined
  if (!z && !e) return d
  const out: Record<string, string> = {}
  if (d) out.default = d
  if (z) out['zh-CN'] = z
  if (e) out['en-US'] = e
  return out
}
