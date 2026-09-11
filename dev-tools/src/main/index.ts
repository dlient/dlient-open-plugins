/**
 * dev-tools worker 入口（src/main/index.ts）。
 * dev 插件编排：
 *  - plugins.json 数据源：本插件维护 USER_DATA/plugin-data/dev-tools/plugins.json
 *    （app.data 读写 + 内部写队列串行化）；source 恒为 dev，只由本插件增删改。
 *  - 变更后经 plugin.dev.sync 上报宿主：宿主据此启动/停止/重启 worker + 热重载 watch。
 *  - 监听各 dev 插件 package.json：插件开发改 manifest → 同步 plugins.json → 上报宿主。
 *  - 自动 dev：自 spawn 执行 npm run dev（宿主 child.spawn，child-event 流式日志；cwd=dev 目录）。
 *  - 预览：生成 dev 实例（pluginId@dev）信息，UI 用 PluginView 加载。
 */

import { CMD_NPM, createWorkerRpc, PluginError, type ChildHandle, type ResponseErrorMsg } from '@dlient-open/plugin-sdk'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DevErr } from './errors'

const rpc = createWorkerRpc('dev-tools')
/** 插件自有日志：rpc.log.write 写 plugin-data/dev-tools/logs/main.log（声明 manifest.permissions 的 log 即可，
 *  无需 fs 权限）；诊断信息走这里而非 console.log（池模式 stdout 转发到终端不可靠）。 */
const logger = {
  debug: (message: string, data?: unknown) => void rpc.log.write('debug', message, data),
  info: (message: string, data?: unknown) => void rpc.log.write('info', message, data),
  warn: (message: string, data?: unknown) => void rpc.log.write('warn', message, data),
  error: (message: string, data?: unknown) => void rpc.log.write('error', message, data),
}

// ---- 宿主文件访问封装（进程级封禁后 worker 禁裸 node:fs：外部目录读写/探测一律经宿主 fs.*）----

/** stat 摘要（host fs.stat；不存在/失败 → null） */
async function hostStat(path: string): Promise<{ exists: boolean; size: number; mtimeMs: number } | null> {
  try {
    const s = (await rpc.fs.stat(path)) as { size?: number; mtimeMs?: number }
    return { exists: true, size: s?.size ?? 0, mtimeMs: s?.mtimeMs ?? 0 }
  } catch {
    return null
  }
}

/** 目录/文件存在探测（不存在/失败 → false） */
function hostFsExists(path: string): Promise<boolean> {
  return hostStat(path).then((s) => s?.exists === true)
}

/** 读文本（不存在/失败 → null） */
async function hostReadText(path: string): Promise<string | null> {
  try {
    return String(await rpc.fs.read(path))
  } catch {
    return null
  }
}

/** 读原始字节为 base64（不存在/失败 → null） */
async function hostReadBase64(path: string): Promise<string | null> {
  try {
    return String(await rpc.fs.read(path, { base64: true }))
  } catch {
    return null
  }
}

/** 递归建目录（写 assets/ 等前置） */
async function hostMkdir(dir: string): Promise<void> {
  await rpc.fs.mkdir(dir)
}

/** 文本写（父目录须已存在，写前自行 hostMkdir） */
async function hostWriteText(path: string, content: string): Promise<void> {
  await rpc.fs.write(path, content)
}

/** 二进制写（base64；父目录须已存在，写前自行 hostMkdir） */
async function hostWriteBase64(path: string, b64: string): Promise<void> {
  await rpc.fs.write(path, { base64: b64 })
}

