import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
rmSync(path.join(__dirname, '..', 'dist'), { recursive: true, force: true })
console.log('[clean] dist removed')
