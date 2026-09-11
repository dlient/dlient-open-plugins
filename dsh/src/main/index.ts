/**
 * dsh worker 入口（src/main/index.ts）。
 *
 * 目标：在 dlient 中运行 DeepSeek Harness（dsh）的 web UI 与 chat 面。
 * 流程：经 nodejs host-api 解析 Node.js 运行时（内置 LTS 优先 → PATH 本地 → 自动安装内置）→
 *       （未安装时）npm 全局安装 @deepseek-ai/dsh →
 *       用 host-api 分配空闲端口 → 启动 `dsh web`（或 `dsh --profile dlient-chat`，见 chat.ts）→
 *       探测端口就绪 → 把 URL 交给渲染端。
 * 渲染端用 @dlient-open/ui 的 Webview 组件（经本 worker 内建 webview:* 转发）加载该 URL。
 *
 * 沙箱合规（Node Permission Model：无 fs 写 / 无 child_process / 无 net）：
 *   一切文件、进程、端口操作都走 host-api —— 见 ./dsh-runtime.ts。
 */

import { createWorkerRpc } from '@dlient-open/plugin-sdk'
import { CMD_NODE } from '@dlient-open/plugin-sdk'
import type { ChildHandle } from '@dlient-open/plugin-sdk'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createChatController, type ChatStatus } from './chat'
import { dshCliPath, ensureFsGrant, envWithNode, execHosted, installDsh, isDshInstalled, readText, removePath, writeText } from './dsh-runtime'

const rpc = createWorkerRpc('dsh')

// ---- worker 端 i18n：经宿主 i18n.getLocale 查询当前语言，按语言拼装用户可见文案 ----
type DshLocale = 'zh-CN' | 'en-US'
const DSH_MSG: Record<DshLocale, Record<string, (p?: Record<string, string | number>) => string>> = {
  'zh-CN': {
    execFailed: (p) => `命令失败（exit ${p?.code}）：${p?.err ?? ''}`,
    nodeMissing: () => '无法获取 Node.js 运行时（内置 LTS 安装失败或不可用）',
    npmGlobalMissing: () => '无法定位 npm 全局目录（npm root -g 无输出）',
    npmInstallFailed: (p) => `npm install 失败（exit ${p?.code}）: ${p?.out ?? ''}`,
    binMissing: () => '@deepseek-ai/dsh 包缺少 bin 入口',
    pnpmInstallFailed: (p) => `安装 pnpm 失败（exit ${p?.code}）: ${p?.out ?? ''}`,
    chatInstallFailed: (p) => `安装 dsh chat profile 失败（exit ${p?.code}）: ${p?.out ?? ''}`,
    chatAssetsMissing: (p) => `插件内置的 dsh-chat-ui 资产缺失：${p?.path ?? ''}`,
    chatStartTimeout: (p) => `dsh chat 服务启动超时。输出：${p?.out ?? ''}`,
    chatExited: (p) => `dsh chat 进程已退出（exit ${p?.code ?? 'unknown'}）：${p?.out ?? ''}`,
    fsGrantDesc: () => '同步 dsh 的语言 / 主题设置（读写 ~/.dsh/settings.yaml）',
    fsGrantDenied: () => '未授权访问 dsh 配置（~/.dsh/settings.yaml），已跳过语言 / 主题同步',
  },
  'en-US': {
    execFailed: (p) => `Command failed (exit ${p?.code}): ${p?.err ?? ''}`,
    nodeMissing: () => 'Cannot resolve the Node.js runtime (built-in LTS install failed or unavailable)',
    npmGlobalMissing: () => 'Cannot locate the global npm directory (npm root -g returned nothing)',
    npmInstallFailed: (p) => `npm install failed (exit ${p?.code}): ${p?.out ?? ''}`,
    binMissing: () => 'The @deepseek-ai/dsh package is missing its bin entry',
    pnpmInstallFailed: (p) => `Installing pnpm failed (exit ${p?.code}): ${p?.out ?? ''}`,
    chatInstallFailed: (p) => `Installing the dsh chat profile failed (exit ${p?.code}): ${p?.out ?? ''}`,
    chatAssetsMissing: (p) => `Bundled dsh-chat-ui assets are missing: ${p?.path ?? ''}`,
    chatStartTimeout: (p) => `The dsh chat service did not become ready in time. Output: ${p?.out ?? ''}`,
    chatExited: (p) => `The dsh chat process exited (exit ${p?.code ?? 'unknown'}): ${p?.out ?? ''}`,
    fsGrantDesc: () => 'Sync dsh language / theme settings (read & write ~/.dsh/settings.yaml)',
    fsGrantDenied: () => 'Access to the dsh config (~/.dsh/settings.yaml) was denied; language / theme sync skipped',
  },
}
let dshLocale: DshLocale = 'zh-CN'
async function queryDshLocale(): Promise<DshLocale> {
  try {
    const l = (await rpc.i18n.getLocale()) as DshLocale
    dshLocale = l === 'en-US' || l === 'zh-CN' ? l : 'zh-CN'
  } catch {
    /* 保留上次语言 */
  }
  return dshLocale
}
async function dmsg(key: string, params?: Record<string, string | number>): Promise<string> {
  const loc = await queryDshLocale()
  return (DSH_MSG[loc][key] ?? DSH_MSG['zh-CN'][key])(params)
}