/** 解析 manifest 图标：仅接受字符串路径，非字符串返回 undefined */
function parseIcon(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

interface DevPluginEntry {
  id: string
  name: string
  path: string
  dist: string
  version?: string
  type?: string
  system?: boolean
  icon?: string
  /** 授权相关 manifest 指纹（permissions/dependencies/fsDirs/spawnCmds/expose；随 sync 上报宿主，
   *  变更时宿主重启 dev worker + 广播 UI 重载 —— 即使代码未改动也刷新授权） */
  authHash?: string
  addedAt: number
}

interface DirInfo {
  dir: string
  dist: string
}

interface ManifestInfo {
  id?: string
  name?: string
  dist?: string
  version?: string
  type?: string
  system?: boolean
  icon?: string
  source?: string
  nodeVersion?: string
  /** 授权相关 manifest 指纹（供宿主感知「权限类改动」自动重启+UI 重载） */
  authHash?: string
  /** 依赖插件 id 列表（manifest dlient.dependencies 的键；预览前做依赖就绪检查） */
  dependencies?: string[]
  /** package.json scripts（产物推导用：app/full 是否真的产出 worker.js，见 buildArtifacts） */
  scripts?: Record<string, string>
}

// ---- plugins.json 读写（app.data；内部写队列串行化，避免 UI 操作与 package.json watch 并发互踩）----

let writeQueue: Promise<void> = Promise.resolve()

function readPluginsJson(): Promise<DevPluginEntry[]> {
  return rpc.app.data.read('plugins.json').then((data) =>
    Array.isArray(data) ? (data as DevPluginEntry[]) : [],
  )
}

function writePluginsJson(entries: DevPluginEntry[]): Promise<void> {
  writeQueue = writeQueue.then(() => rpc.app.data.write('plugins.json', entries) as Promise<void>)
  return writeQueue
}

/**
 * 首次 dev 清单同步宿主（plugin.dev.sync → 宿主为编排插件登记各 dev 目录 fs 授权）完成后，
 * 外部 dev 目录的 fs.read / fs.write 才被宿主放行。worker ready 后 UI 可能立刻发起
 * dev-tools.list / boot 预检（先于 onReady 的异步同步完成），会命中宿主 fs 白名单拒绝
 * （日志 “fs access denied”）。所有经 fs 读 dev 目录 package.json 的入口统一等此门闩。
 */
let devListSyncGate: Promise<void> = Promise.resolve()
function setDevListSyncGate(p: Promise<void>): void {
  devListSyncGate = p.then(
    () => undefined,
    () => undefined,
  )
}
function awaitDevListSync(): Promise<void> {
  return devListSyncGate
}

/**
 * 目标目录 fs 授权（read+write）：经 permission.request 单目录调用（显式申请读写双档）。
 * 已授权目录直接放行（不重复弹框）；用户拒绝 → 返回 false。
 */
async function ensureDirAccess(dir: string, description: string): Promise<boolean> {
  try {
    const res = (await rpc.permission.request([{ type: 'fs', path: dir, mode: ['read', 'write'] }], description)) as {
      denied?: string[]
    } | null
    return !(res?.denied && res.denied.length > 0)
  } catch (err) {
    logger.warn('ensureDirAccess failed', { dir, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * 批量申请全部 dev 插件目录的读写授权（一次弹框，仅未授权目录入列；已授权短路）。
 * 用户拒绝的目录不纳入 dev-tools 管理：从 plugins.json 移除 + 停 watch + 上报宿主（宿主差量停 worker）。
 * 返回被移除的插件 id 列表。
 */
async function ensureAllDirsGranted(): Promise<string[]> {
  const entries = await readPluginsJson()
  const dirs = entries.map((e) => e.path).filter((p): p is string => !!p)
  if (dirs.length === 0) return []
  const res = (await rpc.permission.request(// dev-tools 管理的目录一律申请读写双档（mode 显式声明，不存在只申请读或写）
      dirs.map((path) => ({ type: 'fs', path, mode: ['read', 'write'] })),
      'dev 插件目录读写（同意后纳入 dev-tools 管理；拒绝的插件将从列表移除）',)
    .catch(() => null)) as { denied?: string[] } | null
  const denied = new Set(res?.denied ?? [])
  if (denied.size === 0) return []
  const removed: string[] = []
  const next = entries.filter((e) => {
    if (!e.path || !denied.has(e.path)) return true
    removed.push(e.id)
    return false
  })
  if (removed.length > 0) {
    await writePluginsJson(next)
    for (const id of removed) {
      // 破坏性操作：注销该插件（停构建进程 + 停 package watch + 退订日志），worker 由宿主 sync 差量停止
      await teardownDevEntry(id)
    }
    await syncToHost(next)
    logger.warn('dev dirs denied, removed from plugins.json', { removed })
  }
  return removed
}

/**
 * 读取某 dev 插件目录失败（用户已撤销该目录读权限 / 目录被删）时，把这条记录从
 * plugin-data/dev-tools/plugins.json 中移除并停 watch、上报宿主，避免 UI 一直报错。
 */
async function dropEntryIfRegistered(dir: string): Promise<void> {
  try {
    const entries = await readPluginsJson()
    const normDir = normalize(dir)
    const hit = entries.find((e) => normalize(String(e.path ?? '')) === normDir)
    if (!hit) return
    const next = entries.filter((e) => e !== hit)
    if (next.length === entries.length) return
    await writePluginsJson(next)
    // 破坏性操作：注销该插件（停构建进程 + 停 package watch + 退订日志），worker 由宿主 sync 差量停止
    await teardownDevEntry(hit.id)
    await syncToHost(next)
    logger.warn('dev entry removed (dir read failed)', { id: hit.id, dir })
  } catch (err) {
    logger.error('dropEntryIfRegistered failed', { dir, error: err instanceof Error ? err.message : String(err) })
  }
}

/** 上报宿主：dev 清单变更后通知宿主刷新缓存 + 启停 watch/worker（主动上报；失败不阻塞） */
async function syncToHost(entries: DevPluginEntry[]): Promise<void> {
  // entries 来自 plugins.json（raw JSON，type 为普通字符串）；宿主侧 plugin.dev.sync 按 PluginType 校验
  await rpc.plugin.dev.sync(entries as unknown as Parameters<typeof rpc.plugin.dev.sync>[0]).catch(() => undefined)
}

/**
 * 从 dev-tools 管理中注销某 dev 插件（删除 plugins.json 条目是破坏性操作，须完整回收）：
 *  停 package.json watch + 停 npm run dev 构建进程；
 *  worker 与热重载 watcher 由宿主 plugin.dev.sync 差量停止（见 dev-plugins.ts syncFromDevRuntime）。
 */
async function teardownDevEntry(id: string): Promise<void> {
  stopPackageWatch(id)
  await stopBuildFor(id)
}

/** 授权相关字段指纹（稳定字段顺序 JSON）：permissions / dependencies / fsDirs / spawnCmds / expose 变化时，
 *  宿主据此重启 dev worker 并广播 UI 重载（见宿主 dev-plugins.syncFromDevRuntime authHash 判定）。 */
function authFingerprint(d: Record<string, unknown>): string {
  return JSON.stringify({
    permissions: d.permissions,
    dependencies: d.dependencies,
    fsDirs: d.fsDirs,
    spawnCmds: d.spawnCmds,
    expose: d.expose,
  })
}

/** 读取插件目录 package.json 的 dlient 字段（等首次 sync 门闩，避免宿主 fs 白名单拒绝）。
 *  **先申请目录读写授权再操作**：dev-tools 对目录一律按 read+write 双档申请（permission.request
 *  对已授权目录直接放行，不重复弹框），不存在只申请读或写；拒绝 / 读取失败 → 删除记录兜底。 */
async function readManifest(dir: string): Promise<ManifestInfo | null> {
  if (!(await ensureDirAccess(dir, 'dev 插件目录读写（同意后纳入 dev-tools 管理）'))) {
    logger.warn('readManifest denied dir access', { dir })
    void dropEntryIfRegistered(dir)
    return null
  }
  try {
    await awaitDevListSync()
    const raw = await rpc.fs.read(`${dir}/package.json`)
    const pkg = JSON.parse(String(raw)) as Record<string, unknown> & { version?: string; dlient?: Record<string, unknown> }
    const d = pkg.dlient ?? {}
    return {
      id: typeof d.id === 'string' ? d.id : undefined,
      name: typeof d.name === 'string' ? d.name : (d.name as Record<string, string> | undefined)?.default,
      dist: typeof d.dist === 'string' ? d.dist : undefined,
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
      type: typeof d.type === 'string' ? d.type : undefined,
      system: d.system === true,
      icon: parseIcon(d.icon),
      source: typeof d.source === 'string' ? d.source : undefined,
      nodeVersion: typeof d.nodeVersion === 'string' ? d.nodeVersion : undefined,
      authHash: authFingerprint(d),
      scripts: pkg.scripts && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, string>) : undefined,
      dependencies: Array.isArray(d.dependencies)
        ? d.dependencies.map((x) => String(x))
        : d.dependencies && typeof d.dependencies === 'object'
          ? Object.keys(d.dependencies as Record<string, unknown>)
          : undefined,
    }
  } catch (err) {
    // 读取失败（权限被撤 / 目录失效 / JSON 解析）→ 若该目录是已注册 dev 插件，则从 plugins.json 移除该条记录
    logger.warn('readManifest failed', { dir, error: err instanceof Error ? err.message : String(err) })
    void dropEntryIfRegistered(dir)
    return null
  }
}

/** 按插件类型 + 构建脚本推导构建产物：
 *  - worker 类型：仅 worker.js（无 UI）；
 *  - ui 类型：仅 remoteEntry.js（无 worker）；
 *  - app / full：必有 UI；是否产 worker.js 以 package.json 是否声明 build:worker 脚本为准——
 *    纯 UI 的 app（无 build:worker）不产 worker，不能按 type 推断为「需要 worker」，
 *    否则 ensureDeps / ensureEnv / refresh 会等一个永不存在的 worker.js（build:worker 失败或 30s 超时）。
 *  - 脚本信息缺失（读 manifest 失败等）时维持旧口径（按需 worker），避免误判已有插件。 */
function buildArtifacts(
  type: string | undefined,
  scripts?: Record<string, string>,
): { hasUI: boolean; needsWorker: boolean } {
  const t = type ?? 'ui'
  const hasUI = t !== 'worker'
  if (t === 'ui') return { hasUI, needsWorker: false }
  if (t === 'worker') return { hasUI, needsWorker: true }
  // 以 build:worker 脚本为准：ensureDeps / refresh 都会显式 `npm run build:worker`，
  // 该脚本缺失即视为不产 worker（能同时避免等一个永不出现的 worker.js）
  const hasWorkerScript = scripts ? typeof scripts['build:worker'] === 'string' : true
  return { hasUI, needsWorker: hasWorkerScript }
}

// ---- package.json 变更监听（插件开发改 manifest → 同步 plugins.json → 上报宿主）----
// 进程级封禁下 worker 禁裸 node:fs watch：监听经宿主 fs.watch（事件回调本插件 dev-tools.fs-watch-event）。

const pkgWatchers = new Map<string, string>() // pluginId → 宿主 watchId
const pkgTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 本插件写回 package.json 的时刻（id → ts）：用于抑制自写触发的 watcher 回环 */
const pkgWriteAt = new Map<string, number>()
/** 自写抑制窗口（ms）：需大于 watch 防抖间隔，覆盖 fs 事件抵达的延迟 */
const SELF_WRITE_WINDOW = 1500

function stopPackageWatch(id: string): void {
  const watchId = pkgWatchers.get(id)
  if (watchId) {
    pkgWatchers.delete(id)
    void rpc.fs.unwatch(watchId).catch(() => undefined)
  }
  const t = pkgTimers.get(id)
  if (t) {
    clearTimeout(t)
    pkgTimers.delete(id)
  }
}

async function watchPackageJson(entry: DevPluginEntry): Promise<void> {
  stopPackageWatch(entry.id)
  if (!(await hostFsExists(join(entry.path, 'package.json')))) return
  try {
    const watchId = String(await rpc.fs.watch(entry.path))
    pkgWatchers.set(entry.id, watchId)
  } catch {
    /* watch 失败忽略（目录可能被移除） */
  }
}

/** 宿主 fs.watch 事件回调：watchId → 目标 dev 插件的 package.json 顶层变更 → 防抖同步 plugins.json */
rpc.registerHandler('dev-tools.fs-watch-event', ([watchId, filename]) => {
  if (String(filename ?? '').replace(/\\/g, '/') !== 'package.json') return
  const id = Array.from(pkgWatchers.entries()).find(([, wid]) => wid === watchId)?.[0]
  if (!id) return
  const existing = pkgTimers.get(id)
  if (existing) clearTimeout(existing)
  pkgTimers.set(
    id,
    setTimeout(async () => {
      pkgTimers.delete(id)
      // 本插件刚写回过（writeSettings 已自行同步）→ 跳过，避免回环
      const wrote = pkgWriteAt.get(id)
      if (wrote && Date.now() - wrote < SELF_WRITE_WINDOW) {
        pkgWriteAt.delete(id)
        return
      }
      try {
        const entries = await readPluginsJson()
        const cur = entries.find((e) => e.id === id)
        if (!cur) return
        const m = await readManifest(cur.path)
        if (!m) return
        const updated: DevPluginEntry = {
          ...cur,
          name: m.name ?? cur.name,
          version: m.version,
          type: m.type as DevPluginEntry['type'],
          dist: m.dist ?? cur.dist,
          system: m.system === true,
          icon: m.icon,
          authHash: m.authHash,
        }
        const next = entries.map((e) => (e.id === id ? updated : e))
        await writePluginsJson(next)
        await syncToHost(next)
      } catch (err) {
        logger.error('sync package.json failed', { pluginId: id, error: err instanceof Error ? err.message : String(err) })
      }
    }, 500),
  )
})

// ---- CRUD（plugins.json 是本插件数据源）----

rpc.registerHandler('dev-tools.list', async () => {
  const entries = await readPluginsJson()
  return entries.sort((a, b) => a.addedAt - b.addedAt)
})

/** 选目录即授权（read+write）：弹系统目录选择框，选中即经 authorizeFsAccess 授读写双档 */
async function pickDevDir(): Promise<string | null> {
  const res = (await rpc.dialog.showOpenDialog(['fs.read', 'fs.write'], { properties: ['openDirectory'] })
    .catch(() => null)) as { filePaths?: string[] } | null
  return res?.filePaths?.[0] ?? null
}

rpc.registerHandler('dev-tools.selectDirectory', () => pickDevDir())

/**
 * 导入预检：确认目录可作为 dev 插件导入。
 *  - 无有效 manifest / id 非法 → { ok:false }（渲染层据此弹「导入失败」错误框）；
 *  - source 非 'dev' → needsDevChange=true（渲染层弹确认框，确认后先 changeToDev 再 register）。
 */
rpc.registerHandler('dev-tools.checkImportable', async ([pluginPath]) => {
  const dir = String(pluginPath ?? '').trim()
  if (!dir) return { ok: false, error: { enUS: 'Plugin directory cannot be empty', zhCN: '插件目录不能为空' } }
  // 用户选择了目录 → 先弹权限申请框，同意后才能读取该目录
  if (!(await ensureDirAccess(dir, '导入插件目录'))) {
    return { ok: false, error: { enUS: 'Canceled: no access permission granted to this directory', zhCN: '已取消：未授予该目录的访问权限' } }
  }
  const m = await readManifest(dir)
  if (!m?.id) {
    return { ok: false, error: { enUS: 'No valid plugin manifest found in the directory (dlient.id in package.json)', zhCN: '目录中未找到有效的插件 manifest（package.json 的 dlient.id）' } }
  }
  if (!/^[a-z0-9-]+$/.test(m.id)) {
    return { ok: false, error: { enUS: `Invalid plugin ID (only lowercase letters, digits and hyphens allowed, current: ${m.id})`, zhCN: `插件 ID 不合法（仅允许小写字母、数字、连字符，当前：${m.id}）` } }
  }
  return { ok: true, needsDevChange: m.source !== 'dev', id: m.id, name: m.name ?? m.id }
})

/** 把目录 package.json 的 dlient.source 改为 'dev'（导入确认后调用；保留缩进与未知字段）。
 *  未注册前无 package.json watcher，无需抑制回环。 */
rpc.registerHandler('dev-tools.changeToDev', async ([pluginPath]) => {
  const dir = String(pluginPath ?? '').trim()
  if (!dir) throw new PluginError(DevErr.INVALID_ARG, { enUS: 'Plugin directory cannot be empty', zhCN: '插件目录不能为空' })
  if (!(await ensureDirAccess(dir, '写回插件 manifest（dlient.source=dev）'))) {
    throw new PluginError(DevErr.PERMISSION_DENIED, { enUS: 'Canceled: no access permission granted to this directory', zhCN: '已取消：未授予该目录的访问权限' })
  }
  const raw = String(await rpc.fs.read(`${dir}/package.json`).catch(() => ''))
  if (!raw) throw new PluginError(DevErr.PACKAGE_INVALID, { enUS: 'No package.json found in the directory', zhCN: '目录中未找到 package.json' })
  const pkg = JSON.parse(raw) as Record<string, unknown> & { dlient?: Record<string, unknown> }
  const dlient = { ...(pkg.dlient ?? {}) }
  if (dlient.source === 'dev') return { ok: true, changed: false }
  dlient.source = 'dev'
  await rpc.fs.write(`${dir}/package.json`, `${JSON.stringify({ ...pkg, dlient }, null, detectIndent(raw))}\n`)
  return { ok: true, changed: true }
})

/** 注册 dev 插件目录（校验 source=dev → 写 plugins.json → watch package.json → 上报宿主） */
async function doRegister(pluginPath: string): Promise<DevPluginEntry> {
  const dir = String(pluginPath ?? '').trim()
  if (!dir) throw new PluginError(DevErr.INVALID_ARG, { enUS: 'Plugin directory cannot be empty', zhCN: '插件目录不能为空' })
  const m = await readManifest(dir)
  if (!m?.id) throw new PluginError(DevErr.PACKAGE_INVALID, { enUS: 'No valid plugin manifest found in the directory (dlient.id in package.json)', zhCN: '目录中未找到有效的插件 manifest（package.json 的 dlient.id）' })
  // dev runtime 只管理 dev 插件：尊重 manifest.source
  if (m.source !== 'dev') {
    throw new PluginError(
      DevErr.PACKAGE_INVALID,
      {
        enUS: `This plugin is not a dev plugin (dlient.source="${m.source ?? 'unset'}"). Change dlient.source in package.json to "dev" and add it again.`,
        zhCN: `该插件不是 dev 插件（dlient.source="${m.source ?? '未声明'}"）。请将 package.json 的 dlient.source 改为 "dev" 后重新添加。`,
      },
    )
  }
  if (!/^[a-z0-9-]+$/.test(m.id)) {
    throw new PluginError(DevErr.INVALID_ARG, {
      enUS: `Invalid plugin ID (only lowercase letters, digits and hyphens allowed, current: ${m.id}). Edit dlient.id in package.json`,
      zhCN: `插件 ID 不合法（仅允许小写字母、数字、连字符，当前：${m.id}），请修改 package.json 的 dlient.id`,
    })
  }
  const entries = await readPluginsJson()
  const exists = entries.find((e) => e.id === m.id)
  const entry: DevPluginEntry = {
    id: m.id,
    name: m.name ?? m.id,
    path: dir,
    dist: m.dist ?? 'dist',
    version: m.version,
    type: m.type as DevPluginEntry['type'],
    system: m.system === true,
    icon: m.icon,
    authHash: m.authHash,
    addedAt: exists?.addedAt ?? Date.now(),
  }
  const next = exists ? entries.map((e) => (e.id === entry.id ? entry : e)) : [...entries, entry]
  await writePluginsJson(next)
  await watchPackageJson(entry)
  await syncToHost(next)
  return entry
}

rpc.registerHandler('dev-tools.register', ([pluginPath]) => doRegister(String(pluginPath)))

rpc.registerHandler('dev-tools.remove', async ([pluginId]) => {
  const id = String(pluginId)
  const entries = await readPluginsJson()
  const next = entries.filter((e) => e.id !== id)
  if (next.length === entries.length) return { ok: false, error: { enUS: `Dev plugin not registered: ${id}`, zhCN: `dev 插件未注册: ${id}` } }
  await writePluginsJson(next)
  // 破坏性操作：注销该插件（停构建进程 + 停 package watch + 退订日志），worker 由宿主 sync 差量停止
  await teardownDevEntry(id)
  await syncToHost(next)
  return { ok: true }
})

/** 查询 dev 插件目录信息：优先 plugins.json（dev-runtime 数据源），未命中回退宿主 plugin.dev.getDirInfo */
async function getDirInfo(pluginId: string): Promise<DirInfo | null> {
  const entries = await readPluginsJson()
  const entry = entries.find((e) => e.id === pluginId)
  if (entry) return { dir: entry.path, dist: entry.dist }
  return (await rpc.plugin.dev.getDirInfo(pluginId)) as DirInfo | null
}

rpc.registerHandler('dev-tools.getDirInfo', ([pluginId]) => getDirInfo(String(pluginId)))

// ---- 设置：读写目标插件 package.json 的 dlient 字段（白名单，保留未知字段与缩进）----

/** 设置页可编辑的 manifest 字段白名单：其余字段（id/source/permissions/expose/...）不允许经 UI 改写 */
const EDITABLE_KEYS = ['name', 'description', 'type', 'platforms', 'icon', 'tags'] as const
type EditableKey = (typeof EDITABLE_KEYS)[number]

/** 读取目标插件目录 package.json 原文（缺失即视为未初始化目录） */
async function readPkgRaw(pluginId: string): Promise<{ dir: string; raw: string }> {
  const info = await getDirInfo(pluginId)
  if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${pluginId}`, zhCN: `dev 插件不存在: ${pluginId}` })
  const raw = String(await rpc.fs.read(`${info.dir}/package.json`))
  return { dir: info.dir, raw }
}

/** 探测原文缩进（保留手写风格；未探测到按 2 空格） */
function detectIndent(raw: string): string | number {
  const m = /\n([ \t]+)"/.exec(raw)
  if (!m) return 2
  return m[1].includes('\t') ? '\t' : m[1].length
}

rpc.registerHandler('dev-tools.readSettings', async ([pluginId]) => {
  const { dir, raw } = await readPkgRaw(String(pluginId))
  const pkg = JSON.parse(raw) as Record<string, unknown> & { version?: string; dlient?: Record<string, unknown> }
  const d = pkg.dlient ?? {}
  const picked: Record<string, unknown> = {}
  for (const k of EDITABLE_KEYS) if (d[k] !== undefined) picked[k] = d[k]
  return {
    dir,
    version: typeof pkg.version === 'string' ? pkg.version : undefined,
    id: typeof d.id === 'string' ? d.id : undefined,
    dlient: picked,
  }
})

rpc.registerHandler('dev-tools.writeSettings', async ([pluginId, patch]) => {
  const id = String(pluginId)
  const input = (patch ?? {}) as Record<string, unknown>
  const { dir, raw } = await readPkgRaw(id)
  const pkg = JSON.parse(raw) as Record<string, unknown> & { version?: string; dlient?: Record<string, unknown> }
  const dlient = { ...(pkg.dlient ?? {}) }
  let changed = false
  for (const k of EDITABLE_KEYS) {
    if (!(k in input)) continue
    const next = input[k as EditableKey]
    // undefined/null 视为删除该可选字段（如清空 tags）
    if (next === undefined || next === null) {
      if (k in dlient) {
        delete dlient[k]
        changed = true
      }
      continue
    }
    if (JSON.stringify(dlient[k]) !== JSON.stringify(next)) {
      dlient[k] = next
      changed = true
    }
  }
  if (!changed) return { ok: true, changed: false }
  const next = JSON.stringify({ ...pkg, dlient }, null, detectIndent(raw))
  // 抑制窗口：写回会触发自身 watcher，下面已手工同步 plugins.json，避免防抖回调重复写入成环
  pkgWriteAt.set(id, Date.now())
  await rpc.fs.write(`${dir}/package.json`, `${next}\n`)
  // 同步 plugins.json 展示字段并上报宿主（与 watchPackageJson 的同步逻辑一致）
  const m = await readManifest(dir)
  if (m) {
    const entries = await readPluginsJson()
    const cur = entries.find((e) => e.id === id)
    if (cur) {
      const updated: DevPluginEntry = {
        ...cur,
        name: m.name ?? cur.name,
        version: m.version,
        type: m.type as DevPluginEntry['type'],
        dist: m.dist ?? cur.dist,
        system: m.system === true,
        icon: m.icon,
        authHash: m.authHash,
      }
      const list = entries.map((e) => (e.id === id ? updated : e))
      await writePluginsJson(list)
      await syncToHost(list)
    }
  }
  return { ok: true, changed: true }
})

/**
 * 写入插件图标资源（设置页图片上传用）：
 *  - fileName 仅允许 assets/ 下规范命名（icon.svg / icon.png / icon-<slot>.png），防路径穿越；
 *  - data 为 base64 文本，解码后 ≤200KB（渲染层已校验尺寸/正方形/压缩，此处兜底）。
 * 写源 assets/ 目录（协议层 dlientOpen://plugin/<id>/assets/… 可读），不触发 dist watcher。
 */
rpc.registerHandler('dev-tools.writeAsset', async ([pluginId, fileName, data]) => {
  const id = String(pluginId)
  const name = String(fileName ?? '')
  if (!/^icon[\w-]*\.(svg|png)$/.test(name)) {
    throw new PluginError(DevErr.INVALID_ARG, { enUS: `Invalid icon file name: ${name}`, zhCN: `非法的图标文件名: ${name}` })
  }
  const info = await getDirInfo(id)
  if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` })
  const buf = Buffer.from(String(data ?? ''), 'base64')
  if (buf.length === 0 || buf.length > 200 * 1024) {
    throw new PluginError(DevErr.INVALID_ARG, { enUS: 'Icon content is invalid or exceeds 200KB', zhCN: '图标内容非法或超过 200KB' })
  }
  const dir = join(info.dir, 'assets')
  await hostMkdir(dir)
  await hostWriteBase64(join(dir, name), String(data ?? ''))
  logger.info(`writeAsset ${id} ${name} ${buf.length}B`)
  return { ok: true, path: `assets/${name}` }
})

// ---- 图标读取：读取 assets/ 下的图标文件为 base64（用于图片展示） ----

rpc.registerHandler('dev-tools.readAsset', async ([pluginId, fileName]) => {
  const id = String(pluginId)
  const name = String(fileName ?? '')
  if (!/^icon[\w-]*\.(svg|png)$/.test(name)) {
    throw new PluginError(DevErr.INVALID_ARG, { enUS: `Invalid icon file name: ${name}`, zhCN: `非法的图标文件名: ${name}` })
  }
  const info = await getDirInfo(id)
  if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` })
  const filePath = join(info.dir, 'assets', name)
  const b64 = await hostReadBase64(filePath)
  if (b64 == null || b64.length === 0) return { ok: true, data: '', mime: '', exists: false }
  const mime = name.endsWith('.png') ? 'image/png' : 'image/svg+xml'
  return { ok: true, data: b64, mime, exists: true }
})

// ---- Markdown 读写：编辑 assets/ 下的 index.md / index.zh-CN.md / index.en-US.md ----

/** 允许读写的 markdown 文件名白名单（防路径穿越） */
const MARKDOWN_WHITELIST = ['index.md', 'index.zh-CN.md', 'index.en-US.md', 'SKILL.md'] as const

rpc.registerHandler('dev-tools.readMarkdown', async ([pluginId, fileName]) => {
  const id = String(pluginId)
  const name = String(fileName ?? '')
  if (!MARKDOWN_WHITELIST.includes(name as (typeof MARKDOWN_WHITELIST)[number])) {
    throw new PluginError(DevErr.INVALID_ARG, { enUS: `Invalid markdown file name: ${name}`, zhCN: `非法的 markdown 文件名: ${name}` })
  }
  const info = await getDirInfo(id)
  if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` })
  const filePath = join(info.dir, 'assets', name)
  try {
    const content = String(await rpc.fs.read(filePath))
    return { ok: true, content, exists: true }
  } catch {
    // 文件不存在时返回空内容（前端按需创建）
    return { ok: true, content: '', exists: false }
  }
})

