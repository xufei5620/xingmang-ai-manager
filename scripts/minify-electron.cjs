const fs = require('node:fs/promises')
const path = require('node:path')
const { transform } = require('esbuild')

const root = path.resolve(__dirname, '..', 'dist-electron')
// The packaged app never carries a source map: the maps go to this sibling
// directory instead, laid out the way the app is (dist-electron/main.js next to
// dist-electron/main.js.map), and only reach Sentry after a release is approved
// (scripts/sentry-sourcemaps.cjs). electron-builder.config.cjs `files` does not
// list it, so nothing here can end up in app.asar.
const sourceMapRoot = path.resolve(__dirname, '..', 'dist-sourcemaps', 'dist-electron')
// tsc runs with --inlineSourceMap --inlineSources (package.json compile:runtime)
// so esbuild can chain its own map onto it and the result points at the .ts.
const INLINE_SOURCE_MAP = /\/\/# sourceMappingURL=data:application\/json;base64,/

async function listJavaScriptFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listJavaScriptFiles(target))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(target)
    }
  }
  return files
}

/** P-31. Every file is minified into memory before the first one is written
 * back. Minifying in place meant a failure partway through left dist-electron
 * holding a mix of minified and untouched modules -- a directory that still
 * packages and still runs, so the interrupted build only surfaces later, as a
 * release nobody knows was built from half-processed output. */
async function minifyElectronDirectory(directory, options = {}) {
  const transformSource = options.transform || transform
  const files = options.files || await listJavaScriptFiles(directory)
  const sourceMapDirectory = options.sourceMapDirectory
  if (files.length === 0) throw new Error('dist-electron 中没有可压缩的 JavaScript 文件')

  const minified = []
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')
    const relative = path.relative(directory, file)
    if (sourceMapDirectory && !INLINE_SOURCE_MAP.test(source)) {
      throw new Error(`${relative} 没有 tsc 生成的内联 source map，压缩后的对照表对不回 .ts（tsc 要带 --inlineSourceMap --inlineSources）`)
    }
    const result = await transformSource(source, {
      charset: 'utf8',
      format: 'cjs',
      legalComments: 'none',
      loader: 'js',
      minify: true,
      sourcefile: relative,
      // External: the map comes back beside the code instead of as a comment
      // in it, so the shipped file stays exactly what it was before maps existed.
      sourcemap: sourceMapDirectory ? 'external' : false,
      target: 'node22',
    })
    const code = `${result.code.trimEnd()}\n`
    // A map reference left in shipped code would make Electron, and anyone
    // reading app.asar, go looking for a file that is deliberately not there.
    if (code.includes('sourceMappingURL=')) throw new Error(`${relative} 压缩后仍带 sourceMappingURL，不能装进安装包`)
    if (sourceMapDirectory && !result.map) throw new Error(`${relative} 压缩后没有拿到 source map`)
    minified.push({ file, relative, code, map: result.map })
  }

  for (const { file, code } of minified) {
    await fs.writeFile(file, code, 'utf8')
  }
  if (sourceMapDirectory) {
    // Rebuilt from scratch: a map left over from an earlier compile would be
    // uploaded under this release and point frames at code that no longer exists.
    await fs.rm(sourceMapDirectory, { recursive: true, force: true })
    for (const { relative, code, map } of minified) {
      const target = path.join(sourceMapDirectory, relative)
      await fs.mkdir(path.dirname(target), { recursive: true })
      // The minified copy is what Sentry pairs the map with (foo.js beside foo.js.map).
      await fs.writeFile(target, code, 'utf8')
      await fs.writeFile(`${target}.map`, map, 'utf8')
    }
  }
  return files.length
}

async function main() {
  const count = await minifyElectronDirectory(root, { sourceMapDirectory: sourceMapRoot })
  console.log(`已压缩 ${count} 个 Electron JavaScript 文件，对照表在 ${path.relative(process.cwd(), sourceMapRoot)}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Electron JavaScript 压缩失败：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { listJavaScriptFiles, minifyElectronDirectory }
