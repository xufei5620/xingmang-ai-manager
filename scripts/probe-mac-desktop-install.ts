// 临时检查（核完连同工作流一起删掉，不进 main）：在 GitHub 的 macOS runner 上用真的
// installMacosDesktopApp 把 Claude Desktop 和 Codex 桌面端（ChatGPT）装进临时目录，
// 再用工具箱自己的检测认一遍。不装进 /Applications，不打开任何应用。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCommand, trustedCommandEnvironment } from '../electron/command-runner'
import { darwinDeveloperIdVerificationArgv } from '../electron/macos-code-signing'
import { inspectMacosCodexApp } from '../electron/macos-codex-app'
import {
  installMacosDesktopApp,
  MacosDesktopInstallError,
  type MacosDesktopAppId,
  type MacosDesktopAppProcess,
} from '../electron/macos-desktop-app-installer'
import { macosDesktopNameTakenMessage, macosLegacyChatgptMessage } from '../electron/macos-desktop-install-failure'
import { managedProductRoot } from '../electron/managed-cli-paths'

const results: Array<{ check: string, ok: boolean, detail?: unknown }> = []

function record(check: string, ok: boolean, detail?: unknown): void {
  results.push({ check, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${check}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
}

function runProcess(plan: MacosDesktopAppProcess) {
  return runCommand({ executable: plan.executable, argv: [...plan.argv] }, {
    env: trustedCommandEnvironment(), trustedOnly: false, timeoutMs: plan.timeoutMs, maxOutputBytes: 2 * 1024 * 1024,
  })
}

async function command(executable: string, argv: string[]): Promise<{ ok: boolean, stdout: string, error?: string }> {
  try {
    const result = await runProcess({ executable, argv, timeoutMs: 180_000 })
    return { ok: true, stdout: result.stdout.trim() }
  } catch (error) {
    return { ok: false, stdout: '', error: error instanceof Error ? error.message.slice(0, 300) : String(error) }
  }
}

function temporary(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `xm-probe-${label}-`))
}

function stagingEntries(): string[] {
  const parent = path.posix.join(managedProductRoot(process.env, 'darwin'), 'DesktopApps')
  return fs.existsSync(parent) ? fs.readdirSync(parent) : []
}

async function install(tool: MacosDesktopAppId, architecture: 'arm64' | 'x64', userHome: string, applications: string, signal?: AbortSignal) {
  const progress: string[] = []
  let last = ''
  const started = Date.now()
  const result = await installMacosDesktopApp({
    tool, architecture, userHome, environment: process.env, fetch, runProcess,
    systemApplicationsDirectory: applications,
    onProgress: (event) => {
      const line = `${event.phase} ${event.message}${event.percent === null ? '' : ` ${event.percent}%`}`
      if (event.message !== last || event.percent === null || event.percent % 25 === 0) progress.push(line)
      last = event.message
    },
    ...(signal ? { signal } : {}),
  })
  return { result, progress, seconds: (Date.now() - started) / 1000 }
}

