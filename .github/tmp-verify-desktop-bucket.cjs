'use strict'

// 临时核对脚本：在 GitHub 的 Mac、Windows 机器上用真网络、真签名核对跑一遍存储桶那一路。
// 不许退回官方那一路：退回就算失败。Windows 上不真装（只核对到交给 Windows 之前）。
// 开 PR 前删掉，不进 main。第二次跑：审查后 Claude 的 PKG 先核安装包签名再展开，签名对不上也会退回、算失败。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function timed(fetchImplementation, requested) {
  return (input, init) => {
    requested.push(String(input))
    return fetchImplementation(input, init)
  }
}

function progressLogger() {
  let last = ''
  let lastPercent = -10
  return (event) => {
    const percent = typeof event.percent === 'number' ? event.percent : null
    if (event.message === last && (percent === null || percent - lastPercent < 10)) return
    last = event.message
    if (percent !== null) lastPercent = percent
    console.log(`  进度：${event.message}${percent === null ? '' : `（${percent}%）`}  ${new Date().toISOString()}`)
  }
}

async function verifyMac() {
  const { installMacosDesktopApp } = require('../dist-electron/macos-desktop-app-installer.js')
  const { runCommand, trustedCommandEnvironment } = require('../dist-electron/command-runner.js')
  const hardware = (() => {
    try { return execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1' ? 'arm64' : 'x64' } catch { return 'x64' }
  })()
  console.log(`runner: process.arch=${process.arch} hardware=${hardware} macOS ${execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()}`)
  let failed = false
  for (const tool of ['codexDesktop', 'claudeDesktop']) {
    console.log(`\n=== ${tool}`)
    const root = fs.mkdtempSync(path.join(os.homedir(), 'bucket-verify-'))
    const home = path.join(root, 'home')
    const applications = path.join(root, 'Applications')
    fs.mkdirSync(home)
    fs.mkdirSync(applications)
    const requested = []
    const environment = { ...process.env, HOME: home }
    let fallback = null
    const started = Date.now()
    try {
      const result = await installMacosDesktopApp({
        tool,
        architecture: hardware,
        userHome: home,
        environment,
        systemApplicationsDirectory: applications,
        fetch: timed(fetch, requested),
        runProcess: (plan) => runCommand({ executable: plan.executable, argv: [...plan.argv] }, { env: trustedCommandEnvironment(environment, undefined, 'darwin'), trustedOnly: false, timeoutMs: plan.timeoutMs, maxOutputBytes: 2 * 1024 * 1024 }),
        onProgress: progressLogger(),
        bucket: { onFallback: (detail) => { fallback = detail } },
        withVendorDownloadRoute: async () => { throw new Error(`存储桶那一路没走通，退回了官方：${fallback}`) },
      })
      for (const url of requested) console.log(`  请求：${url}`)
      console.log(`  装好：${result.version} -> ${result.path}，用时 ${Math.round((Date.now() - started) / 1000)} 秒`)
      const bundle = result.path
      const executable = tool === 'codexDesktop' ? 'ChatGPT' : 'Claude'
      const read = (key) => { try { return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim() } catch { return '(无)' } }
      console.log(`  CFBundleIdentifier=${read('CFBundleIdentifier')} CFBundleShortVersionString=${read('CFBundleShortVersionString')} LSMinimumSystemVersion=${read('LSMinimumSystemVersion')}`)
      console.log(`  lipo -archs: ${execFileSync('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents', 'MacOS', executable)], { encoding: 'utf8' }).trim()}`)
      console.log(`  spctl: ${execFileSync('/bin/sh', ['-c', '/usr/sbin/spctl --assess --type execute -vv "$1" 2>&1; true', 'sh', bundle], { encoding: 'utf8' }).trim().replace(/\n/g, ' | ')}`)
      if (fallback) { console.log(`  ✗ 有过退回：${fallback}`); failed = true } else console.log('  ✓ 全程走的存储桶')
    } catch (error) {
      for (const url of requested) console.log(`  请求：${url}`)
      console.log(`  ✗ 没装好：${error.message}｜原因：${error.detail ?? ''}`)
      if (error.cause) console.log(`  cause: ${error.cause.message ?? error.cause}`)
      failed = true
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  return failed
}

async function verifyWindows() {
  const { downloadCodexDesktopBucketPackage } = require('../dist-electron/codex-desktop-service.js')
  const { installClaudeDesktopFromBucket } = require('../dist-electron/claude-desktop-msix-installer.js')
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  console.log(`runner: process.arch=${process.arch} ${os.release()}`)
  let failed = false

  console.log('\n=== Codex 桌面端（Windows）')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-verify-'))
  const requested = []
  let started = Date.now()
  try {
    const result = await downloadCodexDesktopBucketPackage({
      architecture,
      destination: path.join(directory, `ChatGPT-${architecture}.msix`),
      installedVersion: null,
      fetchImplementation: timed(fetch, requested),
      onVersion: (version) => console.log(`  清单版本：${version}`),
      onProgress: (_version, progress) => { if (progress.percent % 10 === 0 || progress.resuming) console.log(`  下载：${progress.percent}%${progress.resuming ? '（接着下）' : ''}  ${new Date().toISOString()}`) },
      onValidating: () => console.log('  正在核对包身份、发布者、签名'),
    })
    for (const url of requested) console.log(`  请求：${url}`)
    console.log(`  ✓ ${JSON.stringify({ status: result.status, version: result.version, size: result.download?.size })}，用时 ${Math.round((Date.now() - started) / 1000)} 秒`)
  } catch (error) {
    for (const url of requested) console.log(`  请求：${url}`)
    console.log(`  ✗ ${error.name}：${error.message}`)
    if (error.cause) console.log(`  cause: ${error.cause.message ?? error.cause}`)
    failed = true
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }

  console.log('\n=== Claude Desktop（Windows，不真装）')
  const claudeRequested = []
  started = Date.now()
  try {
    const result = await installClaudeDesktopFromBucket({
      architecture,
      fetch: timed(fetch, claudeRequested),
      platform: 'win32',
      windowsExecutionMode: 'same-user',
      onProgress: progressLogger(),
      installPackage: async (file, options) => {
        console.log(`  交给 Windows 装之前停下：${path.basename(file)} ${options.contentLength} 字节`)
      },
    })
    for (const url of claudeRequested) console.log(`  请求：${url}`)
    console.log(`  ✓ 核对通过：${result.version}，用时 ${Math.round((Date.now() - started) / 1000)} 秒`)
  } catch (error) {
    for (const url of claudeRequested) console.log(`  请求：${url}`)
    console.log(`  ✗ ${error.name}：${error.message}`)
    if (error.cause) console.log(`  cause: ${error.cause.message ?? error.cause}`)
    failed = true
  }
  return failed
}

async function main() {
  const failed = process.platform === 'darwin' ? await verifyMac() : await verifyWindows()
  if (failed) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
