/**
 * dsh-runtime.ts —— dsh worker 的共享运行时工具（**沙箱合规**）。
 *
 * worker 运行在 Node Permission Model 下（`--permission` + 目录前缀读白名单；无 fs 写、
 * 无 child-process、无 net），因此本文件**不使用** node:fs / node:child_process / node:net：
 *   - 文件读写 → host-api `rpc.fs.*`（主进程执行；需 manifest 的 fs.* 权限 + 路径授权）
 *   - 起进程   → host-api `rpc.child.spawn` / `rpc.child.execFile`（宿主代管，整树回收）
 *   - 端口     → host-api `rpc.net.*`
 * 例外说明：`codeProbe()` 用一次一过性 `node -e` 子进程读取「包元数据」（npm 全局包的
 * package.json，用于定位 dsh/cli 入口），属于元数据探测而非用户数据访问——这样就不必为
 * 每台机器各异的 npm 全局目录申请 fs 授权。
 */

import type { createWorkerRpc } from '@dlient-open/plugin-sdk'
import { CMD_NODE, CMD_NPM } from '@dlient-open/plugin-sdk'
import { dirname, join } from 'node:path'

export type Rpc = ReturnType<typeof createWorkerRpc>
export type MsgFn = (key: string, params?: Record<string, string | number>) => Promise<string>

/**
 * 子进程 env：把 node 目录（含 POSIX 下的 bin 目录）前置到 PATH，再叠加 extra。
 * - Windows 全局 bin = `<nodeDir>`（dsh.cmd / pnpm.cmd 与 node.exe 同级）
 * - POSIX 全局 bin = `<nodeDir>/bin`
 * `dsh plugin` 按名字从 PATH 找 pnpm，因此两者都要有；`dsh` 进程还需 DSH_HOME。
 */
export function envWithNode(node: string, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  const nodeDir = dirname(node)
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const sep = process.platform === 'win32' ? ';' : ':'
  const parts = process.platform === 'win32' ? [nodeDir, env[pathKey] ?? ''] : [nodeDir, join(nodeDir, 'bin'), env[pathKey] ?? '']
  env[pathKey] = parts.filter(Boolean).join(sep)
  if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v
  return env
}

/** 宿主代 spawn：等待退出并累积输出（超时 kill；句柄 kill 为整树回收） */
export async function runHosted(
  rpc: Rpc,
  o: { cmd: string; args: string[]; env?: Record<string, string>; cwd?: string; timeoutMs?: number; description?: string },
): Promise<{ code: number | null; out: string }> {
  const handle = await rpc.child.spawn({
    cmd: o.cmd,
    args: o.args,
    env: o.env,
    cwd: o.cwd,
    ...(o.description ? { description: o.description } : {}),
  })
  let out = ''
  handle.onStdout((d: string) => {
    out += d
  })
  handle.onStderr((d: string) => {
    out += d
  })
  const exited = new Promise<{ code: number | null }>((resolve) => handle.onExit((info: { code: number | null }) => resolve({ code: info.code })))
  const timer = setTimeout(() => {
    void handle.kill().catch(() => undefined)
  }, o.timeoutMs ?? 180000)
  try {
    const { code } = await exited
    return { code, out }
  } finally {
    clearTimeout(timer)
  }
}

/** 宿主代 execFile（一次性；容忍非零退出码，由调用方自行判定） */
export async function execHosted(
  rpc: Rpc,
  o: { cmd: string; args: string[]; timeoutMs?: number; description?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const r = await rpc.child.execFile({
    cmd: o.cmd,
    args: o.args,
    timeout: o.timeoutMs ?? 15000,
    ...(o.description ? { description: o.description } : {}),
  })
  return { stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? ''), code: Number(r?.code ?? -1) }
}

/** 该 node 对应的 npm 全局根（显式 --prefix 定向，避免用户 .npmrc 的 prefix 改写落点） */
export async function npmGlobalRoot(rpc: Rpc, node: string, msg: MsgFn): Promise<string> {
  const r = await execHosted(rpc, {
    cmd: CMD_NPM,
    args: ['--prefix', dirname(node), 'root', '-g'],
    timeoutMs: 15000,
  })
  const root = r.stdout.trim().split(/\r?\n/)[0]
  if (r.code !== 0 || !root) throw new Error(await msg('npmGlobalMissing'))
  return root
}

