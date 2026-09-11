import { createPluginViteConfig } from '@dlient-open/plugin-sdk/vite-config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 插件 UI 构建预设（System.register 格式，宿主用 SystemJS 加载，见 @dlient-open/ui PluginView）。
// - 构建：入口固定 remoteEntry.js，react 系与 @dlient-open/* 全部 external（宿主 SystemJS registry 单实例）；
//   CSS 合并单文件并由 dlient:css-link 注入 <link>（dlientOpen:// 协议 + 版本戳）。
// - 开发热重载：npm run dev:watch（vite build --watch）写 dist → 宿主 fs.watch 广播
//   plugin-changed → PluginView cache-bust 整模块重载（产物级，无 dev server）。
const pluginId = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).dlient?.id ?? 'unknown'
export default createPluginViteConfig({
  pluginId,
  pluginDir: fileURLToPath(new URL('.', import.meta.url)),
  hasWorker: true,
})
