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
//
// MIT compliance: infinite-canvas ships under the MIT license, which
// requires its copyright notice to travel with every distributed copy of
// the software -- including this vendored build. web/dist itself never
// contains a LICENSE file (Vite only emits the app's own runtime assets),
// so this script copies the canvas repo's own root LICENSE into
// dist-canvas/ right alongside it (electron-builder.config.cjs's
// 'dist-canvas/**/*' files glob already packages it same as everything
// else there, no config change needed). If that file cannot be found (e.g.
// XINGMANG_CANVAS_DIST points at a sparse checkout with no LICENSE), a
// literal copy of infinite-canvas's actual license text is generated
// instead, so dist-canvas/ is never left without one.
import fs from 'node:fs/promises'
import path from 'node:path'

const projectRoot = process.cwd()
const destination = path.resolve(projectRoot, 'dist-canvas')

if (path.dirname(destination) !== projectRoot || path.basename(destination) !== 'dist-canvas') {
  throw new Error(`Refusing to write to unexpected path: ${destination}`)
}

const source = (process.env.XINGMANG_CANVAS_DIST?.trim())
  || path.resolve(projectRoot, '..', 'xingmang-canvas', 'web', 'dist')

// The conventional layout this repo and the sibling checkout both use is
// <canvas repo>/web/dist -- two levels up from the dist directory is the
// repo root, whether `source` came from the default sibling-checkout path
// above or an XINGMANG_CANVAS_DIST override pointed at some other checkout
// of the same repo shape.
const canvasRepoLicense = path.resolve(source, '..', '..', 'LICENSE')

// Verbatim copy of the real upstream LICENSE (K:\星芒\xingmang-canvas\LICENSE
// at the time this was written) -- used only when that file cannot be found
// next to the build being vendored, so dist-canvas/ still ships a correct
// notice rather than none at all.
const fallbackLicenseText = `MIT License

Copyright (c) 2026 basketikun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

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

const licenseDestination = path.join(destination, 'LICENSE')
try {
  await fs.copyFile(canvasRepoLicense, licenseDestination)
  console.log(`[copy-canvas-assets] 已从 ${canvasRepoLicense} 复制 LICENSE 到 ${licenseDestination}`)
} catch {
  await fs.writeFile(licenseDestination, fallbackLicenseText, 'utf8')
  console.warn(
    `[copy-canvas-assets] 未找到画布仓库根目录的 LICENSE（${canvasRepoLicense}），`
    + `已生成内置 MIT 声明写入 ${licenseDestination}。`,
  )
}