/** 对外状态（渲染端经 dsh.status / push 'dsh.status' 消费） */
interface DshStatus {
  phase: 'idle' | 'checking-node' | 'installing-dsh' | 'starting' | 'ready' | 'error'
  url?: string
  error?: string
  /** 是否启动过：stop 后为 true，渲染端据此区分「从未启动（自动启动）」与「已停止（不自动重启）」 */
  startedOnce?: boolean
}

/** 宿主代管子进程句柄（child.spawn 拉起 dsh web；kill 即整树回收） */
let child: ChildHandle | null = null
let current: DshStatus = { phase: 'idle' }

function pushStatus(s: DshStatus): void {
  current = s
  rpc.push('dsh.status', s)
}

// ---- dsh settings.yaml 宿主外观接管（备份 settings.dlient.yaml，关闭时还原）----
// dsh web 的界面语言/主题由 <DSH_HOME>/settings.yaml 的 locale.preference / ui-theme.preference 决定；
// 宿主语言/主题变化时改写该文件（dsh 页面会自动刷新），并在插件停用/退出时还原用户原配置。
// 沙箱下 worker 不能直接读写文件，因此走 host-api rpc.fs.* + 运行时授权（仅两个 settings 文件）。
/**
 * dsh home：默认真实 `~/.dsh`（与命令行 `dsh` 共享同一 home —— 用户在终端里
 * `dsh plugin --profile web add <pkg>` 装的插件，App 内打开即生效），可用 `DSH_HOME` 覆盖。
 */
let dshHome: string | null = null
async function resolveDshHome(): Promise<string> {
  if (dshHome !== null) return dshHome
  const override = (process.env.DSH_HOME ?? '').trim()
  dshHome = override || join(homedir(), '.dsh')
  return dshHome
}

/** 记录渲染端最近一次下发的宿主外观（applyAppearance 更新；start 时据此同步） */
let appearanceDesired: { locale?: string; dark?: boolean } = {}

/**
 * settings 两个文件的读写授权；被拒后不再重复弹框。
 * 只授权这两个文件（而非整个 ~/.dsh），插件读不到 .credentials.yaml 等其它内容。
 *
 * 注意必须「单飞」：结果要等 `permission.request` 返回（用户点击弹框）才产生，
 * 若只缓存结果、不缓存进行中的 Promise，则弹框未答复期间的每一次调用（App/Chat 挂载、
 * dsh.start、chatStart、宿主语言/主题事件）都会各自发起一次申请 → 同一个文件弹 N 次。
 */
let dshSettingsGrantInflight: Promise<boolean> | null = null
/** 申请结果（null = 尚未申请过；true = 已获授权即写过备份，退出时需还原） */
let dshSettingsGranted: boolean | null = null

function ensureSettingsGrant(home: string): Promise<boolean> {
  if (dshSettingsGrantInflight) return dshSettingsGrantInflight
  dshSettingsGrantInflight = (async () => {
    const ok = await ensureFsGrant(
      rpc,
      [join(home, 'settings.yaml'), join(home, 'settings.dlient.yaml')],
      await dmsg('fsGrantDesc'),
    )
    dshSettingsGranted = ok
    if (!ok) rpc.log.write('warn', await dmsg('fsGrantDenied'))
    return ok
  })().catch(() => {
    dshSettingsGranted = false
    return false
  })
  return dshSettingsGrantInflight
}

