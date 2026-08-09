// `npm run dev` 启动时的一次性主进程预编译。
//
// 为什么需要它：dev 用 `wait-on ... dist-electron/main.js` 决定何时拉起
// electron，但这个条件只检查文件**存在**，而 tsc --watch 是逐个文件落盘的，
// 于是有两条竞态：
//   1. 上一轮构建残留的 dist-electron/main.js 会让 wait-on 立即满足，
//      electron 抢在本轮 tsc 写完之前启动，加载到的是旧代码；
//   2. 干净目录下 main.js 可能先于它 import 的模块落盘，electron 启动即
//      require 到一个还不存在的文件而崩溃。
// 两条的共同点是「watch 模式没有可依赖的首编译完成信号」，所以这里在
// concurrently 拉起任何东西之前先跑一次完整编译，让 dist-electron 在 dev
// 真正开始时就是自洽的；watch 之后只负责增量。
//
// 类型错误不阻断 dev：tsc 未开 noEmitOnError，报错时仍会产出可运行的
// 产物，而 dev 面板里的 tsc --watch 会持续把错误显示出来，真正的门槛是
// `npm run typecheck`。这里保持「有类型错也能起来调试」的既有手感，只把
// 竞态修掉，因此编译失败时打一条中文提示后以 0 退出。
//
// 用 node 直接驱动 typescript 的入口而不是 node_modules/.bin/tsc：后者在
// Windows 上是 .cmd shim，spawn 它需要 shell，而本仓库的约定是永不 shell
// （CLAUDE.md I1）。
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const projectRoot = process.cwd()
const compiler = path.resolve(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const project = path.resolve(projectRoot, 'tsconfig.electron.json')

const result = spawnSync(
  process.execPath,
  [compiler, '-p', project],
  { stdio: 'inherit', shell: false },
)

if (result.error) {
  console.warn(
    `[prebuild-electron-dev] 未能启动 TypeScript（${result.error.message}），跳过预编译。`
    + 'dist-electron 可能是上一轮的产物，如遇 electron 启动报错请先跑 npm run compile。',
  )
  process.exit(0)
}

if (result.status !== 0) {
  console.warn(
    '[prebuild-electron-dev] 主进程存在类型错误（产物已照常生成，dev 会继续启动）。'
    + '完整校验请跑 npm run typecheck。',
  )
}

process.exit(0)
