import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRunnerError, type CommandResult } from './command-runner'
import {
  fetchMacosDesktopResource,
  installMacosDesktopApp,
  isMacosVersionBelow,
  macosDesktopAppInstallable,
  MacosDesktopInstallFailure,
  type InstallMacosDesktopAppOptions,
  type MacosDesktopAppProcess,
} from './macos-desktop-app-installer'
import {
  isMacosDesktopInstallFailure,
  isMacosDesktopSystemTooOld,
  macosDesktopNotOfficialMessage,
} from './macos-desktop-install-failure'
import { managedProductRoot } from './managed-cli-paths'

const feedUrl = 'https://github.com/anomalyco/opencode/releases/latest/download/latest.json'
const pinnedFeedUrl = 'https://github.com/anomalyco/opencode/releases/download/v1.18.34/latest.json'
const packageUrl = (architecture: string) => `https://github.com/anomalyco/opencode/releases/download/v1.18.34/opencode-desktop-mac-${architecture}.app.tar.gz`
const assetUrl = (name: string) => `https://release-assets.githubusercontent.com/github-production-release-asset/1/${name}?sp=r&sig=abc`
const archiveBytes = Buffer.alloc(256 * 1024, 3)

function feed(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: '1.18.34',
    platforms: {
      'darwin-aarch64': { url: packageUrl('arm64'), signature: 'x' },
      'darwin-x86_64': { url: packageUrl('x64'), signature: 'x' },
      'windows-x86_64': { url: 'https://github.com/anomalyco/opencode/releases/download/v1.18.34/opencode-desktop-win-x64.exe', signature: 'x' },
    },
    ...overrides,
  })
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

interface FakeNetworkOptions {
  feedBody?: string
  failPackage?: boolean
}

