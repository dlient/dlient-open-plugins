/**
 * chat.ts —— dsh chat 面（`dsh --profile dlient-chat`）的安装与进程管理。
 *
 * 该 profile 由内置资产 `assets/dsh-chat-ui/`（@dlient/dsh-chat-ui）提供，资产内容在构建期
 * 经 esbuild 虚拟模块 `dlient:chat-assets` 内联进 worker（见 script/build-worker.mjs）：
 *   - `install.js` 负责把 profile/* 复制到 <DSH_HOME>/profiles/dlient-chat/，
 *     再用 `dsh plugin add file:<pkg>`（pnpm）把包装进该 profile；
 *   - 之后以 `dsh --profile dlient-chat --port <free> [--workspace <path>]` 启动 Web 服务，
 *     并在返回的 URL 上带 `?workspace=<encodeURIComponent(path)>`（客户端据此选中该工作区）。
 *
 * 沙箱合规：worker 自身不碰 node:fs / node:child_process，全部经 host-api
 * （rpc.fs / rpc.child / rpc.net）。**缺 pnpm 会自动装**（同一 node prefix），
 * 因此用户机器上没有 Node.js / pnpm / dsh 也能跑通。
 */

import type { ChildHandle } from '@dlient-open/plugin-sdk'
import { CMD_NODE, CMD_NPM, CMD_PNPM } from '@dlient-open/plugin-sdk'
import { CHAT_ASSETS, CHAT_ASSETS_VERSION } from 'dlient:chat-assets'
import { dirname, join } from 'node:path'
import { envWithNode, hasSpace, npmGlobalPackages, readText, removePath, runHosted, writeText, type MsgFn, type Rpc } from './dsh-runtime'

/** profile 名（与内置 dsh-chat-ui 的 install.js 默认一致） */
const PROFILE_NAME = 'dlient-chat'
/** install.js 需要复制的 profile 组合文件 */
const PROFILE_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']

/** 对外状态（渲染端经 dsh.chatStatus / push 'dsh.chatStatus' 消费） */
export interface ChatStatus {
  phase: 'idle' | 'preparing' | 'installing' | 'starting' | 'ready' | 'error'
  url?: string
  error?: string
  /** 是否启动过：stop 后为 true，渲染端据此区分「从未启动（自动启动）」与「已停止（不自动重启）」 */
  startedOnce?: boolean
}

export interface ChatStartOptions {
  /** 启动时注册并自动打开的工作区目录（透传 `--workspace`） */
  workspace?: string
}

export interface ChatDeps {
  rpc: Rpc
  /** dsh home 解析器（默认真实 `~/.dsh`，与命令行 dsh 共享；可用 DSH_HOME 覆盖） */
  resolveDshHome: () => Promise<string>
  msg: MsgFn
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  resolveNode: () => Promise<string>
  getFreePort: () => Promise<number>
  probePort: (port: number) => Promise<boolean>
  installDsh: (node: string) => Promise<void>
  dshCliPath: (node: string) => Promise<string>
  pushStatus: (status: ChatStatus) => void
}

export interface ChatController {
  start: (options?: ChatStartOptions) => Promise<{ ok: boolean; url?: string; error?: string }>
  status: () => ChatStatus
  stop: () => Promise<{ ok: boolean }>
  dispose: () => void
}

/** npm 全局安装 pnpm 到同一 node prefix（幂等；`dsh plugin` 转发 pnpm 依赖它） */
async function ensurePnpm(rpc: Rpc, msg: MsgFn, node: string, packages: Set<string>): Promise<void> {
  if (packages.has('pnpm')) return
  const { code, out } = await runHosted(rpc, {
    cmd: CMD_NPM,
    args: ['--prefix', dirname(node), 'install', '-g', 'pnpm'],
    env: envWithNode(node),
    timeoutMs: 300000,
    description: 'install pnpm (npm global)',
  })
  if (code !== 0) throw new Error(await msg('pnpmInstallFailed', { code: code ?? 0, out: out.slice(-500) }))
}

