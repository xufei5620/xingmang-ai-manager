const fs = require('node:fs/promises')
const path = require('node:path')
const { transform } = require('esbuild')

const root = path.resolve(__dirname, '..', 'dist-electron')

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
  if (files.length === 0) throw new Error('dist-electron 中没有可压缩的 JavaScript 文件')

  const minified = []
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')
    const result = await transformSource(source, {
      charset: 'utf8',
      format: 'cjs',
      legalComments: 'none',
      loader: 'js',
      minify: true,
      sourcefile: path.relative(directory, file),
      sourcemap: false,
      target: 'node22',
    })
    minified.push([file, `${result.code.trimEnd()}\n`])
  }

  for (const [file, code] of minified) {
    await fs.writeFile(file, code, 'utf8')
  }
  return files.length
}

async function main() {
  const count = await minifyElectronDirectory(root)
  console.log(`已压缩 ${count} 个 Electron JavaScript 文件`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Electron JavaScript 压缩失败：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { listJavaScriptFiles, minifyElectronDirectory }