function fakeNetwork(options: FakeNetworkOptions = {}) {
  const requested: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requested.push(url)
    expect(init?.redirect).toBe('manual')
    if (url === feedUrl) return redirect(pinnedFeedUrl)
    if (url === pinnedFeedUrl) return redirect(assetUrl('latest.json'))
    if (url === assetUrl('latest.json')) return new Response(options.feedBody ?? feed())
    if (url.endsWith('.app.tar.gz')) return redirect(assetUrl(path.posix.basename(url)))
    if (url.startsWith(assetUrl('opencode-desktop-mac-').split('?')[0])) {
      if (options.failPackage) throw new TypeError('fetch failed')
      return new Response(archiveBytes, { headers: { 'content-length': String(archiveBytes.byteLength) } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, requested }
}

interface FakeProcessOptions {
  extraTopLevelEntry?: boolean
  bundleIdentifier?: string
  minimumSystemVersion?: string
  systemVersion?: string
  rejectExecutable?: string
}

function result(plan: MacosDesktopAppProcess, stdout = ''): CommandResult {
  return { executable: plan.executable, argv: [...plan.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 }
}

function rejection(plan: MacosDesktopAppProcess): CommandRunnerError {
  return new CommandRunnerError(`${plan.executable} rejected`, {
    code: 'EXIT_NON_ZERO', executable: plan.executable, argv: [...plan.argv], exitCode: 1, signal: null,
    stdout: '', stderr: '', outputBytes: 0, maxOutputBytes: 1, durationMs: 1,
  })
}

function fakeProcesses(options: FakeProcessOptions = {}) {
  const plans: MacosDesktopAppProcess[] = []
  async function runProcess(plan: MacosDesktopAppProcess): Promise<CommandResult> {
    plans.push(plan)
    if (plan.executable === options.rejectExecutable) throw rejection(plan)
    if (plan.executable === '/usr/bin/tar') {
      const destination = plan.argv[3]
      fs.mkdirSync(path.join(destination, 'OpenCode.app', 'Contents', 'MacOS'), { recursive: true })
      fs.writeFileSync(path.join(destination, 'OpenCode.app', 'Contents', 'MacOS', 'OpenCode'), 'binary', { mode: 0o755 })
      if (options.extraTopLevelEntry) fs.writeFileSync(path.join(destination, 'README'), '')
      return result(plan)
    }
    if (plan.executable === '/usr/bin/plutil') {
      return result(plan, JSON.stringify({
        CFBundleIdentifier: options.bundleIdentifier ?? 'ai.opencode.desktop',
        CFBundleShortVersionString: '1.18.34',
        LSMinimumSystemVersion: options.minimumSystemVersion ?? '12.0',
      }))
    }
    if (plan.executable === '/usr/bin/sw_vers') return result(plan, `${options.systemVersion ?? '15.1'}\n`)
    return result(plan)
  }
  return { runProcess, plans }
}

const temporaryDirectories: string[] = []

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `xingmang-mac-desktop-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function setup(network: FakeNetworkOptions = {}, processes: FakeProcessOptions = {}, extra: Partial<InstallMacosDesktopAppOptions> = {}) {
  const home = temporaryDirectory('home')
  const applications = temporaryDirectory('applications')
  const fakeNet = fakeNetwork(network)
  const fakeRun = fakeProcesses(processes)
  const progress: string[] = []
  const options: InstallMacosDesktopAppOptions = {
    tool: 'opencode',
    architecture: 'arm64',
    userHome: home,
    environment: { HOME: home },
    fetch: fakeNet.fetch,
    runProcess: fakeRun.runProcess,
    systemApplicationsDirectory: applications,
    onProgress: (event) => progress.push(event.message),
    wait: async () => undefined,
    ...extra,
  }
  return { home, applications, options, progress, requested: fakeNet.requested, plans: fakeRun.plans }
}

async function failure(promise: Promise<unknown>): Promise<MacosDesktopInstallFailure> {
  const error = await promise.then(() => null, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(MacosDesktopInstallFailure)
  return error as MacosDesktopInstallFailure
}

function stagingLeftovers(home: string): string[] {
  const parent = path.posix.join(managedProductRoot({ HOME: home }, 'darwin'), 'DesktopApps')
  return fs.existsSync(parent) ? fs.readdirSync(parent) : []
}

describe('macOS desktop app installer', () => {
  it('offers one-click installation only for clients with a verified official Mac package', () => {
    expect(macosDesktopAppInstallable('opencode', 'arm64')).toBe(true)
    expect(macosDesktopAppInstallable('opencode', 'x64')).toBe(true)
    expect(macosDesktopAppInstallable('opencode', 'ia32')).toBe(false)
    expect(macosDesktopAppInstallable('workbuddy', 'arm64')).toBe(false)
    expect(macosDesktopAppInstallable('claudeDesktop', 'arm64')).toBe(false)
  })

  it('compares macOS versions only when both sides are readable', () => {
    expect(isMacosVersionBelow('11.7.10\n', '12.0')).toBe(true)
    expect(isMacosVersionBelow('12.0', '12.0')).toBe(false)
    expect(isMacosVersionBelow('12', '12.0.1')).toBe(true)
    expect(isMacosVersionBelow('15.1', '12.0')).toBe(false)
    expect(isMacosVersionBelow('', '12.0')).toBe(false)
    expect(isMacosVersionBelow('15.1', 'twelve')).toBe(false)
  })

  it('follows GitHub release redirects hop by hop and refuses any hop off the allow-list', async () => {
    const network = fakeNetwork()
    const response = await fetchMacosDesktopResource('opencode', feedUrl, {}, network.fetch)
    expect(response.status).toBe(200)
    expect(network.requested).toEqual([feedUrl, pinnedFeedUrl, assetUrl('latest.json')])

    const elsewhere = (async () => redirect('https://example.com/opencode.tar.gz')) as typeof globalThis.fetch
    await expect(fetchMacosDesktopResource('opencode', packageUrl('arm64'), {}, elsewhere)).rejects.toThrow('example.com')
    const otherRepository = (async () => redirect('https://github.com/someone/else/releases/download/v1/a.tar.gz')) as typeof globalThis.fetch
    await expect(fetchMacosDesktopResource('opencode', packageUrl('arm64'), {}, otherRepository)).rejects.toThrow('github.com')
    const plainHttp = (async () => redirect('http://release-assets.githubusercontent.com/a')) as typeof globalThis.fetch
    await expect(fetchMacosDesktopResource('opencode', packageUrl('arm64'), {}, plainHttp)).rejects.toThrow('不认识的地址')
    // A fetch that quietly followed redirects itself would hide where the bytes came from.
    const followed = (async () => Object.defineProperty(new Response('x'), 'url', { value: 'https://example.com/x' })) as typeof globalThis.fetch
    await expect(fetchMacosDesktopResource('opencode', packageUrl('arm64'), {}, followed)).rejects.toThrow('example.com')
    let hops = 0
    const looping = (async () => redirect(assetUrl(`hop-${hops++}`))) as typeof globalThis.fetch
    await expect(fetchMacosDesktopResource('opencode', packageUrl('arm64'), {}, looping)).rejects.toThrow('重定向次数过多')
    await expect(fetchMacosDesktopResource('workbuddy', packageUrl('arm64'), {}, network.fetch)).rejects.toThrow('没有可核对')
  })

  it.skipIf(process.platform === 'win32')('downloads the official package, verifies its Developer ID and Gatekeeper verdict, then moves it into Applications', async () => {
    const f = setup()
    // Left behind by an interrupted earlier run: cleaned up before this one starts.
    const staleParent = path.posix.join(managedProductRoot({ HOME: f.home }, 'darwin'), 'DesktopApps')
    fs.mkdirSync(path.posix.join(staleParent, 'staging-stale'), { recursive: true })

    const installed = await installMacosDesktopApp(f.options)

    expect(installed).toEqual({ version: '1.18.34', path: path.posix.join(f.applications, 'OpenCode.app') })
    expect(fs.readFileSync(path.join(f.applications, 'OpenCode.app', 'Contents', 'MacOS', 'OpenCode'), 'utf8')).toBe('binary')
    expect(f.requested.slice(-2)).toEqual([packageUrl('arm64'), assetUrl('opencode-desktop-mac-arm64.app.tar.gz')])
    expect(f.plans.map((plan) => plan.executable)).toEqual(['/usr/bin/tar', '/usr/bin/plutil', '/usr/bin/sw_vers', '/usr/bin/codesign', '/usr/sbin/spctl'])
    const [tar, , , codesign, spctl] = f.plans
    expect(tar.argv[0]).toBe('-xzf')
    expect(codesign.argv).toContain('--deep')
    const requirement = codesign.argv.find((argument) => argument.startsWith('-R=')) ?? ''
    expect(requirement).toContain('identifier "ai.opencode.desktop"')
    expect(requirement).toContain('certificate leaf[subject.OU] = "5NZ4Q7NXJ4"')
    // Both checks run on the extracted copy, before anything reaches Applications.
    expect(codesign.argv.at(-1)).toMatch(/\/DesktopApps\/staging-[^/]+\/extract\/OpenCode\.app$/)
    expect(spctl.argv).toEqual(['--assess', '--type', 'execute', codesign.argv.at(-1)])
    expect(stagingLeftovers(f.home)).toEqual([])
    expect(f.progress[0]).toBe('正在下载 OpenCode 1.18.34')
    expect(f.progress.slice(-2)).toEqual(['正在检查下载下来的安装包是不是完整的官方版', '正在放进「应用程序」'])
  })

  it.skipIf(process.platform === 'win32')('picks the Intel package on an Intel Mac', async () => {
    const f = setup({}, {}, { architecture: 'x64' })
    await installMacosDesktopApp(f.options)
    expect(f.requested).toContain(packageUrl('x64'))
    expect(f.requested).not.toContain(packageUrl('arm64'))
  })

  it.skipIf(process.platform === 'win32')('uses ~/Applications when the system Applications folder is not writable', async () => {
    const f = setup({}, {}, { systemApplicationsDirectory: path.join(os.tmpdir(), 'xingmang-no-such-applications') })
    const installed = await installMacosDesktopApp(f.options)
    expect(installed.path).toBe(path.posix.join(f.home, 'Applications', 'OpenCode.app'))
    expect(fs.statSync(path.join(f.home, 'Applications', 'OpenCode.app')).isDirectory()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('never replaces an app of the same name, and says so before downloading anything', async () => {
    const f = setup()
    fs.mkdirSync(path.join(f.applications, 'OpenCode.app'))
    const error = await failure(installMacosDesktopApp(f.options))
    expect(error.message).toBe('「应用程序」里已经有一个 OpenCode，但它不是官方原版。请先把它移到废纸篓，再点「安装」。')
    expect(isMacosDesktopInstallFailure(error.message)).toBe(true)
    expect(f.requested).toEqual([])
    expect(fs.readdirSync(path.join(f.applications, 'OpenCode.app'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('refuses a feed that points the package anywhere but its fixed release address', async () => {
    const f = setup({ feedBody: feed({ platforms: { 'darwin-aarch64': { url: 'https://github.com/anomalyco/opencode/releases/download/v1.18.34/other.tar.gz' } } }) })
    const error = await failure(installMacosDesktopApp(f.options))
    expect(error.message).toBe('OpenCode 没装好，请再点一次「安装」。')
    expect(error.detail).toContain('没有这台 Mac 能用的安装包')
    expect(f.requested.some((url) => url.includes('.tar.gz'))).toBe(false)
    expect(stagingLeftovers(f.home)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('reports a broken download as a network problem and keeps the reason for the log', async () => {
    const f = setup({ failPackage: true })
    const error = await failure(installMacosDesktopApp(f.options))
    expect(error.message).toBe('OpenCode 没下载下来，请检查网络后再点一次「安装」。')
    expect(error.detail).toBe('fetch failed')
    expect(isMacosDesktopInstallFailure(error.message)).toBe(true)
    expect(fs.readdirSync(f.applications)).toEqual([])
    expect(stagingLeftovers(f.home)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('deletes a package whose signature or Gatekeeper verdict is not the official one', async () => {
    for (const rejectExecutable of ['/usr/bin/codesign', '/usr/sbin/spctl', '/usr/bin/tar']) {
      const f = setup({}, { rejectExecutable })
      const error = await failure(installMacosDesktopApp(f.options))
      expect(error.message).toBe(macosDesktopNotOfficialMessage)
      expect(fs.readdirSync(f.applications)).toEqual([])
      expect(stagingLeftovers(f.home)).toEqual([])
    }
  })

  it.skipIf(process.platform === 'win32')('refuses an archive that is not exactly one bundle with the official identifier', async () => {
    const extra = setup({}, { extraTopLevelEntry: true })
    expect((await failure(installMacosDesktopApp(extra.options))).message).toBe(macosDesktopNotOfficialMessage)
    const renamed = setup({}, { bundleIdentifier: 'com.example.opencode' })
    expect((await failure(installMacosDesktopApp(renamed.options))).message).toBe(macosDesktopNotOfficialMessage)
    expect(renamed.plans.some((plan) => plan.executable === '/usr/bin/codesign')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('says plainly when this Mac is too old for the app', async () => {
    const f = setup({}, { systemVersion: '12.7.6', minimumSystemVersion: '13.0' })
    const error = await failure(installMacosDesktopApp(f.options))
    expect(error.message).toBe('OpenCode 需要 macOS 13.0 或更新的系统，这台 Mac 装不了。')
    expect(isMacosDesktopSystemTooOld(error.message)).toBe(true)
    expect(isMacosDesktopInstallFailure(error.message)).toBe(false)
    expect(fs.readdirSync(f.applications)).toEqual([])
  })
})
