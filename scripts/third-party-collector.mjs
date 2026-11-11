// Vite 插件：记下一次构建实际打进产物的 node_modules 包，交给 scripts/third-party-notices.cjs
// 拼成随包的第三方许可清单（D97）。
//
// 只读不写产物：名单写在 dist-third-party/ 里，不进 dist/、dist-canvas/，安装包和画布的出网门禁
// 都看不到它。后台线程（Worker）是 Vite 另起的一次打包，主构建的插件看不见，要把 workerPlugin()
// 挂到 worker.plugins 上，两边记进同一份名单——Vite 自带的 build.license 就漏在这里。
//
// 名单只在构建目录是 expectedOutDir 时才写：check:legacy 打进 dist-legacy/、测试夹具打进临时
// 目录，那些产物不进安装包，不能拿它们的名单盖掉正式那份。
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  buildBundleManifest,
  resolvePackageDirectoryFromModuleId,
  resolveToolchainPackageFromModuleId,
  writeBundleManifest,
} = require('./third-party-notices.cjs')

function recordOutput(state, output) {
  for (const item of Object.values(output)) {
    if (item.type !== 'chunk') continue
    for (const moduleId of item.moduleIds) {
      const directory = resolvePackageDirectoryFromModuleId(moduleId)
      if (directory) state.packageDirectories.add(path.resolve(directory))
      const toolchain = resolveToolchainPackageFromModuleId(moduleId)
      if (toolchain) state.toolchainPackages.add(toolchain)
    }
  }
}

export function createThirdPartyCollector({ bundle, projectRoot, expectedOutDir, renderer }) {
  const state = {
    enabled: false,
    outDir: null,
    chunks: [],
    workerBuilds: 0,
    packageDirectories: new Set(),
    toolchainPackages: new Set(),
  }
  const plugin = {
    name: 'xingmang-third-party-collector',
    apply: 'build',
    configResolved(config) {
      state.outDir = path.resolve(config.root, config.build.outDir)
      state.enabled = state.outDir === path.resolve(projectRoot, expectedOutDir)
    },
    buildStart() {
      state.chunks = []
      state.workerBuilds = 0
      state.packageDirectories.clear()
      state.toolchainPackages.clear()
    },
    generateBundle(_options, output) {
      recordOutput(state, output)
      state.chunks = Object.values(output).filter((item) => item.type === 'chunk').map((item) => item.fileName)
    },
    writeBundle() {
      if (!state.enabled) return
      writeBundleManifest(projectRoot, buildBundleManifest({
        bundle,
        renderer,
        chunks: state.chunks,
        workerBuilds: state.workerBuilds,
        packageDirectories: [...state.packageDirectories],
        toolchainPackages: [...state.toolchainPackages],
      }))
    },
  }
  function workerPlugin() {
    return {
      name: 'xingmang-third-party-collector-worker',
      generateBundle(_options, output) {
        state.workerBuilds += 1
        recordOutput(state, output)
      },
    }
  }
  return { plugin, workerPlugin }
}
