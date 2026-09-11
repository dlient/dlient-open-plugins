import { createPluginViteConfig } from '@dlient-open/plugin-sdk/vite-config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'vite'

// 插件 UI 构建预设（System.register 格式，宿主用 SystemJS 加载，见 @dlient-open/ui PluginView）。
// - 构建：入口固定 remoteEntry.js，react 系与 @dlient-open/* 全部 external（宿主 SystemJS registry 单实例）；
//   CSS 合并单文件并由 dlient:css-link 注入 <link>（dlientOpen:// 协议 + 版本戳）。
// - 热重载为产物级（无需 dev server 端口）：npm run dev:watch 写 dist → 宿主 fs.watch 广播
//   plugin-changed → PluginView cache-bust 整模块重载。
const pluginId = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).dlient?.id ?? 'unknown'

const preset = createPluginViteConfig({
  pluginId,
  pluginDir: fileURLToPath(new URL('.', import.meta.url)),
  hasWorker: true,
})

/**
 * 预设把 `lucide-react` 也标成 external（注释里假定"由宿主 SystemJS registry 共享"），
 * 但宿主的 import map 实际并不包含这个裸标识符，插件直接 `import { Plus } from 'lucide-react'`
 * 会在加载 remoteEntry.js 时报 `SystemJS Error#8: Unable to resolve bare specifier 'lucide-react'`。
 *
 * 因此这里把它从 external 列表里摘掉 → 图标改为按需打包进插件产物（rollup 摇树，
 * 只会带上本插件真正用到的十来个图标，约 10KB 内），插件因此自包含、不依赖宿主的共享约定。
 * 其余 external（react / react-dom / @dlient-open/*）必须保留：它们确实由宿主 registry 提供单实例。
 */
const BUNDLED_INSTEAD_OF_EXTERNAL = 'lucide-react'

const presetExternal = preset.build?.rollupOptions?.external
const external = Array.isArray(presetExternal)
  ? presetExternal.filter((id) => id !== BUNDLED_INSTEAD_OF_EXTERNAL)
  : presetExternal

export default {
  ...preset,
  build: {
    ...preset.build,
    rollupOptions: {
      ...preset.build?.rollupOptions,
      external,
    },
  },
} as UserConfig
