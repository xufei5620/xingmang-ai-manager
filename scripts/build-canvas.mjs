// 构建画布：等同于 `vite build canvas-v2 --config canvas-v2/vite.config.ts`，只多挂一个只读的
// 第三方包名单插件（D97，见 scripts/third-party-collector.mjs）。
//
// canvas-v2/ 不碰（项目规矩、AGENTS.md T13）：配置照用画布那份，插件从这里以内联配置传进去，
// Vite 把它跟配置文件里的 plugins 接在一起；后台线程（图层抠图）那一半挂在 worker.plugins 上。
// 插件只读模块名单、不改产物，dist-canvas/ 里的每个字节跟原来那条命令打出来的一样。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { createThirdPartyCollector } from './third-party-collector.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canvasRoot = path.join(projectRoot, 'canvas-v2')
const thirdParty = createThirdPartyCollector({
  bundle: 'canvas',
  projectRoot,
  expectedOutDir: path.join('canvas-v2', 'dist'),
})

await build({
  root: canvasRoot,
  configFile: path.join(canvasRoot, 'vite.config.ts'),
  plugins: [thirdParty.plugin],
  worker: { plugins: () => [thirdParty.workerPlugin()] },
})
