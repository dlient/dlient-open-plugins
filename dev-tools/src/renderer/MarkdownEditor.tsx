/**
 * Markdown 编辑器（@atomic-editor/editor）。
 *
 * 基于 CodeMirror 6 的 Obsidian 风格实时预览：格式化即时渲染（标题/加粗/表格/图片/任务列表），
 * 光标所在行才显示原始语法；底层始终是纯 markdown 文本，复制/保存与 plain textarea 逐字节一致。
 * 替换 @uiw/react-md-editor（工具栏 + 分屏预览）。
 */

import { useEffect, useRef, useState } from 'react'
import { AtomicCodeMirrorEditor } from '@atomic-editor/editor'
import '@atomic-editor/editor/styles.css'

export interface MarkdownEditorProps {
  value: string
  onChange: (markdown: string) => void
  theme?: 'light' | 'dark'
  locale?: 'zh-CN' | 'en-US'
  className?: string
}

/** 检测当前暗色主题（:root.dark） */
function detectDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

export function MarkdownEditor({
  value,
  onChange,
  theme,
  className,
}: MarkdownEditorProps) {
  // 内部维护暗色状态，初始化用 theme 或自动检测；atomic-editor 默认暗色、[data-theme="light"] 切换亮色
  const [isDark, setIsDark] = useState(theme === 'dark' || (theme === undefined && detectDark()))

  // atomic-editor 为「挂载后 uncontrolled」：markdownSource 仅在首次读取，文档后续经 ref/handle 维护。
  // 这里实现外部受控语义：自身 onChange 回写同步到 lastEmitted（避免编辑时重建编辑器），
  // 外部内容变化（异步加载 / 切换语言文件 / 重置）时递增 seq 重建编辑器载入新文档。
  const [doc, setDoc] = useState(value)
  const lastEmitted = useRef(value)
  const [seq, setSeq] = useState(0)

  // 主题适配：theme 显式指定时直接用；否则 MutationObserver 监听 :root.dark
  useEffect(() => {
    if (theme !== undefined) {
      setIsDark(theme === 'dark')
      return
    }
    const apply = () => setIsDark(detectDark())
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [theme])

  // 外部内容变化（非自身编辑回写）→ 重建编辑器载入新文档
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value
      setDoc(value)
      setSeq((s) => s + 1)
    }
  }, [value])

  return (
    <div
      className={className}
      data-theme={isDark ? undefined : 'light'}
      style={{
        height: 420,
        borderRadius: 4,
        overflow: 'hidden',
        background: 'var(--dl-fill-0)',
      }}
    >
      <AtomicCodeMirrorEditor
        key={seq}
        markdownSource={doc}
        onMarkdownChange={(md) => {
          const next = md ?? ''
          lastEmitted.current = next
          onChange(next)
        }}
        onLinkClick={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
      />
    </div>
  )
}
