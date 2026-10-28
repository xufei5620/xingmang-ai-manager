#!/usr/bin/env node
// 渲染层的 source map 搬出安装包（商业级差距报告 G06）。
//
// vite.config.ts 用 `sourcemap: 'hidden'` 出包：每个 .js 旁边多一个 .js.map，代码里不留指向它的注释。
// dist/ 整个目录都会装进 app.asar（electron-builder.config.cjs 的 files），所以 vite build 一完，这里就把
// .map 挪到 dist-sourcemaps/dist/，配一份同名的 .js（Sentry 认的是「foo.js 旁边的 foo.js.map」），
// 发版通过以后由 sentry-sourcemaps.cjs 传给 Sentry。客户电脑上不会有任何一份对照表。
const fs = require('node:fs/promises')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(target))
    else if (entry.isFile()) files.push(target)
  }
  return files
}

/**
 * 把 rendererDirectory 里的 .map 全部搬走。只有 .js.map 留给 Sentry（连同它对的那份 .js 一起抄过去），
 * 别的 .map（样式表的）直接删掉：Sentry 用不上，也不该进安装包。返回搬了几份 .js.map。
 */
async function stashRendererSourceMaps(rendererDirectory, sourceMapDirectory) {
  const files = await listFiles(rendererDirectory)
  const scripts = files.filter((file) => file.endsWith('.js'))
  for (const file of scripts) {
    // 'hidden' 本来就不写这行；真出现了说明配置被改回 true，客户端会去找一个不存在的文件。
    if ((await fs.readFile(file, 'utf8')).includes('sourceMappingURL=')) {
      throw new Error(`${path.relative(rendererDirectory, file)} 带着 sourceMappingURL，vite.config.ts 的 build.sourcemap 要用 'hidden'`)
    }
  }
  const maps = files.filter((file) => file.endsWith('.map'))
  const scriptMaps = maps.filter((file) => file.endsWith('.js.map'))
  if (scripts.length > 0 && scriptMaps.length === 0) {
    throw new Error('渲染层没有生成 source map，vite.config.ts 的 build.sourcemap 要用 \'hidden\'')
  }

  // 每次从头放：上一次编译留下的对照表会被当成这一版的传上去，指向早就不存在的代码。
  await fs.rm(sourceMapDirectory, { recursive: true, force: true })
  for (const map of scriptMaps) {
    const relative = path.relative(rendererDirectory, map)
    const script = map.slice(0, -'.map'.length)
    const target = path.join(sourceMapDirectory, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(script, target.slice(0, -'.map'.length))
    await fs.rename(map, target).catch(async (error) => {
      // 跨盘时 rename 不行，退回复制再删。
      if (error.code !== 'EXDEV') throw error
      await fs.copyFile(map, target)
      await fs.rm(map)
    })
  }
  for (const map of maps) {
    if (!scriptMaps.includes(map)) await fs.rm(map)
  }
  return scriptMaps.length
}

async function main() {
  const rendererDirectory = path.join(projectRoot, 'dist')
  const sourceMapDirectory = path.join(projectRoot, 'dist-sourcemaps', 'dist')
  const count = await stashRendererSourceMaps(rendererDirectory, sourceMapDirectory)
  console.log(`已把 ${count} 份渲染层对照表移到 ${path.relative(projectRoot, sourceMapDirectory)}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`渲染层对照表搬移失败：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { stashRendererSourceMaps }
