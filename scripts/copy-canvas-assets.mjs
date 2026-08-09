// Vendors the pre-built infinite-canvas static site (K:\星芒\xingmang-canvas's
// own `web/dist` output, built and reviewed in 阶段 B) into this repo's
// dist-canvas/, which electron-builder.config.cjs packages the same way it
// already packages dist/ and dist-electron/.
//
// dist-canvas/ is NOT committed to git (see .gitignore) -- it is a build
// artifact copied fresh from a sibling checkout, the same way dist/ itself
// is a build artifact vite produces fresh from src/. The alternative
// (committing the ~3.7MB built canvas bundle directly into this repo) would
// mean every canvas rebuild adds a new multi-megabyte blob to this repo's
// history for a bundle this repo does not own or build; a copy script keeps
// that entirely out of git while still making dist-canvas/ a normal,
// reproducible part of `npm run compile`.
//
// This script is safe to run on any machine, including CI and other
// contributors' checkouts that do not have the sibling xingmang-canvas repo
// at all: a missing (or not-yet-built) source directory is a warning, not a
// failure, so it never breaks `npm run compile` / `npm run dev` for anyone
// who is not actively working on the canvas integration. The canvas window
// feature itself degrades gracefully when dist-canvas/ is absent (see
// canvas-window.ts's assertCanvasDistPresent -- opening the canvas window
// fails with a clear Chinese error instead of the app failing to start).
import fs from 'node:fs/promises'
import path from 'node:path'

const projectRoot = process.cwd()
const destination = path.resolve(projectRoot, 'dist-canvas')

if (path.dirname(destination) !== projectRoot || path.basename(destination) !== 'dist-canvas') {
  throw new Error(`Refusing to write to unexpected path: ${destination}`)
}

const source = (process.env.XINGMANG_CANVAS_DIST?.trim())
  || path.resolve(projectRoot, '..', 'xingmang-canvas', 'web', 'dist')

async function sourceLooksLikeACanvasBuild(candidate) {
  try {
    await fs.access(path.join(candidate, 'index.html'))
    return true
  } catch {
    return false
  }
}

if (!(await sourceLooksLikeACanvasBuild(source))) {
  console.warn(
    `[copy-canvas-assets] 未找到画布构建产物（${source}），跳过。`
    + '若需要本机联调「无限画布」，先在 xingmang-canvas\\web 下 bun run build，'
    + '或设置 XINGMANG_CANVAS_DIST 指向其 dist 目录。',
  )
  process.exit(0)
}

await fs.rm(destination, { recursive: true, force: true })
await fs.cp(source, destination, { recursive: true })
console.log(`[copy-canvas-assets] 已从 ${source} 复制画布产物到 ${destination}`)
