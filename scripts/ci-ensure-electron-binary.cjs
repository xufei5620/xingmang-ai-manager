// 要用到 Electron 二进制的 CI 作业在 `npm ci` 之后先跑这一步，把二进制限时、带重试地装好。
//
// 为什么不等测试自己去装：Electron 43 起 npm 包没有 postinstall，`npm ci` 只解开外壳，
// 二进制要等第一次 `require('electron')` 时由 index.js 现场调 install.js 去下
// （@electron/get）。那次下载只发一个请求，不重试也不限时，网络一抖，碰巧最先加载
// Electron 的那个测试文件就带着「Electron failed to install correctly」红掉：
// - #319（2026-09-22）Windows vitest-1：GitHub 发布页两次回 HTTP 500，相隔 61 秒。
// - #796（2026-10-03）linux-test：`TypeError: fetch failed`。
// 这里每次尝试都有时限（@electron/get 卡住不会自己停），失败按递增间隔重试，间隔
// 加起来盖得住 #319 那种一分多钟的故障。每次下载都按包里的 checksums.json 校验，
// 重试只能补上一次失败的下载，放不进别的文件。
//
// `--zip <arch>`：只把这个平台另一个架构的 Electron 压缩包放进同一个下载缓存，不装二进制。
// macos-test、linux-test 存缓存之前跑它，于是缓存里两个架构都有，打包时（macos-test 自己
// 出 Intel 版、macos-intel、macos-release-rehearsal、linux-package 的 arm64）不用再去
// GitHub 下。11-09 #1600 的 macos-intel 就红在这上面：GitHub 对 darwin-arm64 压缩包连着
// 回了四分多钟 504，打包器重试六次全被挡。压缩包同样按 checksums.json 核对。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { setTimeout: delay } = require('node:timers/promises')
const { resolveLockedElectronZipChecksums } = require('./electron-zip-checksums.cjs')

const retryDelaysSeconds = [10, 30, 60, 120]
// 每次尝试（下载约 130 MB 的 zip 再解压）的总时限，不是测连接停没停。托管 runner 上
// 这一步通常十几秒，3 分钟够慢到约 0.7 MB/s 的线路下完；再慢，或连接挂住不动
// （@electron/get 自己不限时），就截断重来。五次都截断才报错，比一声不吭地等到作业
// 超时更早说清卡在哪。
const attemptTimeoutMs = 3 * 60 * 1000

// 只有这两个架构有打包作业要用；别的值多半是拼错，宁可当场报错。
const zipArchitectures = Object.freeze(['x64', 'arm64'])

function describeAttempt(result, script = '安装脚本') {
  if (result.error && result.error.code === 'ETIMEDOUT') return '没在限时内装完，已中止'
  if (result.error) return `${script}没能启动：${result.error.message}`
  if (result.signal) return `${script}被 ${result.signal} 中止`
  return `${script}退出码 ${result.status}`
}

async function retryAttempts({ run, sleep, log, delaysSeconds, script, warning, failure }) {
  for (let attempt = 1; ; attempt += 1) {
    const result = run()
    if (result.status === 0) return attempt
    const reason = describeAttempt(result, script)
    if (attempt > delaysSeconds.length) throw new Error(failure(attempt, reason))
    const wait = delaysSeconds[attempt - 1]
    log(`::warning::${warning(attempt, reason, wait)}`)
    await sleep(wait * 1000)
  }
}

async function ensureElectronBinary({ install, sleep = delay, log = console.log, delaysSeconds = retryDelaysSeconds }) {
  return retryAttempts({
    run: install,
    sleep,
    log,
    delaysSeconds,
    script: '安装脚本',
    warning: (attempt, reason, wait) => `第 ${attempt} 次安装 Electron 二进制失败（${reason}），${wait} 秒后重试`,
    failure: (attempt, reason) => `装了 ${attempt} 次 Electron 二进制都没成功（最后一次：${reason}），每次的原始报错在上面`,
  })
}

async function ensureElectronZip({ arch, download, sleep = delay, log = console.log, delaysSeconds = retryDelaysSeconds }) {
  return retryAttempts({
    run: download,
    sleep,
    log,
    delaysSeconds,
    script: '下载脚本',
    warning: (attempt, reason, wait) => `第 ${attempt} 次下载 ${arch} 版 Electron 压缩包失败（${reason}），${wait} 秒后重试`,
    failure: (attempt, reason) => `下了 ${attempt} 次 ${arch} 版 Electron 压缩包都没成功（最后一次：${reason}），每次的原始报错在上面`,
  })
}

function parseArguments(argv) {
  if (argv.length === 0) return { mode: 'binary' }
  if (argv.length === 2 && (argv[0] === '--zip' || argv[0] === '--download-zip') && zipArchitectures.includes(argv[1])) {
    return { mode: argv[0] === '--zip' ? 'zip' : 'download-zip', arch: argv[1] }
  }
  throw new Error(`参数不认识：${argv.join(' ')}；只接受不带参数，或 --zip ${zipArchitectures.join('|')}`)
}

// One attempt, run in a child process so the parent's spawnSync timeout can
// stop a download that hangs (@electron/get sets no deadline of its own). No
// cacheRoot: it has to be the default folder the workflow caches and
// electron-builder reads. A zip already there is only checked, not fetched.
async function downloadElectronZip({ arch, packageDirectory, platform = process.platform, downloadArtifact }) {
  const { version } = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
  const checksums = resolveLockedElectronZipChecksums({ projectRoot: path.resolve(packageDirectory, '..', '..') })
  return downloadArtifact({ version, artifactName: 'electron', platform, arch, checksums })
}

async function main() {
  const { mode, arch } = parseArguments(process.argv.slice(2))
  const packageDirectory = path.dirname(require.resolve('electron/package.json', { paths: [path.resolve(__dirname, '..')] }))
  const { version } = require(path.join(packageDirectory, 'package.json'))
  if (mode === 'download-zip') {
    const { downloadArtifact } = await import(pathToFileURL(require.resolve('@electron/get', { paths: [packageDirectory] })).href)
    const file = await downloadElectronZip({ arch, packageDirectory, downloadArtifact })
    console.log(`Electron ${version} ${process.platform}-${arch} 压缩包已核对：${file}`)
    return
  }
  if (mode === 'zip') {
    const zipAttempts = await ensureElectronZip({
      arch,
      download: () => spawnSync(process.execPath, [__filename, '--download-zip', arch], { stdio: 'inherit', timeout: attemptTimeoutMs }),
    })
    console.log(`Electron ${version} ${process.platform}-${arch} 压缩包已在下载缓存里（第 ${zipAttempts} 次尝试）`)
    return
  }
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

module.exports = { attemptTimeoutMs, describeAttempt, downloadElectronZip, ensureElectronBinary, ensureElectronZip, parseArguments, retryDelaysSeconds, zipArchitectures }
