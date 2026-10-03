// 要用到 Electron 二进制的 CI 作业在 `npm ci` 之后先跑这一步，把二进制限时、带重试地装好。
//
// 为什么不等测试自己去装：Electron 43 的 npm 包没有 postinstall，`npm ci` 只解开外壳，
// 二进制要等第一次 `require('electron')` 时由 index.js 现场调 install.js 去下
// （@electron/get）。那次下载只发一个请求，不重试也不限时，网络一抖，碰巧最先加载
// Electron 的那个测试文件就带着「Electron failed to install correctly」红掉：
// - #319（2026-09-22）Windows vitest-1：GitHub 发布页两次回 HTTP 500，相隔 61 秒。
// - #796（2026-10-03）linux-test：`TypeError: fetch failed`。
// 这里每次尝试都有时限（@electron/get 卡住不会自己停），失败按递增间隔重试，间隔
// 加起来盖得住 #319 那种一分多钟的故障。每次下载都按包里的 checksums.json 校验，
// 重试只能补上一次失败的下载，放不进别的文件。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const retryDelaysSeconds = [10, 30, 60, 120]
// 一次是从 GitHub 发布页下一个约 130 MB 的 zip，托管 runner 上几秒钟；这个时限
// 只管连接挂住不动的情况。
const attemptTimeoutMs = 3 * 60 * 1000

function describeAttempt(result) {
  if (result.error && result.error.code === 'ETIMEDOUT') return '没在限时内装完，已中止'
  if (result.error) return `安装脚本没能启动：${result.error.message}`
  if (result.signal) return `安装脚本被 ${result.signal} 中止`
  return `安装脚本退出码 ${result.status}`
}

async function ensureElectronBinary({ install, sleep = delay, log = console.log, delaysSeconds = retryDelaysSeconds }) {
  for (let attempt = 1; ; attempt += 1) {
    const result = install()
    if (result.status === 0) return attempt
    const reason = describeAttempt(result)
    if (attempt > delaysSeconds.length) {
      throw new Error(`装了 ${attempt} 次 Electron 二进制都没成功（最后一次：${reason}），每次的原始报错在上面`)
    }
    const wait = delaysSeconds[attempt - 1]
    log(`::warning::第 ${attempt} 次安装 Electron 二进制失败（${reason}），${wait} 秒后重试`)
    await sleep(wait * 1000)
  }
}

async function main() {
  const packageDirectory = path.dirname(require.resolve('electron/package.json', { paths: [path.resolve(__dirname, '..')] }))
  const { version } = require(path.join(packageDirectory, 'package.json'))
  const attempts = await ensureElectronBinary({
    // install.js 发现同版本已装好会直接退出 0，本地跑这一步不会重下。
    install: () => spawnSync(process.execPath, [path.join(packageDirectory, 'install.js')], { stdio: 'inherit', timeout: attemptTimeoutMs }),
  })
  // 测试就是这样拿到路径的；二进制在位时这里只读 path.txt，不会再触发下载。
  const executable = require(packageDirectory)
  if (!fs.existsSync(executable)) throw new Error(`Electron ${version} 安装脚本报告成功，但 ${executable} 不存在`)
  console.log(`Electron ${version} 二进制已就绪（第 ${attempts} 次尝试）：${executable}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { attemptTimeoutMs, describeAttempt, ensureElectronBinary, retryDelaysSeconds }
