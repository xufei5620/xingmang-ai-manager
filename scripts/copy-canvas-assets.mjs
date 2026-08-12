// Copies the selected canvas static build into dist-canvas/, which
// electron-builder packages beside dist/ and dist-electron/.
//
// dist-canvas/ is NOT committed to git (see .gitignore). The source lives in
// canvas-v2/; this generated copy is the stable location consumed by Electron
// and electron-builder.
//
// canvas-v2 now lives in this repository and package scripts build it before
// invoking this copier. XINGMANG_CANVAS_DIST remains as an explicit override
// for testing another reviewed build.
//
import fs from 'node:fs/promises'
import path from 'node:path'

const projectRoot = process.cwd()
const destination = path.resolve(projectRoot, 'dist-canvas')

if (path.dirname(destination) !== projectRoot || path.basename(destination) !== 'dist-canvas') {
  throw new Error(`Refusing to write to unexpected path: ${destination}`)
}

const source = (process.env.XINGMANG_CANVAS_DIST?.trim())
  || path.resolve(projectRoot, 'canvas-v2', 'dist')
const resolvedSource = path.resolve(projectRoot, source)

if (resolvedSource === destination || resolvedSource.startsWith(`${destination}${path.sep}`)) {
  throw new Error(`Refusing to copy canvas assets from the destination: ${resolvedSource}`)
}

async function sourceLooksLikeACanvasBuild(candidate) {
  try {
    await fs.access(path.join(candidate, 'index.html'))
    return true
  } catch {
    return false
  }
}

if (!(await sourceLooksLikeACanvasBuild(resolvedSource))) {
  throw new Error(
    `[copy-canvas-assets] 未找到画布构建产物（${resolvedSource}）。`
    + '请先构建 canvas-v2，或设置 XINGMANG_CANVAS_DIST 指向已审核的构建目录。',
  )
}

await fs.rm(destination, { recursive: true, force: true })
await fs.cp(resolvedSource, destination, { recursive: true })
console.log(`[copy-canvas-assets] 已从 ${resolvedSource} 复制画布产物到 ${destination}`)