rpc.registerHandler('dev-tools.writeMarkdown', async ([pluginId, fileName, content]) => {
  const id = String(pluginId)
  const name = String(fileName ?? '')
  if (!MARKDOWN_WHITELIST.includes(name as (typeof MARKDOWN_WHITELIST)[number])) {
    throw new PluginError(DevErr.INVALID_ARG, { enUS: `Invalid markdown file name: ${name}`, zhCN: `非法的 markdown 文件名: ${name}` })
  }
  const info = await getDirInfo(id)
  if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` })
  const dir = join(info.dir, 'assets')
  await hostMkdir(dir)
  await hostWriteText(join(dir, name), String(content ?? ''))
  logger.info(`writeMarkdown ${id} ${name} ${String(content ?? '').length}B`)
  return { ok: true }
})

// ---- 模板创建（自持）：选择目录 → 执行 @dlient-open/create-plugin 生成模板 → 注册 dev 插件 ----

/** 检测 nodejs 环境：经内置 nodejs.resolveRuntime 判定（内置运行时可优先，本机 PATH 兜底）。
 *  dev-tools 的 npm 一律经 CMD_NPM 别名执行（宿主解析为真实可执行文件），故两种来源都可用。
 *  开源版 nodejs 并入宿主主进程（非插件），不存在「nodejs 插件缺失」。 */
async function checkNodejsEnv(
  requiredVersion?: string,
): Promise<{ ok: true; version?: string } | { ok: false; reason: 'runtime-missing' }> {
  const rt = (await rpc.nodejs
    .resolveRuntime(requiredVersion ? { version: requiredVersion } : undefined)
    .catch(() => null)) as { source?: 'bundled' | 'path' | 'none'; version?: string } | null
  if (rt == null || rt.source === 'none') return { ok: false, reason: 'runtime-missing' }
  return { ok: true, version: rt.version }
}

/** 解析 node 版本要求中的数字部分（"22" / ">=22" / "22.11" → [22,11,0]）；解析失败返回 null */
function parseReqVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.?(\d+)?\.?(\d+)?/.exec(v.trim().replace(/^>=?/, ''))
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** 读取本插件自身 package.json 的 dlient.nodeVersion（构建 dev 插件同样需要 Node 运行时） */
async function readOwnManifest(): Promise<ManifestInfo | null> {
  try {
    // worker 位于 <pluginRoot>/dist/worker.js → 上一级即插件根目录
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const raw = await rpc.fs.read(pkgPath)
    const pkg = JSON.parse(String(raw)) as { dlient?: Record<string, unknown> }
    const d = pkg.dlient ?? {}
    return { nodeVersion: typeof d.nodeVersion === 'string' ? d.nodeVersion : undefined }
  } catch {
    return null
  }
}

/** 计算开发环境所需的 Node 最低版本：自身 manifest + 全部已注册 dev 插件取最大（undefined=无门槛） */
async function requiredNodeVersion(): Promise<string | undefined> {
  const own = await readOwnManifest()
  const list: Array<string | undefined> = [own?.nodeVersion]
  const entries = await readPluginsJson()
  for (const e of entries) {
    const m = await readManifest(e.path)
    if (m?.nodeVersion) list.push(m.nodeVersion)
  }
  let best: string | undefined
  let bestNums: number[] | null = null
  for (const v of list) {
    if (!v) continue
    const nums = parseReqVersion(v)
    if (!nums) continue
    if (!bestNums || (nums[0] > bestNums[0]) || (nums[0] === bestNums[0] && nums[1] > bestNums[1]) || (nums[0] === bestNums[0] && nums[1] === bestNums[1] && nums[2] > bestNums[2])) {
      best = v
      bestNums = nums
    }
  }
  return best
}

/** nodejs 运行时缺失时的直白提示 */
function nodejsMissingMessage(): ResponseErrorMsg {
  return {
    enUS: 'No Node.js runtime detected. Install system Node.js, or install the host-bundled runtime via nodejs.install, then retry.',
    zhCN: '未检测到 Node.js 运行环境，请安装系统 Node.js 或安装宿主内置运行时后重试',
  }
}

/** 供 UI 打开页面时检测 node 环境：ready=false 时 UI 提供「安装内置运行时」；
 *  requiredVersion 为当前开发环境所需的 Node 最低版本（自身 + dev 插件声明取最大），作为安装/校验门槛 */
rpc.registerHandler('dev-tools.checkNode', async () => {
  // 批量授权：拒绝的目录从 plugins.json 移除并停 worker（未授权插件不纳入管理）
  await ensureAllDirsGranted()
  const requiredVersion = await requiredNodeVersion()
  const env = await checkNodejsEnv(requiredVersion)
  return {
    ready: env.ok,
    reason: env.ok ? undefined : env.reason,
    version: env.ok ? env.version : undefined,
    requiredVersion,
  }
})

/** 安装宿主内置 Node.js 运行时（开源版 nodejs 并入宿主主进程，经 nodejs.install 直连：
 *  单飞、下载解压到 userData/plugin-data/nodejs；level=warn，首次调用由宿主向用户确认授权） */
rpc.registerHandler('dev-tools.installNode', async ([version]) => {
  const v = typeof version === 'string' && version ? version : undefined
  const res = (await rpc.nodejs.install(v)) as { ok?: boolean; version?: string; error?: string } | null
  if (!res?.ok) {
    throw new PluginError(DevErr.NODEJS_MISSING, {
      enUS: `Failed to install the bundled Node.js runtime${res?.error ? `: ${res.error}` : ''}`,
      zhCN: `安装宿主内置 Node.js 运行时失败${res?.error ? `：${res.error}` : ''}`,
    })
  }
  return { ok: true, version: res.version }
})

/** 拉取市场已审核插件列表。开源版无插件市场服务端 → 恒返回空（不做市场重名校验） */
async function fetchMarketList(): Promise<Array<Record<string, unknown>>> {
  return []
}

/** 市场插件名称字段（字符串或本地化对象）是否与目标名称一致 */
function nameMatches(field: unknown, name: string): boolean {
  if (typeof field === 'string') return field === name
  if (field && typeof field === 'object') {
    return Object.values(field as Record<string, unknown>).some((v) => v === name)
  }
  return false
}

/** 创建后写入插件显示名（dlient.name；顶层 npm name 保持为 id）：写目标目录经宿主 fs.* */
async function setPluginDisplayName(dir: string, name: string): Promise<void> {
  const pkgPath = join(dir, 'package.json')
  const raw = await hostReadText(pkgPath)
  if (raw == null) return
  const pkg = JSON.parse(raw) as Record<string, unknown> & { dlient?: Record<string, unknown> }
  pkg.dlient = { ...(pkg.dlient ?? {}), name }
  await hostWriteText(pkgPath, JSON.stringify(pkg, null, 2))
}

/** 创建插件默认超时（npx 首次需从 registry 拉取 @dlient-open/create-plugin 再生成模板；超时 kill 附输出定位卡住）。 */
const CREATE_PLUGIN_TIMEOUT_MS = 180_000

/** 创建插件所用的 npm 包（单一来源：CLI + 模板均随该包发布，不再内置 dist/scaffold 拷贝） */
const CREATE_PLUGIN_SPEC = '@dlient-open/create-plugin'

/**
 * 创建插件模板：以 npx 语义直接执行 npm 上的 @dlient-open/create-plugin
 * （经 CMD_NPM 别名 → `node <npm-cli.js> exec --yes -- @dlient-open/create-plugin <id> --dir <base> --skip-install --no-git`）。
 * 宿主 child.spawn + child-event 收集输出；超时 kill 并附输出定位卡住/慢。
 */
async function runCreatePlugin(id: string, base: string, timeoutMs = CREATE_PLUGIN_TIMEOUT_MS): Promise<{ ok: boolean; detail?: string }> {
  let handle: ChildHandle
  try {
    handle = await rpc.child.spawn({
      cmd: CMD_NPM,
      args: ['exec', '--yes', '--', CREATE_PLUGIN_SPEC, id, '--dir', base, '--skip-install', '--no-git'],
      cwd: base,
    })
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err).slice(0, 300) }
  }
  let out = ''
  handle.onStdout((d) => (out += d))
  handle.onStderr((d) => (out += d))
  const info = await awaitHandle(handle, timeoutMs)
  if (info.reason === 'timeout') {
    return { ok: false, detail: `创建插件超时（${Math.round(timeoutMs / 1000)}s）${out.trim() ? `：${out.trim().slice(0, 300)}` : ''}` }
  }
  const detail = out.trim()
  if (info.code !== 0) return { ok: false, detail: (detail || `exit ${info.code}`).slice(0, 500) }
  return { ok: true }
}

rpc.registerHandler('dev-tools.devCreatePlugin', async ([pluginId, pluginName]) => {
  const id = String(pluginId ?? '').trim()
  const name = String(pluginName ?? '').trim()
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new PluginError(DevErr.INVALID_ARG, {
      enUS: 'Invalid plugin ID (must start with a lowercase letter; lowercase letters/digits/hyphens only)',
      zhCN: '插件 ID 不合法（须以小写字母开头，仅含小写字母/数字/连字符）',
    })
  }
  if (!name) throw new PluginError(DevErr.INVALID_ARG, { enUS: 'Plugin name cannot be empty', zhCN: '插件名称不能为空' })

  // 市场重名校验：ID 或名称任一与市场已审核插件重复 → 无法创建
  const market = await fetchMarketList()
  const idDup = market.some((p) => String(p.id ?? '') === id)
  const nameDup = market.some((p) => nameMatches(p.name, name))
  if (idDup || nameDup) {
    const whichEn = idDup && nameDup ? 'ID and name' : idDup ? 'ID' : 'name'
    const whichZh = idDup && nameDup ? 'ID 和名称' : idDup ? 'ID' : '名称'
    const dupVal = idDup ? id : name
    throw new PluginError(DevErr.DUPLICATE, {
      enUS: `A plugin with this ${whichEn} ("${dupVal}") already exists in the plugin market and cannot be created`,
      zhCN: `插件${whichZh}「${dupVal}」已存在于插件市场，无法创建`,
    })
  }

  // 本地去重（防御）：已注册 dev 插件 / 已安装插件 id 不得重复
  const [dev, installed] = await Promise.all([
    readPluginsJson(),
    rpc.plugin.scanInstalled().catch(() => []),
  ])
  const localDup = [...(dev as Array<{ id: string }>), ...((installed as Array<{ id: string }>) ?? [])].some(
    (e) => e.id === id,
  )
  if (localDup) throw new PluginError(DevErr.DUPLICATE, { enUS: `A plugin with the same ID "${id}" already exists locally and cannot be created`, zhCN: `本地已存在同名插件「${id}」，无法创建` })

  const base = await pickDevDir()
  if (!base) return null
  // 新增插件：选择根目录时已通过 dialog.showOpenDialog 申请读写授权（pickDevDir），无需额外弹框
  // 直接执行 npm 上的 @dlient-open/create-plugin 生成模板（宿主 child.spawn + child-event 收集输出，超时由 runCreatePlugin 回收）
  const res = await runCreatePlugin(id, base)
  if (!res.ok) throw new PluginError(DevErr.BUILD_FAIL, { enUS: `Failed to create plugin: ${res.detail}`, zhCN: `创建插件失败：${res.detail}` })
  // 写入用户提供的插件显示名（dlient.name；顶层 npm name 保持为 id）
  await setPluginDisplayName(join(base, id), name)
  // 模板 package.json 的 dlient.source 为 'dev'，注册走本插件 register（写 plugins.json + 上报宿主）
  return doRegister(join(base, id))
})

// ---- 状态同步（生命周期 12.3.5-①）：所有实例运行时状态（worker 状态，dev 实例以 '<id>@dev' 键）----

rpc.registerHandler('dev-tools.runtimeStates', () => rpc.plugin.runtimeList())

// ---- 预览：dev 实例（pluginId@dev，F3 双版本并存）----

rpc.registerHandler('dev-tools.previewInfo', async ([pluginId]) => {
  const id = String(pluginId)
  const info = await getDirInfo(id)
  const m = info ? await readManifest(info.dir) : null
  // hasUI：worker 类型无界面（无 remoteEntry），渲染层预览 pane 显示占位而非加载不存在的 UI
  const hasUI = (m?.type ?? 'ui') !== 'worker'
  // 依赖就绪检查：开源版无插件市场，缺失的依赖插件无法自动安装 → 预览页直接给出提示，
  // 不挂载必然加载失败的 PluginView。（'nodejs' 为运行时占位、由宿主内置 nodejs.* 提供，不计入依赖）
  const required = (m?.dependencies ?? []).filter((d) => d !== 'nodejs')
  let missingDeps: string[] = []
  if (required.length > 0) {
    const installed = (await rpc.plugin.scanInstalled().catch(() => [])) as Array<{ id?: string }> | null
    const have = new Set((installed ?? []).map((p) => String(p?.id ?? '')))
    missingDeps = required.filter((d) => !have.has(d))
  }
  return {
    pluginId: `${id}@dev`,
    remoteEntryUrl: `dlientOpen://plugin/${id}@dev/dist/remoteEntry.js`,
    hasUI,
    missingDeps,
  }
})