/**
 * 兜底安装：路径含空格时 install.js 会用未加引号的 `dsh plugin ... file:` 调 pnpm 而失败，
 * 这里自己做等价两步——复制 profile 组合文件（rpc.fs）+ `pnpm add file:<pkg>`
 * （spawn 传数组不经 shell，空格安全；CMD_PNPM 由宿主解析，PATH 上的 pnpm 优先，
 * 否则回落刚装进 node prefix 的 pnpm.cjs）。
 */
async function installProfileDirect(deps: ChatDeps, node: string, stageDir: string, profileDir: string): Promise<void> {
  for (const file of PROFILE_FILES) {
    const text = await readText(deps.rpc, join(stageDir, 'profile', file))
    if (text === null) throw new Error(await deps.msg('chatAssetsMissing', { path: join(stageDir, 'profile', file) }))
    await writeText(deps.rpc, join(profileDir, file), text)
  }
  await deps.rpc.fs.mkdir(join(profileDir, 'node_modules'))
  const { code, out } = await runHosted(deps.rpc, {
    cmd: CMD_PNPM,
    args: ['add', `file:${stageDir.split('\\').join('/')}`],
    env: envWithNode(node),
    cwd: profileDir,
    timeoutMs: 300000,
    description: `install ${PROFILE_NAME} profile plugin (pnpm)`,
  })
  if (code !== 0) throw new Error(await deps.msg('chatInstallFailed', { code: code ?? 0, out: out.slice(-500) }))
}

/**
 * 把构建期内联的资产写到暂存目录（相对 POSIX 路径 → 内容；rpc.fs.write 自动建父目录）。
 * 写插件 DATA 而非插件安装目录：后者对已安装（market/local）插件只读（且改动会破坏签名）。
 */
async function writeChatAssets(rpc: Rpc, stageDir: string): Promise<void> {
  for (const [rel, content] of Object.entries(CHAT_ASSETS)) {
    await writeText(rpc, join(stageDir, ...rel.split('/')), content)
  }
}

/**
 * 保证 dlient-chat profile 就绪（幂等）：
 *   1) 内联资产 → 插件 DATA 暂存（版本标记命中则整段跳过）
 *   2) 主路径：`node install.js --dsh-home <home>`（先复制 profile 再 pnpm 装包）
 *      兜底：路径含空格时走 installProfileDirect
 */
async function ensureProfile(deps: ChatDeps, node: string, packages: Set<string>): Promise<void> {
  const dataDir = (await deps.rpc.app.getPath('userData')) as string
  const dshHome = await deps.resolveDshHome()
  const stageDir = join(dataDir, 'chat-ui')
  const markerPath = join(dataDir, 'dsh-chat-profile.json')
  const profileDir = join(dshHome, 'profiles', PROFILE_NAME)

  const markerRaw = await readText(deps.rpc, markerPath)
  if (markerRaw !== null) {
    try {
      if (String((JSON.parse(markerRaw) as { version?: string }).version ?? '') === CHAT_ASSETS_VERSION) return
    } catch {
      /* 标记损坏：按未安装处理 */
    }
  }

  deps.log('info', `[dsh] installing ${PROFILE_NAME} profile (assets v${CHAT_ASSETS_VERSION})`)
  // 先清暂存目录，避免上一版残留文件被 pnpm 的 file: 依赖一起打包
  await removePath(deps.rpc, stageDir)
  await writeChatAssets(deps.rpc, stageDir)

  if (hasSpace(stageDir) || hasSpace(dshHome)) {
    deps.log('info', '[dsh] path contains space -> install profile without install.js')
    await installProfileDirect(deps, node, stageDir, profileDir)
  } else {
    await ensurePnpm(deps.rpc, deps.msg, node, packages)
    const { code, out } = await runHosted(deps.rpc, {
      cmd: CMD_NODE,
      args: [join(stageDir, 'install.js'), '--dsh-home', dshHome],
      env: envWithNode(node),
      cwd: stageDir,
      timeoutMs: 300000,
      description: `install ${PROFILE_NAME} profile`,
    })
    if (code !== 0) throw new Error(await deps.msg('chatInstallFailed', { code: code ?? 0, out: out.slice(-500) }))
  }

  await writeText(deps.rpc, markerPath, `${JSON.stringify({ version: CHAT_ASSETS_VERSION, at: Date.now() }, null, 2)}\n`)
}