/** npm 全局已安装包名集合（npm ls -g --json；解析失败按空集合处理） */
export async function npmGlobalPackages(rpc: Rpc, node: string): Promise<Set<string>> {
  try {
    const r = await execHosted(rpc, {
      cmd: CMD_NPM,
      args: ['--prefix', dirname(node), 'ls', '-g', '--depth=0', '--json'],
      timeoutMs: 30000,
    })
    const parsed = JSON.parse(r.stdout || '{}') as { dependencies?: Record<string, unknown> }
    return new Set(Object.keys(parsed.dependencies ?? {}))
  } catch {
    return new Set()
  }
}

/** @deepseek-ai/dsh 是否已装到该 node 的 npm 全局目录 */
export async function isDshInstalled(rpc: Rpc, node: string): Promise<boolean> {
  const pkgs = await npmGlobalPackages(rpc, node)
  return pkgs.has('@deepseek-ai/dsh')
}

/** npm 全局安装 @deepseek-ai/dsh（--prefix 定向，幂等：已装时 npm 快速校验跳过） */
export async function installDsh(rpc: Rpc, node: string, msg: MsgFn): Promise<void> {
  const { code, out } = await runHosted(rpc, {
    cmd: CMD_NPM,
    args: ['--prefix', dirname(node), 'install', '-g', '@deepseek-ai/dsh'],
    env: envWithNode(node),
    timeoutMs: 300000,
    description: 'install @deepseek-ai/dsh (npm global)',
  })
  if (code !== 0) throw new Error(await msg('npmInstallFailed', { code: code ?? 0, out: out.slice(-500) }))
}

/**
 * @deepseek-ai/dsh 的 cli 入口绝对路径：经 `node -e` 读包元数据的 bin 字段解析。
 * 不走 worker 内 node:fs（沙箱下 npm 全局目录不在读白名单），也不需要为它申请 fs 授权。
 */
export async function dshCliPath(rpc: Rpc, node: string, msg: MsgFn): Promise<string> {
  const globalRoot = await npmGlobalRoot(rpc, node, msg)
  const script =
    "const p=require.resolve('@deepseek-ai/dsh/package.json',{paths:[process.argv[1]]});" +
    "const j=JSON.parse(require('fs').readFileSync(p,'utf-8'));" +
    "const b=typeof j.bin==='string'?j.bin:(j.bin&&j.bin.dsh);" +
    "if(!b)process.exit(2);process.stdout.write(require('path').join(require('path').dirname(p),b))"
  const r = await execHosted(rpc, { cmd: CMD_NODE, args: ['-e', script, globalRoot], timeoutMs: 15000 })
  const cli = r.stdout.trim()
  if (r.code !== 0 || !cli) throw new Error(await msg('binMissing'))
  return cli
}

/**
 * 路径级运行时授权（缓存由调用方负责；已授权的项宿主不会重复弹框）。
 * `mode` 缺省 = read + write 双档；全部路径都未被拒才算成功。
 */
export async function ensureFsGrant(rpc: Rpc, paths: string[], description: string): Promise<boolean> {
  try {
    const res = await rpc.permission.request(
      paths.map((path) => ({ type: 'fs' as const, path })),
      description,
    )
    const denied = Array.isArray(res?.denied) ? (res.denied as string[]) : []
    return !paths.some((p) => denied.includes(p))
  } catch {
    return false
  }
}

/** 读文本文件（不存在/越权 → null，交由调用方决定语义） */
export async function readText(rpc: Rpc, path: string): Promise<string | null> {
  try {
    return (await rpc.fs.read(path)) as string
  } catch {
    return null
  }
}

/** 写文本文件（宿主原子写，父目录自动创建） */
export async function writeText(rpc: Rpc, path: string, data: string): Promise<void> {
  await rpc.fs.write(path, data)
}

/** 删除文件/目录（幂等） */
export async function removePath(rpc: Rpc, path: string): Promise<void> {
  try {
    await rpc.fs.delete(path)
  } catch {
    /* 不存在/已删：忽略 */
  }
}

/** 路径是否含空格（install.js 的 `dsh plugin` 转发 pnpm 不加引号，含空格会失败） */
export function hasSpace(path: string): boolean {
  return /\s/.test(path)
}
