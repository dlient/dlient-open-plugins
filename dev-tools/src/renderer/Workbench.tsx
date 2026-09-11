/**
 * 操作台：dev 插件卡片网格。
 *
 * 视觉稿：plugin-html/modal/src/dev-tools/Workbench.tsx（.pdr-work__* / .pdr-card__*）。
 * 与稿的差异：
 *  - 稿中 logo 是色块 + 首字母假数据，这里用真实 PluginIcon（统一以 <img> 渲染 svg/png）；
 *  - 类型标签统一两类：app=应用（主色调）/ 其他=插件（warning）；版本号以默认色调标签紧跟其后；
 *  - 运行状态置于卡片右上；底部仅保留「删除」（danger 按钮 + 确认弹框）；
 *  - 点击整张卡片打开预览。
 */

import type { ReactNode } from 'react'
import { AddIcon, Button, DeleteIcon, FolderOpenIcon, PluginIcon, Tag, modal, useDlientApi } from '@dlient-open/ui'
import { localize, STATE_TEXT, type DevPlugin, type ViewKey } from './types'
import { useI18n } from '@dlient-open/i18n'
import './i18n'

const NS = 'dev-tools'

export interface WorkbenchProps {
  plugins: DevPlugin[]
  /** 首次拉取是否已完成（未完成时不显示空态，避免闪现） */
  loaded: boolean
  /** 取 dev 实例 worker 状态 */
  runtimeOf: (id: string) => string
  onOpen: (id: string, view: ViewKey) => void
  onRemove: (id: string) => void
  onImport: () => void
  onCreate: () => void
  /** 头部附加操作（如刷新） */
  extra?: ReactNode
}

export function Workbench({
  plugins,
  loaded,
  runtimeOf,
  onOpen,
  onRemove,
  onImport,
  onCreate,
  extra,
}: WorkbenchProps) {
  const { t } = useI18n()
  const api = useDlientApi()
  return (
    <div className="pdr-scroll">
      <div className="pdr-work__head">
        <div className="pdr-work__headtext">
          <div className="pdr-work__title">{t(`${NS}.work.title`)}</div>
          <div className="pdr-work__sub">{t(`${NS}.work.sub`, { count: plugins.length })}</div>
        </div>
        <div className="pdr-work__headops">
          {extra}
          <Button  variant="outline" onClick={onImport}>
            <FolderOpenIcon />
            {t(`${NS}.work.import`)}
          </Button>
          <Button  variant="default" onClick={onCreate}>
            <AddIcon />
            {t(`${NS}.work.create`)}
          </Button>
        </div>
      </div>

      {loaded && plugins.length === 0 ? (
        <div className="pdr-empty">{t(`${NS}.work.empty`)}</div>
      ) : (
        <div className="pdr-work__grid">
          {plugins.map((p) => {
            const name = localize(p.name, p.id)
            const state = runtimeOf(p.id)
            return (
              <div className="pdr-card" key={p.id}>
                <div className="pdr-card__top">
                  <PluginIcon className="pdr-card__logo" active={true} pluginId={p.id} icon={p.icon} name={name} size={48} />
                  <div className="pdr-card__info">
                    <div className="pdr-card__nameline">
                      <span className="pdr-card__name" title={name}>
                        {name}
                      </span>
                      {/* 类型标签：app=应用（主色调）/ 其他=插件（warning） */}
                      <Tag size="small" theme={p.type === 'app' ? 'primary' : 'warning'}>
                        {p.type === 'app' ? t(`${NS}.work.typeApp`) : t(`${NS}.work.typePlugin`)}
                      </Tag>
                      {/* 版本号：默认色调标签，位于类型标签之后 */}
                      <Tag size="small">v{p.version ?? '0.0.0'}</Tag>
                    </div>
                    <div className="pdr-card__summary" title={p.path}>
                      {p.path}
                    </div>
                  </div>
                  {/* 运行状态：卡片右上（不显示"构建中"） */}
                  <div className={`pdr-state pdr-state--${state}`}>
                    <span className="pdr-state__dot" />
                    <span>{t(`${NS}.${STATE_TEXT[state] ?? state}`)}</span>
                  </div>
                </div>

                <div className="pdr-card__bottom">
                  <div className="pdr-card__ops">
                    {/* 打开：打开预览（dev 插件由 dev runtime 启动构建 + 加载） */}
                    <Button size="sm" variant="default" onClick={() => onOpen(p.id, 'preview')}>
                      {t(`${NS}.work.open`)}
                    </Button>
                    {/* 删除：danger 按钮 + 确认弹框 */}
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        void (async () => {
                          const ok = await modal.sync.confirm(
                            t(`${NS}.work.removeTitle`) as string,
                            t(`${NS}.work.removeConfirm`, { name }) as string,
                          )
                          if (ok) onRemove(p.id)
                        })()
                      }}
                    >
                      <DeleteIcon />
                      {t(`${NS}.work.remove`)}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
