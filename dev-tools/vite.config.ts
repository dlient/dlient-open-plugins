import { createPluginViteConfig } from '@dlient-open/plugin-sdk/vite-config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pluginId = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).dlient?.id ?? 'unknown'
export default createPluginViteConfig({
  pluginId,
  pluginDir: fileURLToPath(new URL('.', import.meta.url)),
  hasWorker: true,
})