/** 简单 YAML 叶子替换：把 <section> 块内首个 `preference:` 叶子改为指定值；返回新文本或 null */
function replaceYamlLeaf(text: string, section: string, value: string): string | null {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `${section}:`) continue
    const indent = lines[i].length - lines[i].trimStart().length
    const childPad = ' '.repeat(indent + 2)
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j]
      const trimmed = raw.trim()
      if (trimmed === '') continue
      if (raw.length - raw.trimStart().length <= indent) break // 离开该顶层 section
      if (/^preference\s*:/.test(trimmed)) {
        lines[j] = `${childPad}preference: ${value}`
        return lines.join(nl)
      }
    }
    break
  }
  return null
}

/** settings.yaml 文件操作串行队列（避免并发写冲突） */
let settingsChain: Promise<unknown> = Promise.resolve()
function runSettingsTask<T>(fn: () => Promise<T>): Promise<T> {
  const p = settingsChain.then(fn, fn)
  settingsChain = p.catch(() => undefined)
  return p
}

/**
 * 按宿主外观同步 settings.yaml（locale/theme）。
 * - 未获两个 settings 文件的授权时跳过（功能降级，不影响服务启动）；
 * - 与宿主一致时不改动；确实要改时先备份原文件（仅首次，settings.dlient.yaml）。
 */
async function syncDshAppearance(desired: { locale?: string; dark?: boolean }): Promise<{ ok: boolean; changed: boolean }> {
  const home = await resolveDshHome()
  if (!(await ensureSettingsGrant(home))) return { ok: true, changed: false }
  const settingsFile = join(home, 'settings.yaml')
  const backupFile = join(home, 'settings.dlient.yaml')
  return runSettingsTask(async () => {
    const original = await readText(rpc, settingsFile)
    if (original === null) return { ok: true, changed: false } // 无 settings.yaml：不创建，跳过
    const targetLocale = desired.locale === 'zh-CN' ? 'zh' : desired.locale === 'en-US' ? 'en' : undefined
    const targetTheme = typeof desired.dark === 'boolean' ? (desired.dark ? 'dark' : 'light') : undefined
    let next = original
    let changed = false
    if (targetLocale) {
      const r = replaceYamlLeaf(next, 'locale', targetLocale)
      if (r !== null) {
        if (r !== next) changed = true
        next = r
      }
    }
    if (targetTheme) {
      const r = replaceYamlLeaf(next, 'ui-theme', targetTheme)
      if (r !== null) {
        if (r !== next) changed = true
        next = r
      }
    }
    if (!changed) return { ok: true, changed: false }
    // 仅当尚无备份时落一份原始配置（首次接管前的用户基线）
    if ((await readText(rpc, backupFile)) === null) await writeText(rpc, backupFile, original)
    await writeText(rpc, settingsFile, next)
    return { ok: true, changed: true }
  })
}

/** 还原 settings.yaml（dsh 停止/退出时）：从备份写回并删除备份，下次接管重新锚定基线 */
async function restoreDshSettings(): Promise<void> {
  // 没拿到过授权 = 没写过备份，无需还原；同时避免在退出阶段弹授权框
  if (dshSettingsGranted !== true) return
  const home = await resolveDshHome()
  const settingsFile = join(home, 'settings.yaml')
  const backupFile = join(home, 'settings.dlient.yaml')
  await runSettingsTask(async () => {
    try {
      const backup = await readText(rpc, backupFile)
      if (backup === null) return
      await writeText(rpc, settingsFile, backup)
      await removePath(rpc, backupFile)
    } catch {
      /* 还原失败不抛（进程退出阶段尽力而为） */
    }
  })
}

/** 空闲端口（宿主 net.getFreePort：沙箱下 worker 禁 node:net） */
function getFreePort(): Promise<number> {
  return rpc.net.getFreePort() as Promise<number>
}

// ---- Node.js 运行时解析（内置 host-api：rpc.nodejs.*）----
// 执行 node 一律用命令别名 CMD_NODE（manifest spawnCmds 已声明）：宿主解析为真实可执行文件并按
// 别名记账，因此本机 node 路径 / 版本变化都不会再弹 spawn 授权框。

