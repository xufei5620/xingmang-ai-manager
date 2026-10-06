import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, type CommandResult } from './command-runner'
import {
  fetchMacosDesktopResource,
  installMacosDesktopApp,
  isMacosVersionBelow,
  macosDesktopAppInstallable,
  MacosDesktopInstallError,
  type InstallMacosDesktopAppOptions,
  type MacosDesktopAppProcess,
} from './macos-desktop-app-installer'
import {
  isMacosDesktopInstallFailure,
  isMacosDesktopSystemTooOld,
  macosDesktopDiskFullMessage,
  macosDesktopInstallErrorName,
  macosDesktopNameTakenMessage,
  macosDesktopNotOfficialMessage,
  macosLegacyChatgptMessage,
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
  /** The single bundle the archive unpacks to; OpenCode.app unless a test says otherwise. */
  bundleName?: string
  bundleIdentifier?: string
  /** What plutil reads from the Info.plist of an app already holding the name; unreadable when unset. */
  existingBundleIdentifier?: string
  minimumSystemVersion?: string
  systemVersion?: string
  rejectExecutable?: string
  /** What the rejected command printed on stderr. */
  rejectStderr?: string
  /** ditto copies part of the bundle, then exits with this on stderr. */
  dittoBreaksWith?: string
  /** Someone puts an app of the same name in place while ditto is copying. */
  nameAppearsDuringCopy?: boolean
}