// ---- 自动 dev：自 spawn（宿主 child.spawn + child-event 流式日志）----
// 进程级封禁下 worker 不再借 nodejs 代理执行：node/npm 以内置运行时（NODEJS 白名单）自 spawn，
// 执行身份归 dev-tools 自身，由宿主按 dev-tools manifest.permissions（child.spawn）+ 白名单裁决。

interface DevBuildRec {
  procId: string // = child.spawn handleId
  caller: string
  kind: string
  pid: number
  status: 'running' | 'exited' | 'error'
  cwd: string
  startedAt: number
}

interface DevLogLine {
  ts: number
  stream: 'stdout' | 'stderr'
  data: string
}

/** pluginId → 构建句柄（宿主代管子进程） */
const buildHandles = new Map<string, ChildHandle>()
/** pluginId → 构建记录（UI dev-tools.listBuilds 读） */
const buildRecs = new Map<string, DevBuildRec>()
/** pluginId → 构建行缓冲（UI dev-tools.log 读；环形上限） */
const buildLines = new Map<string, DevLogLine[]>()
/** pluginId → npm run dev 启动时刻（ensureEnv / refresh 等待初始构建完成的 mtime 基准） */
const devStartAt = new Map<string, number>()

const BUILD_LOG_MAX = 5000

