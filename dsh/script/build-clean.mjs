// 构建前清空 dist（方案 build.md：构建产物从零开始，避免残留旧文件）
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
rmSync(path.join(__dirname, '..', 'dist'), { recursive: true, force: true })
console.log('[clean] dist removed')