async function checkInstalledBundle(label: string, bundle: string, identifier: string, team: string): Promise<void> {
  const plistIdentifier = await command('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.posix.join(bundle, 'Contents', 'Info.plist')])
  record(`${label}: installed bundle identifier is ${identifier}`, plistIdentifier.stdout === identifier, plistIdentifier)
  const pinned = await command('/usr/bin/codesign', darwinDeveloperIdVerificationArgv(team, bundle, { deep: true, bundleIdentifier: identifier }))
  record(`${label}: pinned Developer ID requirement still passes after the move`, pinned.ok, pinned.error)
  const gatekeeper = await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', bundle])
  record(`${label}: Gatekeeper accepts the installed copy`, gatekeeper.ok, gatekeeper.error)
  const quarantine = await command('/usr/bin/xattr', ['-p', 'com.apple.quarantine', bundle])
  record(`${label}: no quarantine flag`, !quarantine.ok)
  const lipo = await command('/usr/bin/lipo', ['-archs', path.posix.join(bundle, 'Contents', 'MacOS', path.basename(bundle, '.app'))])
  record(`${label}: main executable architectures`, lipo.ok, lipo.stdout || lipo.error)
}

async function main(): Promise<void> {
  record('system version', true, (await command('/usr/bin/sw_vers', ['-productVersion'])).stdout)
  const native = await command('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])
  record('native sysctl hw.optional.arm64 is 1', native.stdout === '1', native)
  const translated = await command('/usr/bin/arch', ['-x86_64', '/usr/sbin/sysctl', '-n', 'hw.optional.arm64'])
  record('sysctl hw.optional.arm64 under Rosetta (x64 toolbox case)', translated.stdout === '1', translated)

  // A. Claude Desktop for a customer who is not an administrator: /Applications not writable.
  {
    const home = temporary('claude-home')
    const locked = temporary('claude-locked')
    fs.chmodSync(locked, 0o555)
    try {
      const installed = await install('claudeDesktop', 'arm64', home, locked)
      record('Claude Desktop: installed', true, { ...installed.result, seconds: installed.seconds, progress: installed.progress })
      record('Claude Desktop: went into ~/Applications', installed.result.path === path.posix.join(home, 'Applications', 'Claude.app'), installed.result.path)
      record('Claude Desktop: nothing written to the locked folder', fs.readdirSync(locked).length === 0)
      await checkInstalledBundle('Claude Desktop', installed.result.path, 'com.anthropic.claudefordesktop', 'Q6L2SF6YDW')
    } catch (error) {
      record('Claude Desktop: installed', false, { message: (error as Error).message, detail: (error as MacosDesktopInstallError).detail })
    }
    record('Claude Desktop: staging cleaned up', stagingEntries().every((entry) => !entry.startsWith('staging-')), stagingEntries())
  }

  // B, C. Codex desktop for both chips, then the toolbox's own detection on each.
  for (const architecture of ['arm64', 'x64'] as const) {
    const label = `Codex desktop ${architecture}`
    const applications = temporary(`codex-${architecture}`)
    const emptyHome = temporary(`codex-${architecture}-home`)
    try {
      const installed = await install('codexDesktop', architecture, emptyHome, applications)
      record(`${label}: installed`, true, { ...installed.result, seconds: installed.seconds, progress: installed.progress })
      record(`${label}: named ChatGPT.app`, installed.result.path === path.posix.join(applications, 'ChatGPT.app'), installed.result.path)
      await checkInstalledBundle(label, installed.result.path, 'com.openai.codex', '2DC432GLL2')
      const detected = await inspectMacosCodexApp({ systemApplicationsDirectory: applications, homeDirectory: emptyHome, architecture })
      record(`${label}: toolbox detection finds it`, detected.app?.path === installed.result.path && !detected.detectionFailed, detected)
      fs.rmSync(applications, { recursive: true, force: true })
    } catch (error) {
      record(`${label}: installed`, false, { message: (error as Error).message, detail: (error as MacosDesktopInstallError).detail })
    }
  }

  // D. The Intel path of the Claude feed names the same universal package.
  {
    const feed = async (architecture: string) => {
      const url = new URL(`https://api.anthropic.com/api/desktop/darwin/${architecture}/squirrel/update`)
      url.search = new URLSearchParams({ device_id: crypto.randomUUID(), os_version: (await command('/usr/bin/sw_vers', ['-productVersion'])).stdout }).toString()
      const body = await (await fetch(url, { redirect: 'manual' })).json() as { currentRelease?: string, releases?: Array<{ version: string, updateTo: { url: string } }> }
      return body.releases?.find((entry) => entry.version === body.currentRelease)?.updateTo.url ?? null
    }
    const [arm, intel] = [await feed('arm64'), await feed('x64')]
    record('Claude feed: Intel and Apple silicon get the same universal zip', Boolean(arm) && arm === intel, { arm, intel })
  }

  // E. A name already taken: the old ChatGPT chat app, and an unknown app.
  for (const [identifier, expected] of [['com.openai.chat', macosLegacyChatgptMessage], ['com.example.chatgpt', macosDesktopNameTakenMessage('ChatGPT')]] as const) {
    const applications = temporary('codex-taken')
    const contents = path.posix.join(applications, 'ChatGPT.app', 'Contents')
    fs.mkdirSync(contents, { recursive: true })
    fs.writeFileSync(path.posix.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>ChatGPT</string></dict></plist>
`)
    const started = Date.now()
    const outcome = await install('codexDesktop', 'arm64', temporary('codex-taken-home'), applications).then(() => null, (error: unknown) => error)
    const message = outcome instanceof Error ? outcome.message : String(outcome)
    record(`name taken by ${identifier}: says so before downloading`, message === expected && Date.now() - started < 30_000, { message, seconds: (Date.now() - started) / 1000 })
    record(`name taken by ${identifier}: the app in the way is untouched`, fs.readdirSync(contents).join(',') === 'Info.plist')
  }

  // F. Cancelling halfway through the download.
  {
    const applications = temporary('codex-cancel')
    const controller = new AbortController()
    const started = Date.now()
    const outcome = await installMacosDesktopApp({
      tool: 'codexDesktop', architecture: 'arm64', userHome: temporary('codex-cancel-home'), environment: process.env, fetch, runProcess,
      systemApplicationsDirectory: applications,
      onProgress: (event) => { if (event.phase === 'downloading' && (event.percent ?? 0) >= 5) controller.abort() },
      signal: controller.signal,
    }).then(() => null, (error: unknown) => error)
    record('cancel: rejects with the abort itself, not an install failure', outcome instanceof Error && !(outcome instanceof MacosDesktopInstallError) && outcome.name === 'AbortError', { name: (outcome as Error | null)?.name, message: (outcome as Error | null)?.message, seconds: (Date.now() - started) / 1000 })
    record('cancel: nothing placed', fs.readdirSync(applications).length === 0)
    record('cancel: staging cleaned up', stagingEntries().every((entry) => !entry.startsWith('staging-')), stagingEntries())
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
