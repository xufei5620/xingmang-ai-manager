import fs from 'node:fs/promises'
import path from 'node:path'

const projectRoot = process.cwd()
const target = path.resolve(projectRoot, 'dist-electron')

if (path.dirname(target) !== projectRoot || path.basename(target) !== 'dist-electron') {
  throw new Error(`Refusing to clean unexpected path: ${target}`)
}

await fs.rm(target, { recursive: true, force: true })