function appendBuildLine(id: string, stream: 'stdout' | 'stderr', data: string): void {
  if (!data) return
  const list = buildLines.get(id) ?? []
  list.push({ ts: Date.now(), stream, data })
  if (list.length > BUILD_LOG_MAX) list.splice(0, list.length - BUILD_LOG_MAX)
  buildLines.set(id, list)
}

// ---- 中国区 npm registry 注入（与宿主内置 nodejs withNpmRegistry 一致：保证确定性，不透传用户 npmrc）----

const CHINA_LOCALE_PREFIXES = ['zh']
let devToolsLocaleCache: string | undefined
async function isChinaRegion(): Promise<boolean> {
  if (devToolsLocaleCache === undefined) {
    try {
      devToolsLocaleCache = String(await rpc.app.getLocale())
    } catch {
      devToolsLocaleCache = 'en-US'
    }
  }
  return CHINA_LOCALE_PREFIXES.some((p) => devToolsLocaleCache!.startsWith(p))
}

async function withNpmRegistry(args: string[]): Promise<string[]> {
  const reg = (await isChinaRegion()) ? 'https://registry.npmmirror.com' : undefined
  if (!reg || args.some((a) => a.startsWith('--registry'))) return args
  return [...args, `--registry=${reg}`]
}

// ---- npm 执行：一律经 CMD_NPM 命令别名自 spawn（宿主解析真实可执行文件并按别名授权，
//      换机器 / 换 node 版本不重弹，Windows 也不必直接 spawn npm.cmd）----

