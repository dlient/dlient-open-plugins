/**
 * 宿主外观（语言 / 主题）→ dsh settings.yaml 同步。
 *
 * dsh 的界面语言/主题由 <DSH_HOME>/settings.yaml 决定；宿主语言/主题变化时把目标值下发 worker
 * （worker 改写该文件，dsh 页面自动刷新）。App（dsh web）与 Chat（dlient-chat 面）共用本 hook。
 *
 * `enabled`（缺省 true）：供内嵌方「折叠不启动」用——visible=false（折叠）时不推外观、不监听，
 * 避免一次挂载就触发 dsh 的 settings.yaml 授权弹框；展开（enabled 变 true）时重新推当前外观。
 */

import { useCallback, useEffect, useRef } from 'react'
import { useDlientApi } from '@dlient-open/ui'
import { useI18n } from '@dlient-open/i18n'

export function useDshAppearance(enabled = true): void {
  const api = useDlientApi()
  const { locale } = useI18n()
  const darkRef = useRef(false)

  const pushAppearance = useCallback(
    (language: string, dark: boolean) => {
      void api.request('dsh.applyAppearance', [language, dark]).catch(() => undefined)
    },
    [api],
  )

  useEffect(() => {
    if (!enabled) return
    let lang = typeof locale === 'string' && locale ? locale : 'en-US'
    let dark = darkRef.current
    void pushAppearance(lang, dark)
    const offLang = window.dlient.on('language', (l) => {
      if (typeof l === 'string' && l) {
        lang = l
        void pushAppearance(lang, dark)
      }
    })
    const offTheme = window.dlient.on('theme', (theme) => {
      dark = theme === 'dark'
      darkRef.current = dark
      void pushAppearance(lang, dark)
    })
    return () => {
      offLang()
      offTheme()
    }
  }, [locale, pushAppearance, enabled])
}