/** 宿主代 execFile（一次性探测；child.execFile 白名单 + 超时由宿主裁决；非零退出码抛错） */
async function execFileHosted(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  const r = await execHosted(rpc, { cmd, args, timeoutMs })
  if (r.code !== 0) throw new Error(await dmsg('execFailed', { code: r.code, err: (r.stderr || r.stdout).slice(-300) }))
  return r.stdout
}

/** 记录实际选中的 node（路径 + 版本），便于定位 dsh 运行时的 node 环境 */
async function pickNode(node: string, source: string): Promise<string> {
  let version = '?'
  try {
    version = (await execFileHosted(CMD_NODE, ['--version'])).trim() || '?'
  } catch {
    /* 忽略 */
  }
  rpc.log.write('info', `[dsh] resolveNode -> ${source}: ${node} (${version})`)
  return node
}

/**
 * 解析可用的 node 可执行文件路径：内置（~/.dlient-open/plugin-data/nodejs LTS，优先）→
 * 本地（PATH/常见路径，兜底）→ 安装内置。与宿主 nodejs.resolveRuntime 的「内置优先」语义一致，
 * 避免本机旧版 node 跑 dsh 报 ESM/native 兼容错误；两者都没有时自动下载内置 LTS。
 *
 * 返回值只用于**路径推导**（npm 全局目录 --prefix、PATH 前置）；实际执行用 CMD_NODE / CMD_NPM 别名。
 */
async function resolveNode(): Promise<string> {
  const rt = (await rpc.nodejs.resolveRuntime().catch(() => null)) as {
    source?: 'bundled' | 'path' | 'none'
    node?: string
  } | null
  if (rt?.node && (rt.source === 'bundled' || rt.source === 'path')) {
    return pickNode(rt.node, rt.source === 'bundled' ? 'bundled' : 'local')
  }
  const res = (await rpc.nodejs.install().catch(() => null)) as { ok?: boolean; path?: string; error?: string } | null
  if (res?.ok && typeof res.path === 'string') return pickNode(res.path, 'installed')
  throw new Error(res?.error ?? (await dmsg('nodeMissing')))
}

/** 探测 127.0.0.1:port 是否已可访问（宿主 net.probePort：沙箱下 worker 禁 fetch） */
async function probePort(port: number): Promise<boolean> {
  return (await rpc.net.probePort(port)) as boolean
}

/**
 * 启动 `dsh web --no-open --host 127.0.0.1 --port <port>`（以 CMD_NODE 执行 dsh 的 cli.js，不经 npx），
 * 等待指定端口就绪后返回 URL。端口由调用方（getFreePort）预先分配，避免默认 3080 冲突。
 * 宿主代 spawn（child.spawn）：dsh web 即该子进程本身，生命周期（含 worker 退出/崩溃回收）由宿主管理。
 */
async function startDsh(node: string, port: number): Promise<{ url: string }> {
  const cliJs = await dshCliPath(rpc, node, dmsg)
  // DSH_HOME 必须显式传给 dsh 进程：settings.yaml（语言/主题同步目标）就落在该 home 下
  const home = await resolveDshHome()
  const handle = await rpc.child.spawn({
    cmd: CMD_NODE,
    args: [cliJs, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)],
    env: envWithNode(node, { DSH_HOME: home }),
    description: 'dsh web server',
  })
  child = handle
  let output = ''
  handle.onStdout((d: string) => {
    output += d
  })
  handle.onStderr((d: string) => {
    output += d
  })
  return await new Promise<{ url: string }>((resolve, reject) => {
    let settled = false
    const deadline = Date.now() + 120000
    const timer = setInterval(() => {
      void (async () => {
        if (settled) return
        if (await probePort(port)) {
          settled = true
          clearInterval(timer)
          resolve({ url: `http://127.0.0.1:${port}` })
          return
        }
        if (Date.now() >= deadline) {
          settled = true
          clearInterval(timer)
          if (child === handle) child = null
          reject(new Error(`DSH web 服务启动超时。输出：${output.slice(-300)}`))
        }
      })()
    }, 500)
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearInterval(timer)
      if (child === handle) child = null
      reject(err)
    }
    handle.onExit(({ code }) => {
      fail(new Error(`dsh 进程已退出（exit ${code ?? 'unknown'}）: ${output.slice(-300)}`))
    })
    handle.onError((err) => fail(err instanceof Error ? err : new Error(String(err))))
  })
}