interface HandleExitInfo {
  code: number | null
  reason: 'exited' | 'killed' | 'error' | 'timeout'
  message?: string
}

/** 等宿主代管子进程退出：事件驱动（onExit/onError；SDK 订阅回放保证不丢 exit），超时 kill 并返回 timeout。 */
async function awaitHandle(handle: ChildHandle, timeoutMs: number): Promise<HandleExitInfo> {
  return new Promise<HandleExitInfo>((resolve) => {
    let settled = false
    const finish = (info: HandleExitInfo) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(info)
    }
    // host-api v2：child.kill / child.readOutput 已删除，退出信号一律走句柄事件（readOutput 轮询兜底随之移除）
    handle.onExit((info) => finish({ code: info.code, reason: info.reason === 'killed' ? 'killed' : 'exited' }))
    handle.onError((err) => finish({ code: -1, reason: 'error', message: err.message }))
    const timer = setTimeout(() => {
      void handle.kill().catch(() => undefined)
      finish({ code: null, reason: 'timeout' })
    }, timeoutMs)
  })
}

/** 启动/复用 npm run dev 构建进程；新启动记录 devStartAt（esbuild watch 启动即初始构建 worker.js） */
async function startBuildDev(id: string): Promise<{ ok?: boolean; procId?: string; error?: string; reused?: boolean }> {
  // 幂等：已有构建进程且仍运行 → 复用，不重复启动
  const existing = buildRecs.get(id)
  if (existing && existing.status === 'running') {
    return { ok: true, procId: existing.procId, reused: true }
  }
  const info = await getDirInfo(id)
  if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` })
  try {
    const handle = await rpc.child.spawn({ cmd: CMD_NPM, args: ['run', 'dev'], cwd: info.dir })
    buildHandles.set(id, handle)
    buildRecs.set(id, {
      procId: handle.handleId,
      caller: 'dev-tools',
      kind: 'dev',
      pid: handle.pid,
      status: 'running',
      cwd: info.dir,
      startedAt: Date.now(),
    })
    buildLines.delete(id)
    devStartAt.set(id, Date.now())
    handle.onStdout((d) => appendBuildLine(id, 'stdout', d))
    handle.onStderr((d) => appendBuildLine(id, 'stderr', d))
    handle.onExit(() => {
      const rec = buildRecs.get(id)
      if (rec) rec.status = 'exited'
    })
    handle.onError((err) => {
      const rec = buildRecs.get(id)
      if (rec) rec.status = 'error'
      appendBuildLine(id, 'stderr', `spawn error: ${err.message}`)
    })
    return { ok: true, procId: handle.handleId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

rpc.registerHandler('dev-tools.buildDev', ([pluginId]) => startBuildDev(String(pluginId)))

rpc.registerHandler('dev-tools.stop', async ([procId]) => {
  const pid = String(procId)
  const id = Array.from(buildRecs.entries()).find(([, r]) => r.procId === pid)?.[0]
  if (id) {
    const handle = buildHandles.get(id)
    if (handle) await handle.kill().catch(() => undefined)
    buildHandles.delete(id)
    buildRecs.delete(id)
    buildLines.delete(id)
    devStartAt.delete(id)
  }
  return { ok: true }
})
rpc.registerHandler('dev-tools.listBuilds', () => Array.from(buildRecs.values()))
rpc.registerHandler('dev-tools.log', ([procId, since]) => {
  const id = Array.from(buildRecs.entries()).find(([, r]) => r.procId === String(procId))?.[0]
  if (!id) return []
  const start = typeof since === 'number' && since > 0 ? since : 0
  return (buildLines.get(id) ?? []).filter((l) => l.ts >= start)
})

// ---- 刷新（需求：卸载预览 → 停 worker → npm install → run dev → fork worker → 加载 UI）----

/** 停止该插件对应的构建进程（若在跑）并清映射；失败不阻塞 */
async function stopBuildFor(id: string): Promise<void> {
  const handle = buildHandles.get(id)
  if (!handle) return
  await handle.kill().catch(() => undefined)
  buildHandles.delete(id)
  buildRecs.delete(id)
  buildLines.delete(id)
  devStartAt.delete(id)
}

/** 同步执行 npm 命令（自 spawn，等退出；超时 10min kill）；失败返回可读 detail，不抛 */
async function runNpmSync(dir: string, args: string[]): Promise<{ ok: boolean; detail?: string }> {
  try {
    const npmArgs = await withNpmRegistry(args)
    const handle = await rpc.child.spawn({ cmd: CMD_NPM, args: npmArgs, cwd: dir })
    let stderr = ''
    handle.onStderr((d) => (stderr += d))
    const info = await awaitHandle(handle, 10 * 60 * 1000)
    if (info.reason === 'timeout') return { ok: false, detail: `npm ${args.join(' ')} 超时（10min）` }
    if (info.reason === 'error') return { ok: false, detail: `npm ${args.join(' ')} 启动失败：${info.message ?? ''}`.slice(0, 300) }
    if (info.code !== 0) return { ok: false, detail: (stderr.trim() || `npm ${args.join(' ')} 返回失败`).slice(0, 300) }
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: `执行 npm 失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }
  }
}

/** 同步 npm install */
function runNpmInstall(dir: string): Promise<{ ok: boolean; detail?: string }> {
  return runNpmSync(dir, ['install', '--no-audit', '--no-fund'])
}

/** 打开预览前检查依赖：node_modules / worker.js 缺失则补齐（npm install / build:worker）；返回是否安装了依赖。
 *  ui 类型插件无 worker，跳过 build:worker。 */
