const { mkdirSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const XCRUN_PATH = '/usr/bin/xcrun'
// A cold runner has to page in the Swift toolchain and the macOS SDK before
// it compiles anything, so the budget is generous. What it buys is that a
// wedged xcrun fails the build with a reason instead of holding the job open
// until the CI timeout kills it with none.
const COMPILE_TIMEOUT_MS = 10 * 60_000

function swiftcArguments(arch, target, fixture) {
  return [
    'swiftc',
    '-target', `${arch}-apple-macosx13.0`,
    ...(fixture ? ['-D', 'PROXY_TEST_BACKEND'] : []),
    '-O',
    path.join(root, 'native/macos-system-proxy.swift'),
    '-o', path.join(root, `dist-native/macos-system-proxy-${target}`),
  ]
}

/** The three ways a compile can end badly read nothing alike, and reporting
 * them as one "exit code" line sends the reader looking at the Swift source
 * for a toolchain that never started. */
function describeCompileFailure(result, arch) {
  if (result.error) {
    return result.error.code === 'ETIMEDOUT'
      ? `编译 ${arch} 超过 ${COMPILE_TIMEOUT_MS / 1000} 秒未结束，已终止`
      : `无法运行 ${XCRUN_PATH}（${arch}）：${result.error.message}`
  }
  if (result.signal) return `编译 ${arch} 被信号 ${result.signal} 终止`
  if (result.status !== 0) return `swiftc 编译 ${arch} 失败：退出码 ${result.status}`
  return null
}

function main(argv = process.argv, options = {}) {
  const run = options.spawnSync || spawnSync
  const ensureDirectory = options.ensureDirectory ||
    ((directory) => mkdirSync(directory, { recursive: true }))
  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('macOS helper requires the macOS SDK')
  }
  ensureDirectory(path.join(root, 'dist-native'))
  const fixture = argv.includes('--test')
  const hostArch = options.arch || process.arch
  for (const arch of fixture ? [hostArch === 'arm64' ? 'arm64' : 'x86_64'] : ['arm64', 'x86_64']) {
    const target = fixture ? 'test' : arch === 'x86_64' ? 'x64' : arch
    const result = run(XCRUN_PATH, swiftcArguments(arch, target, fixture), {
      shell: false,
      stdio: options.stdio || 'inherit',
      timeout: COMPILE_TIMEOUT_MS,
      windowsHide: true,
    })
    const failure = describeCompileFailure(result, arch)
    if (failure) throw new Error(failure)
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`构建 macOS 网络组件失败：${error.message}`)
    process.exit(1)
  }
}

module.exports = {
  COMPILE_TIMEOUT_MS,
  XCRUN_PATH,
  describeCompileFailure,
  main,
  swiftcArguments,
}