/** 创建 chat 控制器（进程与状态由本模块持有；渲染端经 dsh.chat* 驱动） */
export function createChatController(deps: ChatDeps): ChatController {
  const { rpc } = deps
  let child: ChildHandle | null = null
  let current: ChatStatus = { phase: 'idle' }
  let workspace: string | undefined
  /** 单飞：并发的 chatStart（多消费方同时挂载 Chat）合并为一次安装/启动 */
  let inflight: Promise<{ ok: boolean; url?: string; error?: string }> | null = null

  const push = (s: ChatStatus): void => {
    current = s
    deps.pushStatus(s)
  }

  async function launch(node: string, port: number): Promise<string> {
    const cli = await deps.dshCliPath(node)
    // DSH_HOME 必须显式传给 dsh 进程：否则它会回落到 ~/.dsh，找不到刚装好的 dlient-chat profile
    const home = await deps.resolveDshHome()
    const args = [cli, '--profile', PROFILE_NAME, '--no-open', '--host', '127.0.0.1', '--port', String(port)]
    // --workspace 把目录注册成真实 workspace group；URL 上的 ?workspace= 再按路径选中它（两者语义不同，需成对使用）
    if (workspace) args.push('--workspace', workspace)
    const url = `http://127.0.0.1:${port}${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`
    const handle = await rpc.child.spawn({
      cmd: CMD_NODE,
      args,
      env: envWithNode(node, { DSH_HOME: home }),
      description: `dsh ${PROFILE_NAME} web server`,
    })
    child = handle
    let output = ''
    handle.onStdout((d: string) => {
      output += d
    })
    handle.onStderr((d: string) => {
      output += d
    })
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const deadline = Date.now() + 120000
      const timer = setInterval(() => {
        void (async () => {
          if (settled) return
          if (await deps.probePort(port)) {
            settled = true
            clearInterval(timer)
            resolve(url)
            return
          }
          if (Date.now() >= deadline) {
            settled = true
            clearInterval(timer)
            if (child === handle) child = null
            reject(new Error(await deps.msg('chatStartTimeout', { out: output.slice(-300) })))
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
      handle.onExit(({ code }: { code: number | null }) => {
        void deps.msg('chatExited', { code: code ?? 0, out: output.slice(-300) }).then((m) => fail(new Error(m)))
      })
      handle.onError((err: Error) => fail(err instanceof Error ? err : new Error(String(err))))
    })
  }

  async function doStart(options?: ChatStartOptions): Promise<{ ok: boolean; url?: string; error?: string }> {
    try {
      workspace = options?.workspace
      push({ phase: 'preparing', startedOnce: current.startedOnce })
      const port = await deps.getFreePort()
      const node = await deps.resolveNode()
      push({ phase: 'installing', startedOnce: current.startedOnce })
      // 一次 npm 全局清单查询同时服务「装 dsh」与「装 pnpm」两个判断
      const packages = await npmGlobalPackages(rpc, node)
      if (!packages.has('@deepseek-ai/dsh')) await deps.installDsh(node)
      await ensureProfile(deps, node, packages)
      push({ phase: 'starting', startedOnce: current.startedOnce })
      const url = await launch(node, port)
      push({ phase: 'ready', url, startedOnce: true })
      return { ok: true, url }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      push({ phase: 'error', error: message, startedOnce: current.startedOnce === true })
      return { ok: false, error: message }
    }
  }

  return {
    start(options) {
      if (child && current.url) return Promise.resolve({ ok: true, url: current.url })
      if (inflight) return inflight
      inflight = doStart(options).finally(() => {
        inflight = null
      })
      return inflight
    },
    status: () => current,
    async stop() {
      const handle = child
      child = null
      await handle?.kill()
      push({ phase: 'idle', startedOnce: true })
      return { ok: true }
    },
    dispose() {
      const handle = child
      child = null
      void handle?.kill()
    },
  }
}