rpc.registerHandler('dev-tools.ensureDeps', async ([pluginId]) => {
  const id = String(pluginId)
  const info = await getDirInfo(id)
  if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` })
  // 前置：nodejs 环境检测（npm install / build 均依赖内置 node；未就绪给出明确提示）
  const env = await checkNodejsEnv()
  if (!env.ok) throw new PluginError(DevErr.NODEJS_MISSING, nodejsMissingMessage())
  const depManifest = await readManifest(info.dir)
  const { needsWorker } = buildArtifacts(depManifest?.type, depManifest?.scripts)
  let installed = false
  if (!(await hostFsExists(join(info.dir, 'node_modules')))) {
    const r = await runNpmInstall(info.dir)
    if (!r.ok) throw new PluginError(DevErr.BUILD_FAIL, { enUS: `npm install failed: ${r.detail}`, zhCN: `npm install 失败：${r.detail}` })
    installed = true
  }
  // 无 worker.js（新建插件未构建过）→ 显式 build:worker 补齐，保证预览可 fork
  // （纯 UI 的 app 无 build:worker 脚本，needsWorker=false，跳过；npm run dev 的 esbuild watch
  //  初始构建会产出 worker.js，但显式构建可快速失败给出明确错误）
  if (needsWorker && !(await hostFsExists(join(info.dir, info.dist, 'worker.js')))) {
    const wb = await runNpmSync(info.dir, ['run', 'build:worker'])
    if (!wb.ok) throw new PluginError(DevErr.BUILD_FAIL, { enUS: `build:worker failed: ${wb.detail}`, zhCN: `build:worker 失败：${wb.detail}` })
  }
  return { ok: true, installed }
})

/** 校验目标插件 manifest 合规（预览前置检查；口径与 doRegister 一致：id 格式 + source=dev + id 与注册一致） */
rpc.registerHandler('dev-tools.checkManifest', async ([pluginId]) => {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: { enUS: 'Plugin ID cannot be empty', zhCN: '插件 ID 不能为空' } }
  const info = await getDirInfo(id)
  if (!info) return { ok: false, error: { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` } }
  const m = await readManifest(info.dir)
  if (!m?.id) return { ok: false, error: { enUS: 'No valid plugin manifest found in the directory (dlient.id in package.json)', zhCN: '目录中未找到有效的插件 manifest（package.json 的 dlient.id）' } }
  if (m.id !== id) return { ok: false, error: { enUS: `The dlient.id in the manifest (${m.id}) does not match the registered ID (${id})`, zhCN: `manifest 的 dlient.id（${m.id}）与注册 ID（${id}）不一致` } }
  if (!/^[a-z0-9-]+$/.test(m.id)) {
    return { ok: false, error: { enUS: `Invalid plugin ID (only lowercase letters, digits and hyphens allowed, current: ${m.id})`, zhCN: `插件 ID 不合法（仅允许小写字母、数字、连字符，当前：${m.id}）` } }
  }
  if (m.source !== 'dev') {
    return { ok: false, error: { enUS: `This plugin is not a dev plugin (dlient.source="${m.source ?? 'unset'}"). Change dlient.source in package.json to "dev"`, zhCN: `该插件不是 dev 插件（dlient.source="${m.source ?? '未声明'}"），请将 package.json 的 dlient.source 改为 "dev"` } }
  }
  return { ok: true, id: m.id, name: m.name }
})

/** 构建环境就绪（预览/刷新共用）：等 npm run dev 初始构建完成（按类型等 worker.js/remoteEntry.js）+ 启动热重载 watcher。
 *  **不 fork worker** —— dev 插件与普通插件一致走懒启动：渲染层 PluginView 挂载后首次 api 调用
 *  经 ensure-worker（ensurePluginWorker → externalRecords → startPlugin）才 fork。
 *  watcher 在构建完成后启动：esbuild context.watch() 启动即重建产物，提前启动会 seed 旧状态触发 restart 竞态。 */
rpc.registerHandler('dev-tools.ensureEnv', async ([pluginId]) => {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: { enUS: 'Plugin ID cannot be empty', zhCN: '插件 ID 不能为空' } }
  const info = await getDirInfo(id)
  if (!info) return { ok: false, error: { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` } }
  const envManifest = await readManifest(info.dir)
  const { hasUI, needsWorker } = buildArtifacts(envManifest?.type, envManifest?.scripts)
  // 等 npm run dev 初始构建产出（devStartAt 为启动时刻；未走 buildDev 时 since=0 直接放行）。
  // 无 UI（worker 类型）不产 remoteEntry.js，只等 worker.js；纯 UI 的 app 反之只等 remoteEntry.js。
  const since = devStartAt.get(id) ?? 0
  const ready = await waitForFreshBuild(info, hasUI, needsWorker, since, 30000)
  if (!ready) {
    return { ok: false, error: { enUS: `${needsWorker ? 'worker.js' : 'remoteEntry.js'} initial build not complete (npm run dev did not produce new artifacts)`, zhCN: `${needsWorker ? 'worker.js' : 'remoteEntry.js'} 初始构建未完成（npm run dev 未产出新产物）` } }
  }
  await rpc.plugin.dev.startWatcher(id)
    .catch((err) => logger.error(`ensureEnv ${id} startWatcher`, { error: err instanceof Error ? err.message : String(err) }))
  return { ok: true }
})

/** 关闭插件 Tab：停 watcher → 移除 fork → 停 npm run dev（与预览启动流程对称；失败不阻塞） */
rpc.registerHandler('dev-tools.closePlugin', async ([pluginId]) => {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: { enUS: 'Plugin ID cannot be empty', zhCN: '插件 ID 不能为空' } }
  await rpc.plugin.dev.stopWatcher(id)
    .catch((err) => logger.error('closePlugin stopWatcher', { pluginId: id, error: err instanceof Error ? err.message : String(err) }))
  await rpc.plugin.dev.stopDevWorker(id)
    .catch((err) => logger.error('closePlugin stopDevWorker', { pluginId: id, error: err instanceof Error ? err.message : String(err) }))
  await stopBuildFor(id)
  return { ok: true }
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等待 dist 构建产物被**重新构建**（mtime ≥ since；npm run dev 是异步 watch，watcher 启动前必须等新产物，
 * 否则 seed 旧产物状态，构建写入会触发 restartPlugin 竞态）。按类型等待：
 *   - 有 UI（full/app/ui）等 remoteEntry.js；worker 类型无 UI 不产 remoteEntry，跳过；
 *   - needsWorker（由类型 + 构建脚本推导，见 buildArtifacts）为真时还需 worker.js。
 * 判定用严格 `mtimeMs >= since`（无容差）：since 是 npm run dev 启动时刻，esbuild/vite 初始构建必然在之后写入；
 * 加容差会把启动前 1s 内写过的旧产物误判为新产物。
 * 构建进程已退出（失败）时快速返回 false。超时返回「产物存在」（放行，由懒启动兜底）。
 */
async function waitForFreshBuild(
  info: DirInfo,
  hasUI: boolean,
  needsWorker: boolean,
  since: number,
  timeoutMs: number,
  procId?: string,
): Promise<boolean> {
  const files: string[] = []
  if (hasUI) files.push(join(info.dir, info.dist, 'remoteEntry.js'))
  if (needsWorker) files.push(join(info.dir, info.dist, 'worker.js'))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // 宿主 fs.stat（进程级封禁下 worker 无裸 statSync）
    const stats = await Promise.all(files.map((f) => hostStat(f)))
    const allFresh = stats.every((s) => s?.exists === true && s.mtimeMs >= since)
    if (allFresh) return true
    // 构建进程已退出（本地 rec 状态）→ 快速返回失败，不等满超时
    if (procId) {
      const rec = Array.from(buildRecs.values()).find((r) => r.procId === procId)
      if (rec && rec.status !== 'running') return false
    }
    await sleep(500)
  }
  const tail = await Promise.all(files.map((f) => hostStat(f)))
  return tail.every((s) => s?.exists === true)
}

/** 刷新：流式进度（逐步骤状态经 ctx.emit 推送渲染层）；全程不抛，末尾必发 step5 终态 */
rpc.registerStreamHandler('dev-tools.refresh', async ([pluginId], ctx) => {
  const id = String(pluginId ?? '')
  if (!ctx?.emit) return { ok: false, error: { enUS: 'refresh requires a streaming call (api.listen)', zhCN: 'refresh 需要流式调用（api.listen）' } }
  const streamEmit = ctx.emit
  const emit = (
    step: number,
    status: 'running' | 'done' | 'error',
    extra?: { detail?: ResponseErrorMsg; procId?: string | null },
  ) => {
    const payload: { step: number; status: string; detail?: ResponseErrorMsg; procId?: string | null } = { step, status }
    if (extra?.detail !== undefined) payload.detail = extra.detail
    if (extra?.procId !== undefined) payload.procId = extra.procId
    streamEmit(payload)
  }
  try {
    const info = await getDirInfo(id)
    if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` })
    const refreshManifest = await readManifest(info.dir)
    const { hasUI, needsWorker } = buildArtifacts(refreshManifest?.type, refreshManifest?.scripts)
    // 0 停止 dev 实例 worker
    emit(0, 'running')
    await rpc.plugin.dev.stopDevWorker(id)
      .catch((err) => logger.error('refresh stopDevWorker', { pluginId: id, error: err instanceof Error ? err.message : String(err) }))
    emit(0, 'done')
    // 0.5 停止热重载 watcher：构建期间 watcher 不活动，build:worker 写入不会触发 restart 竞态
    await rpc.plugin.dev.stopWatcher(id)
      .catch((err) => logger.error('refresh stopWatcher', { pluginId: id, error: err instanceof Error ? err.message : String(err) }))
    // 1 停止旧构建进程，避免与新 npm run dev 冲突
    emit(1, 'running')
    await stopBuildFor(id)
    emit(1, 'done')
    // 2 安装依赖（同步等待）
    emit(2, 'running')
    const install = await runNpmInstall(info.dir)
    if (!install.ok) {
      const d: ResponseErrorMsg = { enUS: `npm install failed: ${install.detail}`, zhCN: `npm install 失败：${install.detail}` }
      emit(2, 'error', { detail: d })
      emit(5, 'error', { detail: d })
      return { ok: false, error: d }
    }
    emit(2, 'done')
    // 3 构建产物
    emit(3, 'running')
    // 3a 先同步 build:worker 产出基线产物（快速失败给出明确错误；npm run dev 的 esbuild watch
    // 启动时还会再做一次初始构建覆盖为未压缩产物，属预期）；纯 ui 类型无 worker 跳过
    const buildStart = Date.now()
    if (needsWorker) {
      const wb = await runNpmSync(info.dir, ['run', 'build:worker'])
      if (!wb.ok) {
        const d: ResponseErrorMsg = { enUS: `build:worker failed: ${wb.detail}`, zhCN: `build:worker 失败：${wb.detail}` }
        emit(3, 'error', { detail: d })
        emit(5, 'error', { detail: d })
        return { ok: false, error: d }
      }
    }
    // 3b 启动 npm run dev（watch，持续开发；vite 初始构建 UI，esbuild watch 初始构建 worker.js）
    const build = await startBuildDev(id)
    if (!build?.ok) {
      const raw = build?.error ?? 'unknown'
      const d: ResponseErrorMsg = { enUS: `Failed to start build: ${raw}`, zhCN: `构建启动失败：${raw}` }
      emit(3, 'error', { detail: d })
      emit(5, 'error', { detail: d })
      return { ok: false, error: d }
    }
    // 3c 等 npm run dev 初始构建写完产物（有 UI 等 remoteEntry.js + 非 ui 的 worker.js，mtime ≥ devStartAt）。
    // 不能在 3a 后立即放行：watcher 若在初始构建前启动，构建写入会触发 restartPlugin 竞态。
    const since = devStartAt.get(id) ?? buildStart
    const ready = await waitForFreshBuild(info, hasUI, needsWorker, since, 120000, build.procId)
    if (!ready) {
      const d: ResponseErrorMsg = {
        enUS: `${info.dist}/${needsWorker ? 'worker.js' : 'remoteEntry.js'} was not produced (build failed or timed out)`,
        zhCN: `${info.dist}/${needsWorker ? 'worker.js' : 'remoteEntry.js'} 未产出（构建失败或超时）`,
      }
      emit(3, 'error', { detail: d })
      emit(5, 'error', { detail: d })
      return { ok: false, error: d }
    }
    emit(3, 'done')
    // 4 环境就绪：启动热重载 watcher（seed 新产物状态，不触发重启）。
    //    不 fork worker —— 懒启动：UI 挂载后首次 api 调用经 ensure-worker 才 fork。
    emit(4, 'running')
    await rpc.plugin.dev.startWatcher(id)
      .catch((err) => logger.error('refresh startWatcher', { pluginId: id, error: err instanceof Error ? err.message : String(err) }))
    emit(4, 'done')
    // 5 完成
    emit(5, 'done', { procId: build.procId ?? null })
    return { ok: true, procId: build.procId ?? null }
  } catch (err) {
    const msg: ResponseErrorMsg =
      err instanceof PluginError && err.msg !== undefined
        ? err.msg
        : err instanceof Error
          ? err.message
          : String(err)
    logger.error('refresh failed', { pluginId: id, error: typeof msg === 'string' ? msg : msg.zhCN })
    emit(5, 'error', { detail: msg })
    return { ok: false, error: msg }
  }
})