// ---- chat 面（内置 dsh-chat-ui → `dsh --profile dlient-chat`）----
// 内置资产在构建期内联进 worker（virtual module 'dlient:chat-assets'，见 script/build-worker.mjs），
// 因此此处无需再定位 assets 目录，也无需 manifest 的 fsDirs 读授权。

const chat = createChatController({
  rpc,
  resolveDshHome,
  msg: dmsg,
  log: (level, message) => rpc.log.write(level, message),
  resolveNode,
  getFreePort,
  probePort,
  installDsh: (node) => installDsh(rpc, node, dmsg),
  dshCliPath: (node) => dshCliPath(rpc, node, dmsg),
  pushStatus: (status: ChatStatus) => rpc.push('dsh.chatStatus', status),
})

// ---- 对外方法（渲染端 api.request / 其它插件 plugin.invoke）----

/** 宿主外观下发（渲染端在语言/主题变化与启动时调用）：记录并同步 settings.yaml */
rpc.registerHandler('dsh.applyAppearance', async ([language, dark]: [language?: string, dark?: boolean]) => {
  appearanceDesired = {
    locale: typeof language === 'string' ? language : undefined,
    dark: typeof dark === 'boolean' ? dark : undefined,
  }
  const r = await syncDshAppearance(appearanceDesired)
  return { ok: true, changed: r.changed }
})

/** 还原 dsh 用户 settings.yaml（渲染端在显式停止时调用；退出时另有 onDispose 兜底） */
rpc.registerHandler('dsh.restoreAppearance', async () => {
  await restoreDshSettings()
  return { ok: true }
})

rpc.registerHandler('dsh.start', async () => {
  if (child) return { ok: true, url: current.url }
  try {
    // 启动前按最近下发的宿主外观同步 settings.yaml（dsh 页面启动即用目标语言/主题）
    try {
      await syncDshAppearance(appearanceDesired)
    } catch {
      /* settings 同步失败不阻塞启动 */
    }
    // 分配空闲端口供 dsh web 监听（--port）。dsh web 由宿主代管，worker/宿主退出时整树回收。
    const port = await getFreePort()
    pushStatus({ phase: 'checking-node' })
    const node = await resolveNode()
    // 已安装则跳过安装，直接启动（避免重复下载）
    if (!(await isDshInstalled(rpc, node))) {
      pushStatus({ phase: 'installing-dsh' })
      await installDsh(rpc, node, dmsg)
    }
    pushStatus({ phase: 'starting' })
    const { url } = await startDsh(node, port)
    pushStatus({ phase: 'ready', url, startedOnce: true })
    return { ok: true, url }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    pushStatus({ phase: 'error', error: message, startedOnce: current.startedOnce === true })
    return { ok: false, error: message }
  }
})

rpc.registerHandler('dsh.stop', async () => {
  const handle = child
  child = null
  // 宿主代管句柄：kill = 整树回收（taskkill /T 或进程组 SIGKILL），无残留兜底需求
  await handle?.kill()
  // 停止后还原用户 settings.yaml（备份基线）
  await restoreDshSettings()
  pushStatus({ phase: 'idle', startedOnce: true })
  return { ok: true }
})

rpc.registerHandler('dsh.status', () => current)

// chat 面（渲染端 Chat 组件 / 其它插件经 PluginView 挂载后调用）
rpc.registerHandler('dsh.chatStart', async ([options]: [{ workspace?: string }?]) => {
  // 启动前按最近下发的宿主外观同步 settings.yaml（chat 页面启动即用目标语言/主题）
  try {
    await syncDshAppearance(appearanceDesired)
  } catch {
    /* settings 同步失败不阻塞启动 */
  }
  return chat.start(options ?? {})
})
rpc.registerHandler('dsh.chatStatus', () => chat.status())
rpc.registerHandler('dsh.chatStop', async () => chat.stop())

// 进程退出兜底：worker 被宿主回收（应用退出/插件停止）时还原用户 settings.yaml
rpc.onDispose(() => {
  chat.dispose()
  void restoreDshSettings()
})

// dsh web / dsh chat 均由宿主代管（child.spawn + owner 登记）：worker 退出/崩溃 → 宿主 killChildrenByOwner
// 整树回收，无需 worker 侧 exit/signal 清理（旧的 PID 文件 + netstat/taskkill 机制已删）。
