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

async function main() {
  const files = await listJavaScriptFiles(root)
  if (files.length === 0) throw new Error('dist-electron 中没有可压缩的 JavaScript 文件')

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')
    const result = await transform(source, {
      charset: 'utf8',
      format: 'cjs',
      legalComments: 'none',
      loader: 'js',
      minify: true,
      sourcefile: path.relative(root, file),
      sourcemap: false,
      target: 'node22',
    })
    await fs.writeFile(file, `${result.code.trimEnd()}\n`, 'utf8')
  }

  console.log(`已压缩 ${files.length} 个 Electron JavaScript 文件`)
}

main().catch((error) => {
  console.error(`Electron JavaScript 压缩失败：${error.message}`)
  process.exitCode = 1
})