// ---- 预览内嵌 Webview 可见性 ----
// WebContentsView 原生层不随 DOM 显隐；开源宿主里 worker 无 webview.* host-api（webview 编排已下沉
// 渲染层直连：@dlient-open/ui 的 useWebviewClient().hideMine()/showMine(ids)），故此处不再提供
// hidePreviewWebview / showPreviewWebview / destroyPreviewWebviews 三个 worker 方法，改由渲染层按
// owner（创建时 activePlugin = dev-tools）精确 hide/show（见 App.tsx）。关闭 tab 时宿主在 dev worker
// 停止后按 owner 回收该实例的 webview。

// ---- 启动：首次上报已有 dev 清单 + 开启 package.json 监听（worker 就绪后）----

rpc.onReady(() => {
  // 启动即写日志：确认新版 worker 已加载 + logger 落盘正常（main.log 里应能搜到本行）
  logger.info('worker ready', { pid: process.pid })
  // 首次同步门闩：UI 的目录读取需等 plugin.dev.sync（fs 授权）完成后才放行
  setDevListSyncGate(
    readPluginsJson()
      .then(async (entries) => {
        for (const e of entries) await watchPackageJson(e)
        await syncToHost(entries)
      })
      .catch((err) => logger.error('initial sync failed', { error: err instanceof Error ? err.message : String(err) })),
  )
})

// 生命周期 12.3.5-④：宿主停止前 onDispose → 停止本插件启动的全部构建进程
rpc.onDispose(async () => {
  for (const handle of buildHandles.values()) {
    await handle.kill().catch(() => undefined)
  }
  buildHandles.clear()
  buildRecs.clear()
  buildLines.clear()
  devStartAt.clear()
})

// ---- 打包 .dlient（开源版：本地 make-dlient，无签名 / 无服务端 / 无上传）----

/**
 * 打包 dev 插件为 .dlient：
 *  - 复用插件自身 `npm run pack` 管线（模板脚本 script/make-dlient.mjs：改写副本 manifest
 *    source=local/system=false + 复制 assets/ + 构建产物到 dist/ + 出包即清理旧 .dlient）；
 *  - 产物落在插件根目录 <id>-<version>.dlient，可被宿主「导入插件」直接安装。
 */
rpc.registerHandler('dev-tools.packPlugin', async ([pluginId]) => {
  const id = String(pluginId ?? '').trim()
  if (!id) throw new PluginError(DevErr.INVALID_ARG, { enUS: 'pluginId required', zhCN: '缺少 pluginId 参数' })
  const info = await getDirInfo(id)
  if (!info) throw new PluginError(DevErr.NOT_FOUND, { enUS: `Dev plugin does not exist: ${id}`, zhCN: `dev 插件不存在: ${id}` })
  let handle: ChildHandle
  try {
    handle = await rpc.child.spawn({ cmd: CMD_NPM, args: ['run', 'pack'], cwd: info.dir })
  } catch (err) {
    throw new PluginError(DevErr.BUILD_FAIL, {
      enUS: `Failed to start pack: ${err instanceof Error ? err.message : String(err)}`,
      zhCN: `启动打包失败：${err instanceof Error ? err.message : String(err)}`,
    })
  }
  let out = ''
  handle.onStdout((d) => (out += d))
  handle.onStderr((d) => (out += d))
  const done = await awaitHandle(handle, 10 * 60 * 1000)
  const detail = out.trim().slice(-2000)
  if (done.reason === 'timeout') {
    throw new PluginError(DevErr.BUILD_FAIL, { enUS: `Pack timed out (10min): ${detail}`, zhCN: `打包超时（10 分钟）：${detail}` })
  }
  if (done.code !== 0) {
    throw new PluginError(DevErr.BUILD_FAIL, {
      enUS: `Pack failed (exit ${done.code}): ${detail}`,
      zhCN: `打包失败（exit ${done.code}）：${detail}`,
    })
  }
  // 产物名：<id>-<version>.dlient（插件 package.json version）
  let version = ''
  const raw = await hostReadText(join(info.dir, 'package.json'))
  if (raw != null) {
    try {
      version = String((JSON.parse(raw) as { version?: unknown }).version ?? '')
    } catch {
      /* 忽略：产物名回退 0.0.0 */
    }
  }
  return rpc.success({ ok: true, dir: info.dir, file: `${id}-${version || '0.0.0'}.dlient`, output: detail })
})

/** 在系统资源管理器中定位文件/目录（生成 .dlient 后「查看发布包」；os.showItemInFolder 权限见 manifest） */
rpc.registerHandler('dev-tools.revealPath', async ([path]) => {
  const p = String(path ?? '').trim()
  if (!p) throw new PluginError(DevErr.INVALID_ARG, { enUS: 'path required', zhCN: '缺少 path 参数' })
  await rpc.os.showItemInFolder(p)
  return rpc.success({ ok: true })
})
