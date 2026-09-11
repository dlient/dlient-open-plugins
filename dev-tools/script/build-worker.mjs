// 构建 worker（esbuild）：打包 src/main/index.ts → dist/worker.js（utilityProcess 入口）
// 用法：node build-worker.mjs                 单次构建（输出到默认 dist）
//       node build-worker.mjs --outdir <dir> 指定输出目录（npm run pack 复用构建链，构建到 pack/<version>/dist）
//       node build-worker.mjs --watch        监听源码变化自动重建（dev 插件热重载用）
import { build, context } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const watchMode = process.argv.includes('--watch')
// --outdir：pack 场景把 worker 产物构建到 pack/<version>/dist（不改动开发期 dist）
const outdirIdx = process.argv.indexOf('--outdir')
const distDir = outdirIdx !== -1 && process.argv[outdirIdx + 1]
  ? path.resolve(__dirname, '..', process.argv[outdirIdx + 1])
  : path.join(__dirname, '..', 'dist')

// ESM bundle 顶层注入 require / __filename / __dirname（createRequire + fileURLToPath）：
// 库代码对 node 内建模块的动态 require 与 __filename/__dirname 用法在 esbuild ESM 输出中需运行时
// 提供；banner 定义后模块作用域可用（防 Node ESM 下 "Dynamic require of path is not supported"）。
const ESM_REQUIRE_BANNER =
  `import { createRequire as __dlientCreateRequire } from 'node:module';\n` +
  `import { fileURLToPath as __dlientFileURLToPath } from 'node:url';\n` +
  `import { dirname as __dlientDirname } from 'node:path';\n` +
  `const require = __dlientCreateRequire(import.meta.url);\n` +
  `const __filename = __dlientFileURLToPath(import.meta.url);\n` +
  `const __dirname = __dlientDirname(__filename);\n`

const outfile = path.join(distDir, 'worker.js')

const options = {
  entryPoints: [path.join(__dirname, '..', 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',

  banner: { js: ESM_REQUIRE_BANNER },
  target: 'node20',
  outfile,
  external: ['electron'],
  minify: !watchMode,
  logLevel: 'info',
}

if (watchMode) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('[worker:watch] watching src/main -> dist/worker.js (Ctrl+C to stop)')
} else {
  await build(options)
}
