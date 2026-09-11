/**
 * esbuild 构建期虚拟模块声明（见 script/build-worker.mjs 的 `dlient:chat-assets` 插件）。
 * worker 产物内联了内置 dsh-chat-ui 资产，运行期不再读取插件安装目录。
 */

declare module 'dlient:chat-assets' {
  /** 资产版本（assets/dsh-chat-ui/package.json 的 version，构建期常量） */
  export const CHAT_ASSETS_VERSION: string
  /** 资产内容：相对包根的 POSIX 路径（如 'lib/client.js'）→ 文件内容 */
  export const CHAT_ASSETS: Record<string, string>
}
