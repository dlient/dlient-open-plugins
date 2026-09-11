// make-dlient.mjs - 开源版 .dlient 打包器（无需签名 / 无服务端依赖）
//
// 背景：原版 .dlient 需要服务端平台签名（signature.json 由 dev-tools 提交 hash 到
// /api/plugins/package 换取）。开源版宿主导入不做任何验签——导入端只要求：
//   .dlient = 普通 zip，内含 package.json（dlient.id 合法）+ assets/ + skills/ + <dist>/
// 本脚本把「打包即 .dlient」一步完成（store 压缩 zip，纯 Node 无第三方依赖）。
//
// 用法（在插件目录执行，插件须已完成 npm run build 产出 <dist>）：
//   node script/make-dlient.mjs                 # 产出 <id>-<version>.dlient
//   node script/make-dlient.mjs --version 1.2.3 # 覆盖版本（同步改写包内 version）
//   node script/make-dlient.mjs --name my.dlient
//   node script/make-dlient.mjs --build         # 先执行插件自身 npm run build
//
// 说明：
//   - package.json 落包时被改写：dlient.source='local'、dlient.system=false（与导入端一致）；
//   - dist/ 内的 node_modules（原生模块）不进包——原生依赖在导入时按 dlient.nativeModules 重装；
//   - 中间产物放 .make-dlient-* 临时目录，结束自动清理；产物写到插件根目录。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'

// ---- 参数 ----
function parseArgv() {
  const out = { version: '', name: '', build: false }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') out.version = String(args[++i] ?? '').trim()
    else if (args[i] === '--name') out.name = String(args[++i] ?? '').trim()
    else if (args[i] === '--build') out.build = true
    else if (args[i].startsWith('-')) {
      console.error(`未知参数: ${args[i]}`)
      process.exit(1)
    }
  }
  return out
}

const ROOT = process.cwd()
const pkgPath = join(ROOT, 'package.json')
if (!existsSync(pkgPath)) {
  console.error('[make-dlient] 当前目录不是插件工程（无 package.json）。请在插件目录内执行本脚本。')
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const dlient = pkg?.dlient ?? {}
const id = typeof dlient.id === 'string' ? dlient.id : ''
if (!id || !/^[a-z0-9-]+$/.test(id)) {
  console.error(`[make-dlient] package.json 缺少合法的 dlient.id（当前: ${id || '(空)'}）。`)
  process.exit(1)
}
if (dlient.system === true) {
  console.error('[make-dlient] system 插件不允许本地打包 .dlient。')
  process.exit(1)
}
const distRel = typeof dlient.dist === 'string' && dlient.dist ? dlient.dist : 'dist'
const argv = parseArgv()
const version = argv.version || String(pkg.version || '').trim()
if (!version) {
  console.error('[make-dlient] 缺少版本号：package.json version 为空时请用 --version <v> 指定。')
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[make-dlient] 版本号不合法（示例：1.0.0），当前: ${version}`)
  process.exit(1)
}
const srcDist = join(ROOT, distRel)
const name = argv.name || `${id}-${version}.dlient`
if (!name.endsWith('.dlient')) {
  console.error('[make-dlient] 输出文件名需以 .dlient 结尾。')
  process.exit(1)
}

// ---- 可选：先跑插件自身构建（--build）----
if (argv.build) {
  console.log(`[make-dlient] npm run build`)
  const npmCli = process.env.npm_execpath && existsSync(process.env.npm_execpath)
    ? process.env.npm_execpath
    : join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const cli = existsSync(npmCli) ? npmCli : 'npm'
  const args = existsSync(npmCli) ? [npmCli, 'run', 'build'] : ['run', 'build']
  const res = spawnSync(process.execPath ?? process.argv[0], args, { cwd: ROOT, stdio: 'inherit' })
  if (res.error || res.status !== 0) {
    console.error(`[make-dlient] npm run build 失败（exit ${res.status ?? res.error?.message ?? '?'}）`)
    process.exit(res.status ?? 1)
  }
}
if (!existsSync(srcDist)) {
  console.error(`[make-dlient] 未找到构建产物 ${distRel}/。请先执行 npm run build（或加 --build），再打包。`)
  process.exit(1)
}

// ---- 暂存目录：package.json（改写 source/system）+ assets + skills + <dist>（排除 node_modules）----
const stage = mkdtempSync(join(tmpdir(), 'make-dlient-'))
try {
  const patchedDlient = { ...dlient, source: 'local', system: false }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ ...pkg, version, dlient: patchedDlient }, null, 2)}\n`)

  // 注意：dist 目录名按 manifest（dlient.dist）保留在包内——导入端协议重写依赖该结构
  cpSync(srcDist, join(stage, distRel), {
    recursive: true,
    filter: (src) => !src.split(sep).includes('node_modules'),
  })
  for (const sub of ['assets', 'skills']) {
    if (!existsSync(join(ROOT, sub))) continue
    // dsh-chat-ui 资产已在构建期内联进 dist/worker.js（esbuild 虚拟模块 'dlient:chat-assets'），
    // 包内不再重复打一份（仓库仍保留该目录作为构建源）
    cpSync(join(ROOT, sub), join(stage, sub), {
      recursive: true,
      filter: (src) => !src.split(sep).includes('dsh-chat-ui'),
    })
  }

  // ---- 递归收集 stage 文件 ----
  const files = []
  const walk = (dir, base) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name)
      const rel = base ? `${base}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(full, rel)
      else if (ent.isFile()) files.push({ name: rel, data: readFileSync(full) })
    }
  }
  walk(stage, '')

  const out = join(ROOT, name)
  // 清理同目录下的历史 .dlient（只保留本次产物）：npm 包用 "*.dlient" 通配发布时，
  // 旧版本产物会被一并打进包里（体积暴涨且宿主可能装到旧包），故出包即清理
  for (const ent of readdirSync(ROOT)) {
    if (ent !== name && ent.startsWith(`${id}-`) && ent.endsWith('.dlient')) {
      rmSync(join(ROOT, ent), { force: true })
    }
  }
  writeFileSync(out, makeZip(files))
  console.log(`[make-dlient] 完成 → ${out}`)
  console.log(`[make-dlient] 共 ${files.length} 个文件，.dlient 大小 ${(statSync(out).size / 1024).toFixed(1)} KB（无需签名，可直接导入开源版）`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}

// ---- 极简 zip 写入（method=0 store；兼容开源版导入端 extractZip）----
// var 提升：函数在模块底部、顶层调用在前，用 var 避免 TDZ（首轮 !CRC_TABLE 为真即建表）
var CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(entries) {
  const local = []
  const central = []
  let offset = 0
  let centralSize = 0
  for (const f of entries) {
    const nameBuf = Buffer.from(f.name, 'utf-8')
    const crc = crc32(f.data)
    const size = f.data.length

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0x0800, 6) // flags: UTF-8 文件名
    lh.writeUInt16LE(0, 8) // method = store
    lh.writeUInt16LE(0, 10) // mod time
    lh.writeUInt16LE(0x0021, 12) // mod date 1980-01-01
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(size, 18)
    lh.writeUInt32LE(size, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    local.push(lh, nameBuf, f.data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4) // version made by
    ch.writeUInt16LE(20, 6) // version needed
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10) // method
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0x0021, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(size, 20)
    ch.writeUInt32LE(size, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    centralSize += 46 + nameBuf.length
    offset += 30 + nameBuf.length + size
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...local, ...central, eocd])
}