function result(plan: MacosDesktopAppProcess, stdout = ''): CommandResult {
  return { executable: plan.executable, argv: [...plan.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 }
}

function rejection(plan: MacosDesktopAppProcess, stderr = ''): CommandRunnerError {
  return new CommandRunnerError(`${plan.executable} rejected`, {
    code: 'EXIT_NON_ZERO', executable: plan.executable, argv: [...plan.argv], exitCode: 1, signal: null,
    stdout: '', stderr, outputBytes: 0, maxOutputBytes: 1, durationMs: 1,
  })
}

function fakeProcesses(options: FakeProcessOptions = {}) {
  const plans: MacosDesktopAppProcess[] = []
  async function runProcess(plan: MacosDesktopAppProcess): Promise<CommandResult> {
    plans.push(plan)
    if (plan.executable === options.rejectExecutable) throw rejection(plan, options.rejectStderr)
    if (plan.executable === '/usr/bin/tar') {
      const destination = plan.argv[3]
      const bundleName = options.bundleName ?? 'OpenCode.app'
      fs.mkdirSync(path.join(destination, bundleName, 'Contents', 'MacOS'), { recursive: true })
      fs.writeFileSync(path.join(destination, bundleName, 'Contents', 'MacOS', path.basename(bundleName, '.app')), 'binary', { mode: 0o755 })
      if (options.extraTopLevelEntry) fs.writeFileSync(path.join(destination, 'README'), '')
      return result(plan)
    }
    if (plan.executable === '/usr/bin/plutil' && plan.argv[0] === '-extract') {
      if (options.existingBundleIdentifier === undefined) throw rejection(plan, 'Could not extract value')
      return result(plan, `${options.existingBundleIdentifier}\n`)
    }
    if (plan.executable === '/usr/bin/plutil') {
      return result(plan, JSON.stringify({
        CFBundleIdentifier: options.bundleIdentifier ?? 'ai.opencode.desktop',
        CFBundleShortVersionString: '1.18.34',
        LSMinimumSystemVersion: options.minimumSystemVersion ?? '12.0',
      }))
    }
    if (plan.executable === '/usr/bin/sw_vers') return result(plan, `${options.systemVersion ?? '15.1'}\n`)
    if (plan.executable === '/usr/bin/ditto') {
      const [from, to] = plan.argv
      if (options.dittoBreaksWith) {
        fs.mkdirSync(path.join(to, 'Contents'), { recursive: true })
        throw rejection(plan, options.dittoBreaksWith)
      }
      fs.cpSync(from, to, { recursive: true })
      if (options.nameAppearsDuringCopy) {
        fs.mkdirSync(path.join(path.dirname(to), 'OpenCode.app'))
        fs.writeFileSync(path.join(path.dirname(to), 'OpenCode.app', 'mine'), 'customer')
      }
    }
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
  vi.restoreAllMocks()
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

async function failure(promise: Promise<unknown>): Promise<MacosDesktopInstallError> {
  const error = await promise.then(() => null, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(MacosDesktopInstallError)
  // The renderer strips this name from the IPC rejection (operation-error.test.ts checks it).
  expect((error as MacosDesktopInstallError).name).toBe(macosDesktopInstallErrorName)
  return error as MacosDesktopInstallError
}

/** The staged copy sits on the home volume and Applications on another one. */
function onAnotherVolume(): void {
  const rename = fs.promises.rename
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from).includes('/DesktopApps/')) {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    }
    return rename(from, to)
  })
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
    expect(macosDesktopAppInstallable('claudeDesktop', 'arm64')).toBe(true)
    expect(macosDesktopAppInstallable('claudeDesktop', 'x64')).toBe(true)
    expect(macosDesktopAppInstallable('codexDesktop', 'arm64')).toBe(true)
    expect(macosDesktopAppInstallable('codexDesktop', 'x64')).toBe(true)
    expect(macosDesktopAppInstallable('codexDesktop', 'ia32')).toBe(false)
    // No Mac package of WorkBuddy could be checked, so it keeps the guide.
    expect(macosDesktopAppInstallable('workbuddy', 'arm64')).toBe(false)
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
    expect(f.plans).toEqual([])
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
    for (const rejectExecutable of ['/usr/bin/codesign', '/usr/sbin/spctl']) {
      const f = setup({}, { rejectExecutable })
      const error = await failure(installMacosDesktopApp(f.options))
      expect(error.message).toBe(macosDesktopNotOfficialMessage)
      expect(fs.readdirSync(f.applications)).toEqual([])
      expect(stagingLeftovers(f.home)).toEqual([])
    }
  })

  it.skipIf(process.platform === 'win32')('reports an archive that will not unpack as a failed install, not as a fake package', async () => {
    const f = setup({}, { rejectExecutable: '/usr/bin/tar', rejectStderr: 'tar: Error opening archive: Unrecognized archive format' })
    const error = await failure(installMacosDesktopApp(f.options))
    expect(error.message).toBe('OpenCode 没装好，请再点一次「安装」。')
    expect(error.detail).toContain('/usr/bin/tar')
    expect(f.plans.some((plan) => plan.executable === '/usr/bin/codesign')).toBe(false)
    expect(fs.readdirSync(f.applications)).toEqual([])
    expect(stagingLeftovers(f.home)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('says the disk is full instead of blaming the network or the package', async () => {
    const unpacking = setup({}, { rejectExecutable: '/usr/bin/tar', rejectStderr: 'tar: OpenCode.app/Contents/Frameworks/a: Write failed: No space left on device' })
    const unpacked = await failure(installMacosDesktopApp(unpacking.options))
    expect(unpacked.message).toBe('OpenCode 安装失败：安装目录所在磁盘空间不足，请先清理磁盘再试')
    expect(isMacosDesktopInstallFailure(unpacked.message)).toBe(false)
    expect(stagingLeftovers(unpacking.home)).toEqual([])

    // Running out of room halfway through the download used to read as a network problem.
    const downloading = setup()
    const open = fs.promises.open
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode)
      if (String(file).endsWith('package.tar.gz')) {
        vi.spyOn(handle, 'write').mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))
      }
      return handle
    })
    const downloaded = await failure(installMacosDesktopApp(downloading.options))
    expect(downloaded.message).toBe(macosDesktopDiskFullMessage('OpenCode'))
    expect(downloaded.detail).toContain('ENOSPC')
    expect(fs.readdirSync(downloading.applications)).toEqual([])
    expect(stagingLeftovers(downloading.home)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('copies across volumes under a hidden name and only then renames it into place', async () => {
    const f = setup()
    onAnotherVolume()
    const installed = await installMacosDesktopApp(f.options)
    expect(installed.path).toBe(path.posix.join(f.applications, 'OpenCode.app'))
    expect(fs.readFileSync(path.join(f.applications, 'OpenCode.app', 'Contents', 'MacOS', 'OpenCode'), 'utf8')).toBe('binary')
    const ditto = f.plans.find((plan) => plan.executable === '/usr/bin/ditto')
    expect(ditto?.argv[0]).toMatch(/\/extract\/OpenCode\.app$/)
    expect(path.posix.dirname(ditto?.argv[1] ?? '')).toBe(f.applications)
    expect(path.posix.basename(ditto?.argv[1] ?? '')).toMatch(/^\.OpenCode\.app\.xingmang-[0-9a-f]{12}$/)
    expect(fs.readdirSync(f.applications)).toEqual(['OpenCode.app'])
    expect(stagingLeftovers(f.home)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('removes a half-made copy when copying across volumes fails', async () => {
    const f = setup({}, { dittoBreaksWith: 'ditto: OpenCode.app/Contents/Frameworks/a: No space left on device' })
    onAnotherVolume()
    const error = await failure(installMacosDesktopApp(f.options))
    expect(error.message).toBe(macosDesktopDiskFullMessage('OpenCode'))
    expect(fs.readdirSync(f.applications)).toEqual([])
    expect(stagingLeftovers(f.home)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('never replaces an app of the same name that appeared while the copy was being made', async () => {
    const f = setup({}, { nameAppearsDuringCopy: true })
    onAnotherVolume()
    const error = await failure(installMacosDesktopApp(f.options))
    expect(error.message).toBe(macosDesktopNameTakenMessage('OpenCode'))
    expect(fs.readdirSync(f.applications)).toEqual(['OpenCode.app'])
    expect(fs.readFileSync(path.join(f.applications, 'OpenCode.app', 'mine'), 'utf8')).toBe('customer')
  })

  it.skipIf(process.platform === 'win32')('clears the hidden copy an interrupted install left in Applications, and nothing else', async () => {
    const f = setup()
    fs.mkdirSync(path.join(f.applications, '.OpenCode.app.xingmang-0123456789ab', 'Contents'), { recursive: true })
    fs.mkdirSync(path.join(f.applications, '.OpenCode.app.xingmang-mine'))
    fs.mkdirSync(path.join(f.applications, 'Other.app'))
    await installMacosDesktopApp(f.options)
    expect(fs.readdirSync(f.applications).sort()).toEqual(['.OpenCode.app.xingmang-mine', 'OpenCode.app', 'Other.app'])
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

const claudeVersion = '2.19675.0'
const claudePackageUrl = `https://downloads.claude.ai/releases/darwin/universal/${claudeVersion}/Claude-5706e5524dba58b23e105c31c358df8ab0a95852.zip`
const chatgptRoot = 'https://persistent.oaistatic.com/codex-app-prod/'
const chatgptVersion = '26.930.31730'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function chatgptPackageUrl(architecture: string, version = chatgptVersion): string {
  return `${chatgptRoot}ChatGPT-darwin-${architecture}-${version}.zip`
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Shaped like api.anthropic.com's answer on 2026-10-03; `update` overrides fields of its one release. */
function claudeFeed(update: Record<string, unknown> = {}, currentRelease = claudeVersion): string {
  return JSON.stringify({
    currentRelease,
    releases: [{
      version: claudeVersion,
      updateTo: {
        name: `Claude ${claudeVersion}`,
        version: claudeVersion,
        pub_date: '2026-10-01T17:21:33.978830',
        url: claudePackageUrl,
        notes: 'Production Release - No Notes',
        sha256: sha256Hex(archiveBytes),
        size: archiveBytes.byteLength,
        ...update,
      },
    }],
  })
}

interface AppcastEntry {
  build: number
  version: string
  minimum?: string
  architecture?: string
  url?: string
  length?: number
}

/** One <item> the way OpenAI's appcast writes it, delta packages included. */
function appcastItem(entry: AppcastEntry): string {
  const architecture = entry.architecture ?? 'arm64'
  return `
    <item>
      <title>${entry.version}</title>
      <sparkle:version>${entry.build}</sparkle:version>
      <sparkle:shortVersionString>${entry.version}</sparkle:shortVersionString>
      ${entry.minimum ? `<sparkle:minimumSystemVersion>${entry.minimum}</sparkle:minimumSystemVersion>` : ''}
      <sparkle:hardwareRequirements>${architecture}</sparkle:hardwareRequirements>
      <enclosure url="${entry.url ?? chatgptPackageUrl(architecture, entry.version)}" length="${entry.length ?? archiveBytes.byteLength}" type="application/octet-stream" sparkle:edSignature="c2lnbmF0dXJl" />
      <sparkle:deltas>
        <enclosure url="${chatgptRoot}ChatGPT${entry.build}-12000-${architecture}.delta" sparkle:deltaFrom="12000" length="4936750" type="application/octet-stream" sparkle:edSignature="ZGVsdGE=" />
      </sparkle:deltas>
    </item>`
}

function appcast(...items: string[]): string {
  return `<?xml version='1.0' encoding='utf-8'?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <title>Codex</title>${items.join('')}
  </channel>
</rss>`
}

interface VendorNetworkOptions {
  claudeFeedBody?: string
  appcastBody?: string
  packageBody?: Buffer
  /** Runs when the package itself is requested, before any byte of it arrives. */
  onPackageRequest?: () => void
}

function fakeVendorNetwork(options: VendorNetworkOptions = {}) {
  const requested: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requested.push(url)
    expect(init?.redirect).toBe('manual')
    if (url.startsWith('https://api.anthropic.com/')) return new Response(options.claudeFeedBody ?? claudeFeed())
    if (url === `${chatgptRoot}appcast.xml` || url === `${chatgptRoot}appcast-x64.xml`) {
      const architecture = url.endsWith('-x64.xml') ? 'x64' : 'arm64'
      return new Response(options.appcastBody ?? appcast(appcastItem({ build: 12947, version: chatgptVersion, minimum: '13.0', architecture })))
    }
    if (url === claudePackageUrl || url.startsWith(`${chatgptRoot}ChatGPT-darwin-`)) {
      options.onPackageRequest?.()
      init?.signal?.throwIfAborted()
      const body = options.packageBody ?? archiveBytes
      return new Response(body, { headers: { 'content-length': String(body.byteLength) } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, requested }
}

const vendorBundles = {
  claudeDesktop: { bundleName: 'Claude.app', bundleIdentifier: 'com.anthropic.claudefordesktop', minimumSystemVersion: '13.0' },
  codexDesktop: { bundleName: 'ChatGPT.app', bundleIdentifier: 'com.openai.codex', minimumSystemVersion: '13.0' },
}

function vendorSetup(
  tool: 'claudeDesktop' | 'codexDesktop',
  network: VendorNetworkOptions = {},
  extra: Partial<InstallMacosDesktopAppOptions> = {},
  processes: FakeProcessOptions = {},
) {
  const home = temporaryDirectory('home')
  const applications = temporaryDirectory('applications')
  const fakeNet = fakeVendorNetwork(network)
  const fakeRun = fakeProcesses({ ...vendorBundles[tool], ...processes })
  const progress: string[] = []
  const options: InstallMacosDesktopAppOptions = {
    tool,
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

function signingRequirement(plans: MacosDesktopAppProcess[]): string {
  const codesign = plans.find((plan) => plan.executable === '/usr/bin/codesign')
  return codesign?.argv.find((argument) => argument.startsWith('-R=')) ?? ''
}

describe('macOS installer for Claude Desktop and the Codex desktop app', () => {
  it('holds each vendor to its own hosts, redirects included', async () => {
    const elsewhere = (async () => redirect('https://example.com/package.zip')) as typeof globalThis.fetch
    await expect(fetchMacosDesktopResource('claudeDesktop', claudePackageUrl, {}, elsewhere)).rejects.toThrow('example.com')
    await expect(fetchMacosDesktopResource('codexDesktop', chatgptPackageUrl('arm64'), {}, elsewhere)).rejects.toThrow('example.com')
    const answers = (async () => new Response('x')) as typeof globalThis.fetch
    expect((await fetchMacosDesktopResource('claudeDesktop', 'https://api.anthropic.com/api/desktop/darwin/x64/squirrel/update?device_id=1&os_version=15.1', {}, answers)).status).toBe(200)
    expect((await fetchMacosDesktopResource('codexDesktop', `${chatgptRoot}appcast-x64.xml`, {}, answers)).status).toBe(200)
    // The update API is one fixed path; the package hosts never carry a query.
    await expect(fetchMacosDesktopResource('claudeDesktop', 'https://api.anthropic.com/v1/messages?device_id=1', {}, answers)).rejects.toThrow('api.anthropic.com')
    await expect(fetchMacosDesktopResource('claudeDesktop', `${claudePackageUrl}?x=1`, {}, answers)).rejects.toThrow('downloads.claude.ai')
    await expect(fetchMacosDesktopResource('claudeDesktop', 'https://downloads.claude.ai/releases/win32/x64/Claude.exe', {}, answers)).rejects.toThrow('downloads.claude.ai')
    await expect(fetchMacosDesktopResource('codexDesktop', `${chatgptPackageUrl('arm64')}?sig=1`, {}, answers)).rejects.toThrow('persistent.oaistatic.com')
    await expect(fetchMacosDesktopResource('codexDesktop', 'https://persistent.oaistatic.com/other/ChatGPT.zip', {}, answers)).rejects.toThrow('persistent.oaistatic.com')
    // Neither vendor's host counts for the other one.
    await expect(fetchMacosDesktopResource('codexDesktop', claudePackageUrl, {}, answers)).rejects.toThrow('downloads.claude.ai')
    await expect(fetchMacosDesktopResource('claudeDesktop', chatgptPackageUrl('arm64'), {}, answers)).rejects.toThrow('persistent.oaistatic.com')
  })

  it.skipIf(process.platform === 'win32')('installs Claude Desktop from its update feed once the size and SHA-256 the feed declares both match', async () => {
    const f = vendorSetup('claudeDesktop')

    const installed = await installMacosDesktopApp(f.options)

    expect(installed).toEqual({ version: claudeVersion, path: path.posix.join(f.applications, 'Claude.app') })
    expect(fs.readFileSync(path.join(f.applications, 'Claude.app', 'Contents', 'MacOS', 'Claude'), 'utf8')).toBe('binary')
    const feedRequest = new URL(f.requested[0])
    expect(`${feedRequest.origin}${feedRequest.pathname}`).toBe('https://api.anthropic.com/api/desktop/darwin/arm64/squirrel/update')
    expect(feedRequest.searchParams.get('os_version')).toBe('15.1')
    expect(feedRequest.searchParams.get('device_id')).toMatch(uuidPattern)
    expect(f.requested.slice(1)).toEqual([claudePackageUrl])
    // sw_vers is read once, for the feed, and the same answer serves the Info.plist check.
    expect(f.plans.map((plan) => plan.executable)).toEqual(['/usr/bin/sw_vers', '/usr/bin/tar', '/usr/bin/plutil', '/usr/bin/codesign', '/usr/sbin/spctl'])
    expect(f.plans[1].argv[0]).toBe('-xf')
    expect(f.plans[1].argv[1]).toMatch(/\/package\.zip$/)
    expect(signingRequirement(f.plans)).toContain('identifier "com.anthropic.claudefordesktop"')
    expect(signingRequirement(f.plans)).toContain('certificate leaf[subject.OU] = "Q6L2SF6YDW"')
    expect(stagingLeftovers(f.home)).toEqual([])
    expect(f.progress[0]).toBe(`正在下载 Claude Desktop ${claudeVersion}`)
  })

  it.skipIf(process.platform === 'win32')('asks the Claude feed with a fresh device id every time and the Intel path on an Intel Mac', async () => {
    const first = vendorSetup('claudeDesktop')
    const second = vendorSetup('claudeDesktop', {}, { architecture: 'x64' })
    await installMacosDesktopApp(first.options)
    await installMacosDesktopApp(second.options)

    const firstId = new URL(first.requested[0]).searchParams.get('device_id')
    const secondFeed = new URL(second.requested[0])
    expect(secondFeed.pathname).toBe('/api/desktop/darwin/x64/squirrel/update')
    expect(secondFeed.searchParams.get('device_id')).toMatch(uuidPattern)
    expect(secondFeed.searchParams.get('device_id')).not.toBe(firstId)
    // Both chips get the same universal package.
    expect(second.requested.slice(1)).toEqual([claudePackageUrl])
  })

  it.skipIf(process.platform === 'win32')('never asks a feed with a system version it could not read', async () => {
    const f = vendorSetup('claudeDesktop', {}, {}, { systemVersion: 'ProductVersion: 15.1' })
    const error = await failure(installMacosDesktopApp(f.options))
    expect(error.message).toBe('Claude Desktop 没装好，请再点一次「安装」。')
    expect(error.detail).toContain('读不出这台 Mac 的系统版本')
    expect(f.requested).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('deletes a Claude package that does not match the size or SHA-256 its feed declared', async () => {
    const swapped = vendorSetup('claudeDesktop', { packageBody: Buffer.alloc(archiveBytes.byteLength, 7) })
    const notOfficial = await failure(installMacosDesktopApp(swapped.options))
    expect(notOfficial.message).toBe(macosDesktopNotOfficialMessage)
    expect(notOfficial.detail).toContain('SHA-256')
    expect(swapped.plans.some((plan) => plan.executable === '/usr/bin/tar')).toBe(false)
    expect(fs.readdirSync(swapped.applications)).toEqual([])
    expect(stagingLeftovers(swapped.home)).toEqual([])

    // A short file reads as an unfinished download, and a longer one is cut off while it downloads.
    for (const packageBody of [archiveBytes.subarray(0, 1024), Buffer.concat([archiveBytes, Buffer.from('x')])]) {
      const f = vendorSetup('claudeDesktop', { packageBody })
      const error = await failure(installMacosDesktopApp(f.options))
      expect(error.message).toBe('Claude Desktop 没下载下来，请检查网络后再点一次「安装」。')
      expect(f.plans.some((plan) => plan.executable === '/usr/bin/tar')).toBe(false)
      expect(fs.readdirSync(f.applications)).toEqual([])
      expect(stagingLeftovers(f.home)).toEqual([])
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a Claude feed that offers anything but the universal zip of its current version', async () => {
    const bodies = [
      claudeFeed({ url: claudePackageUrl.replace(/\.zip$/, '.dmg') }),
      claudeFeed({ url: claudePackageUrl.replace('downloads.claude.ai', 'downloads.example.com') }),
      claudeFeed({ url: claudePackageUrl.replace(`/universal/${claudeVersion}/`, '/universal/2.19000.0/') }),
      claudeFeed({ url: claudePackageUrl.replace('/universal/', '/arm64/') }),
      claudeFeed({ version: '2.19000.0' }),
      claudeFeed({ sha256: undefined }),
      claudeFeed({ sha256: 'A'.repeat(64) }),
      claudeFeed({ size: undefined }),
      claudeFeed({ size: 0 }),
      claudeFeed({}, '2.19000.0'),
      JSON.stringify({ ...JSON.parse(claudeFeed()), releases: [...JSON.parse(claudeFeed()).releases, ...JSON.parse(claudeFeed()).releases] }),
    ]
    for (const claudeFeedBody of bodies) {
      const f = vendorSetup('claudeDesktop', { claudeFeedBody })
      const error = await failure(installMacosDesktopApp(f.options))
      expect(error.message).toBe('Claude Desktop 没装好，请再点一次「安装」。')
      expect(error.detail).toContain('没有这台 Mac 能用的安装包')
      expect(f.requested).toHaveLength(1)
    }
  })

  it.skipIf(process.platform === 'win32')('installs the Codex desktop app, which Applications calls ChatGPT, from the Apple silicon appcast', async () => {
    const f = vendorSetup('codexDesktop')

    const installed = await installMacosDesktopApp(f.options)

    expect(installed).toEqual({ version: chatgptVersion, path: path.posix.join(f.applications, 'ChatGPT.app') })
    expect(f.requested).toEqual([`${chatgptRoot}appcast.xml`, chatgptPackageUrl('arm64')])
    expect(f.plans.map((plan) => plan.executable)).toEqual(['/usr/bin/sw_vers', '/usr/bin/tar', '/usr/bin/plutil', '/usr/bin/codesign', '/usr/sbin/spctl'])
    expect(f.plans[1].argv[0]).toBe('-xf')
    expect(signingRequirement(f.plans)).toContain('identifier "com.openai.codex"')
    expect(signingRequirement(f.plans)).toContain('certificate leaf[subject.OU] = "2DC432GLL2"')
    expect(f.progress[0]).toBe(`正在下载 Codex 桌面端 ${chatgptVersion}`)
    expect(stagingLeftovers(f.home)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('reads the Intel appcast and package on an Intel Mac', async () => {
    const f = vendorSetup('codexDesktop', {}, { architecture: 'x64' })
    await installMacosDesktopApp(f.options)
    expect(f.requested).toEqual([`${chatgptRoot}appcast-x64.xml`, chatgptPackageUrl('x64')])
  })

  it.skipIf(process.platform === 'win32')('picks the newest build this macOS can run, and says what to upgrade to before downloading when none fits', async () => {
    const body = appcast(
      appcastItem({ build: 12800, version: '26.900.1', minimum: '13.0' }),
      appcastItem({ build: 12947, version: chatgptVersion, minimum: '14.0' }),
      appcastItem({ build: 12913, version: '26.930.31428', minimum: '13.0' }),
    )
    const older = vendorSetup('codexDesktop', { appcastBody: body }, {}, { systemVersion: '13.6.1' })
    expect((await installMacosDesktopApp(older.options)).version).toBe('26.930.31428')
    expect(older.requested.at(-1)).toBe(chatgptPackageUrl('arm64', '26.930.31428'))

    const newest = vendorSetup('codexDesktop', { appcastBody: body }, {}, { systemVersion: '15.1' })
    expect((await installMacosDesktopApp(newest.options)).version).toBe(chatgptVersion)

    const tooOld = vendorSetup('codexDesktop', { appcastBody: body }, {}, { systemVersion: '12.7.6' })
    const error = await failure(installMacosDesktopApp(tooOld.options))
    expect(error.message).toBe('Codex 桌面端需要 macOS 14.0 或更新的系统，这台 Mac 装不了。')
    expect(isMacosDesktopSystemTooOld(error.message)).toBe(true)
    expect(tooOld.requested).toEqual([`${chatgptRoot}appcast.xml`])
  })

  it.skipIf(process.platform === 'win32')('refuses an appcast whose package is not the fixed ChatGPT zip, or that cannot be read one way only', async () => {
    const item = appcastItem({ build: 12947, version: chatgptVersion, minimum: '13.0' })
    const bodies = [
      appcast(appcastItem({ build: 12947, version: chatgptVersion, url: chatgptPackageUrl('arm64').replace(/\.zip$/, '.dmg') })),
      appcast(appcastItem({ build: 12947, version: chatgptVersion, url: chatgptPackageUrl('arm64').replace('persistent.oaistatic.com', 'example.com') })),
      // The Intel package listed in the Apple silicon appcast.
      appcast(appcastItem({ build: 12947, version: chatgptVersion, architecture: 'x64' })),
      appcast(appcastItem({ build: 12947, version: chatgptVersion, length: 0 })),
      // A delta package is never taken for the full one.
      appcast(item.replace(/<enclosure url="([^"]+\.zip)"/, '<enclosure url="$1" sparkle:deltaFrom="12000"')),
      appcast(item.replace('</sparkle:version>', '</sparkle:version>\n<sparkle:version>99999</sparkle:version>')),
      `<!DOCTYPE rss [<!ENTITY version "${chatgptVersion}">]>${appcast(item)}`,
      appcast(),
    ]
    for (const appcastBody of bodies) {
      const f = vendorSetup('codexDesktop', { appcastBody })
      const error = await failure(installMacosDesktopApp(f.options))
      expect(error.message).toBe('Codex 桌面端没装好，请再点一次「安装」。')
      expect(error.detail).toContain('没有这台 Mac 能用的安装包')
      expect(f.requested).toEqual([`${chatgptRoot}appcast.xml`])
    }
  })

  it.skipIf(process.platform === 'win32')('tells the old ChatGPT chat app apart from an unknown app of the same name, and replaces neither', async () => {
    const legacy = vendorSetup('codexDesktop', {}, {}, { existingBundleIdentifier: 'com.openai.chat' })
    fs.mkdirSync(path.join(legacy.applications, 'ChatGPT.app', 'Contents'), { recursive: true })
    const error = await failure(installMacosDesktopApp(legacy.options))
    expect(error.message).toBe(macosLegacyChatgptMessage)
    expect(isMacosDesktopInstallFailure(error.message)).toBe(true)
    expect(legacy.plans.map((plan) => plan.argv)).toEqual([
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.posix.join(legacy.applications, 'ChatGPT.app', 'Contents', 'Info.plist')],
    ])
    expect(legacy.requested).toEqual([])
    expect(fs.readdirSync(path.join(legacy.applications, 'ChatGPT.app'))).toEqual(['Contents'])

    // An identifier it does not know, or none it can read, gets the general wording.
    for (const processes of [{ existingBundleIdentifier: 'com.example.chatgpt' }, {}]) {
      const other = vendorSetup('codexDesktop', {}, {}, processes)
      fs.mkdirSync(path.join(other.applications, 'ChatGPT.app'))
      expect((await failure(installMacosDesktopApp(other.options))).message).toBe(macosDesktopNameTakenMessage('ChatGPT'))
      expect(other.requested).toEqual([])
      expect(fs.readdirSync(other.applications)).toEqual(['ChatGPT.app'])
    }
  })

  it.skipIf(process.platform === 'win32')('stops when the customer cancels and hands back the cancellation itself, leaving nothing behind', async () => {
    const whileDownloading = new AbortController()
    const downloading = vendorSetup('codexDesktop', { onPackageRequest: () => whileDownloading.abort() }, { signal: whileDownloading.signal })
    const checking = new AbortController()
    const beforeUnpacking = vendorSetup('codexDesktop', {}, {
      signal: checking.signal,
      onProgress: (event) => { if (event.phase === 'checking') checking.abort() },
    })
    for (const f of [downloading, beforeUnpacking]) {
      const error = await installMacosDesktopApp(f.options).then(() => null, (reason: unknown) => reason)
      expect(error).not.toBeInstanceOf(MacosDesktopInstallError)
      expect((error as Error).name).toBe('AbortError')
      expect(f.plans.some((plan) => plan.executable === '/usr/bin/tar')).toBe(false)
      expect(fs.readdirSync(f.applications)).toEqual([])
      expect(stagingLeftovers(f.home)).toEqual([])
    }
  })
})
