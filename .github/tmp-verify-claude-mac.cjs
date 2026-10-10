'use strict'

// 临时核对脚本：在 GitHub 的 Mac 机器上的 Electron 主进程里，用生产同款的 net.fetch
// （main.ts 的 downloadFetch）、真 codesign/spctl 跑一遍 installMacosDesktopApp('claudeDesktop')。
// 核完删掉，不进 main。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { app, net } = require('electron')
const { installMacosDesktopApp } = require('../dist-electron/macos-desktop-app-installer.js')
const { runCommand, trustedCommandEnvironment } = require('../dist-electron/command-runner.js')

const hardware = (() => {
  try { return execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1' ? 'arm64' : 'x64' } catch { return 'x64' }
})()
console.log(`runner: process.arch=${process.arch} hardware=${hardware} macOS ${execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()}`)

const cases = hardware === 'arm64'
  ? [
      { label: 'Apple 芯片，arm64 版星芒', architecture: 'arm64', expect: 'arm64' },
      { label: 'Apple 芯片，x64 版星芒（Rosetta）', architecture: 'x64', expect: 'arm64' },
      { label: 'Intel 包（sysctl 假装成 Intel）', architecture: 'x64', expect: 'x64', fakeIntel: true },
    ]
  : [{ label: 'Intel Mac，x64 版星芒', architecture: 'x64', expect: 'x64' }]

function inspect(bundle) {
  const read = (key) => {
    try { return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim() } catch { return '(无)' }
  }
  const archs = execFileSync('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents', 'MacOS', 'Claude')], { encoding: 'utf8' }).trim()
  let signature = ''
  try { execFileSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }) } catch (error) { signature = String(error.stderr) }
  if (!signature) signature = execFileSync('/bin/sh', ['-c', '/usr/bin/codesign -dv --verbose=2 "$1" 2>&1', 'sh', bundle], { encoding: 'utf8' })
  const keep = signature.split('\n').filter((line) => /^(Identifier|Authority|TeamIdentifier|Notarization|Format)=/.test(line))
  const gatekeeper = execFileSync('/bin/sh', ['-c', '/usr/sbin/spctl --assess --type execute -vv "$1" 2>&1; true', 'sh', bundle], { encoding: 'utf8' }).trim()
  console.log(`  CFBundleIdentifier=${read('CFBundleIdentifier')} CFBundleShortVersionString=${read('CFBundleShortVersionString')}`)
  console.log(`  LSMinimumSystemVersion=${read('LSMinimumSystemVersion')} LSRequiresNativeExecution=${read('LSRequiresNativeExecution')} LSArchitecturePriority=${read('LSArchitecturePriority')}`)
  console.log(`  lipo -archs: ${archs}`)
  for (const line of keep) console.log(`  ${line}`)
  console.log(`  spctl: ${gatekeeper.replace(/\n/g, ' | ')}`)
}

async function main() {
  let failed = false
  for (const entry of cases) {
    console.log(`\n=== ${entry.label}`)
    const root = fs.mkdtempSync(path.join(os.homedir(), 'claude-mac-verify-'))
    const home = path.join(root, 'home')
    const applications = path.join(root, 'Applications')
    fs.mkdirSync(home)
    fs.mkdirSync(applications)
    const requested = []
    const environment = { ...process.env, HOME: home }
    let last = ''
    try {
      const result = await installMacosDesktopApp({
        tool: 'claudeDesktop',
        architecture: entry.architecture,
        userHome: home,
        environment,
        systemApplicationsDirectory: applications,
        // Same shape as downloadFetch in electron/main.ts when no temporary route is active.
        fetch: async (input, init) => {
          const url = input instanceof URL ? input.href : input
          requested.push(String(url).replace(/device_id=[^&]+/, 'device_id=…'))
          const response = await net.fetch(url, init)
          console.log(`  net.fetch redirect=${init && init.redirect} -> HTTP ${response.status}, response.url=${JSON.stringify(response.url)}`)
          return response
        },
        runProcess: (plan) => {
          if (entry.fakeIntel && plan.executable === '/usr/sbin/sysctl') return Promise.resolve({ executable: plan.executable, argv: [...plan.argv], exitCode: 0, signal: null, stdout: '0\n', stderr: '', outputBytes: 2, durationMs: 0 })
          return runCommand({ executable: plan.executable, argv: [...plan.argv] }, { env: trustedCommandEnvironment(environment, undefined, 'darwin'), trustedOnly: false, timeoutMs: plan.timeoutMs, maxOutputBytes: 2 * 1024 * 1024 })
        },
        onProgress: (event) => { if (event.message !== last) { last = event.message; console.log(`  进度：${event.message}`) } },
      })
      for (const url of requested) console.log(`  请求：${url}`)
      console.log(`  装好：${result.version} -> ${result.path}`)
      inspect(result.path)
      const packageUrl = requested.find((url) => url.startsWith('https://downloads.claude.ai/')) ?? ''
      const archMatch = /\/releases\/darwin\/([^/]+)\//.exec(packageUrl)?.[1]
      if (archMatch !== entry.expect) {
        console.log(`  ✗ 期望 ${entry.expect} 的包，实际 ${archMatch}`)
        failed = true
      } else {
        console.log(`  ✓ 下的是 ${archMatch} 的包`)
      }
    } catch (error) {
      for (const url of requested) console.log(`  请求：${url}`)
      console.log(`  ✗ 没装好：${error.message}｜原因：${error.detail ?? ''}`)
      if (error.cause) console.log(`  cause: ${error.cause.message ?? error.cause}`)
      failed = true
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  if (failed) process.exitCode = 1
}

app.whenReady().then(async () => {
  console.log(`electron ${process.versions.electron}`)
  await main()
}).catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => app.exit(process.exitCode ?? 0))
