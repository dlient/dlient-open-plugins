/** dsh 渲染层环境声明 */

/** ?raw 导入（样式打进 JS 手动注入 <style>） */
declare module '*.css?raw' {
  const content: string
  export default content
}

/** preload 暴露的渲染层桥子集（主题 / 语言广播） */
interface Window {
  dlient: {
    /** 监听主进程主题广播（'dark' / 'light'；含初始回放） */
    on(channel: 'theme', callback: (theme: 'dark' | 'light') => void): () => void
    /** 监听主进程语言广播（locale，如 'zh-CN' / 'en-US'；含初始回放） */
    on(channel: 'language', callback: (locale: string) => void): () => void
  }
}
