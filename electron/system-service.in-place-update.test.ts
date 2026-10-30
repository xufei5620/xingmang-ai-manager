import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyOperationError } from '../src/renderer-v2/operation-error'
import { AppSettingsStore } from './app-settings'
import { cliVerifiedVersions } from './cli-verified-versions'
import { CommandRunnerError } from './command-runner'
import { createSystemService, isMachineBoundNpmFailure, type SystemServiceOptions } from './system-service'
import type { resolveCliInstallation } from './tool-installation'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

const integrity = `sha512-${Buffer.alloc(64, 0x33).toString('base64')}`
const officialRegistry = 'https://registry.npmjs.org'
const mirrorRegistry = 'https://registry.npmmirror.com'
const previousVersion = '0.1.0'
const writeSealReason = '正在把新版本写入工具目录，这一步中断会让工具用不了，请等它结束。'

const packages = {
  codex: { name: '@openai/codex', platformBuild: '@openai/codex-win32-x64', command: 'codex' },
  gemini: { name: '@google/gemini-cli', platformBuild: null, command: 'gemini' },
} as const

interface CommandSpecLike {
  executable: string
  argv: readonly string[]
}

interface CommandOptionsLike {
  cwd?: string
  signal?: AbortSignal
}

interface InPlaceUpdateOptions {
  provider: keyof typeof packages
  /** 第 n 次（从 1 数）npm ci 解出来的包里有没有平台主程序包；缺省都有。 */
  downloadHasPlatformBuild?: (attempt: number) => boolean
  /** 第 n 次 npm ci 一直不结束，直到安装被取消。 */
  downloadHangs?: (attempt: number) => boolean
  /** 第 n 次 npm ci 失败时抛的错；缺省都成功。 */
  downloadFails?: (attempt: number) => Error | undefined
  /** 第 n 次 npm install --global 动工具目录之前先做的事：等测试放行，或者直接失败。 */
  beforeFolderWrite?: (attempt: number, signal: AbortSignal | undefined) => Promise<void>
  /** 到这个源核对安装清单（npm install --package-lock-only）时抛的错；缺省都成功。 */
  resolutionFails?: (registry: string) => Error | undefined
  /** 这次下载走在加速线路上。 */
  accelerated?: boolean
  /** 手机遥控放开它那份 Codex 时做的事（#1407 P3-3）：缺省放开得了。 */
  releaseCodexRemote?: SystemServiceOptions['releaseCodexRemote']
}

// 有推荐版本就装推荐版本，名单空了才落回 latest（这里的假元数据把 latest 答成 9.9.9）。
function expectedVersion(provider: keyof typeof packages): string {
  return cliVerifiedVersions[provider].recommended?.version ?? '9.9.9'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** npm 退出码 1 时命令运行器抛的样子，stderr 照 npm 10 的原样。 */
function npmFailure(stderr: string): CommandRunnerError {
  return new CommandRunnerError('命令执行失败（退出码 1）：node', {
    code: 'EXIT_NON_ZERO',
    executable: 'npm',
    argv: [],
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr,
    outputBytes: stderr.length,
    maxOutputBytes: 8 * 1024 * 1024,
    durationMs: 1,
  })
}

const folderBusyStderr = [
  'npm error code EBUSY',
  'npm error syscall rename',
  'npm error path C:\\nodejs\\node_modules\\@openai\\codex',
  'npm error errno -4082',
  "npm error EBUSY: resource busy or locked, rename 'C:\\nodejs\\node_modules\\@openai\\codex'",
  '',
].join('\n')

const folderDeniedStderr = [
  'npm error code EPERM',
  'npm error syscall rename',
  'npm error errno -4048',
  "npm error Error: EPERM: operation not permitted, rename 'C:\\nodejs\\node_modules\\@openai\\codex'",
  '',
].join('\n')

const diskFullStderr = [
  'npm error code ENOSPC',
  'npm error syscall write',
  'npm error errno -28',
  'npm error nospc ENOSPC: no space left on device, write',
  'npm error nospc There appears to be insufficient space on your system to finish.',
  '',
].join('\n')

function writePackage(packageRoot: string, name: string, version: string, platformBuild: string | null): void {
  fs.rmSync(packageRoot, { recursive: true, force: true })
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name,
    version,
    ...(platformBuild
      ? { optionalDependencies: { [platformBuild]: `npm:${name}@${version}-win32-x64` } }
      : {}),
  }))
}

function writePlatformBuild(nodeModules: string, platformBuild: string): void {
  const directory = path.join(nodeModules, ...platformBuild.split('/'))
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'package.json'), '{}')
}

/**
 * Windows 上没用管理员身份开的星芒更新工具：没有暂存目录，npm install --global 直接写进
 * Node.js 旁边那个正在用的全局目录（这里的 nodejs/node_modules），里面先放着一份旧版。
 * 假 npm 只认这次安装会跑的几条命令，其余一律报错。
 */
function createInPlaceUpdateFixture(options: InPlaceUpdateOptions) {
  const definition = packages[options.provider]
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-in-place-update-'))
  temporaryDirectories.push(temporaryRoot)
  const root = fs.realpathSync(temporaryRoot)
  const homeDirectory = path.join(root, 'home')
  const nodeDirectory = path.join(root, 'nodejs')
  const globalRoot = path.join(nodeDirectory, 'node_modules')
  const livePackage = path.join(globalRoot, ...definition.name.split('/'))
  fs.mkdirSync(homeDirectory, { recursive: true })
  vi.stubEnv('HOME', homeDirectory)
  vi.stubEnv('XDG_DATA_HOME', undefined)
  // `npm test` exports these to its children; the desktop app never inherits them.
  vi.stubEnv('npm_config_prefix', undefined)
  vi.stubEnv('npm_config_userconfig', undefined)
  writePackage(livePackage, definition.name, previousVersion, definition.platformBuild)
  if (definition.platformBuild) writePlatformBuild(path.join(livePackage, 'node_modules'), definition.platformBuild)
  const npmExecutable = path.join(nodeDirectory, 'npm')
  // 只有找全局目录的 `npm root --global` 会真的起这个脚本，它不走注入的 runCommand。
  fs.writeFileSync(npmExecutable, `#!/bin/sh\nif [ "$1" = root ]; then printf '%s\\n' '${globalRoot}'; fi\nexit 0\n`)
  fs.chmodSync(npmExecutable, 0o700)

  const metadataUrl = new RegExp(`/${encodeURIComponent(definition.name)}/([^/]+)$`)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('cdn-cgi/trace')) return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
    const match = metadataUrl.exec(url)
    if (match) {
      const version = match[1] === 'latest' ? '9.9.9' : decodeURIComponent(match[1])
      return new Response(JSON.stringify({ name: definition.name, version, dist: { integrity } }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }))

  const commands: string[] = []
  const releases: Array<{ action: string; commandsBefore: number }> = []
  // npm install --global --offline 只能从这次 npm ci 填好的缓存里装：下载时缺了平台主程序包，写进去的也缺。
  const downloadsWithPlatformBuild = new Set<string>()
  const waiters: Array<{ ready: () => boolean, resolve: () => void }> = []
  function record(entry: string): number {
    commands.push(entry)
    for (const waiter of [...waiters]) {
      if (!waiter.ready()) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
    return commands.filter((command) => command.split(' ')[0] === entry.split(' ')[0]).length
  }
  // 等「第 N 次下载或写入已经开始」这件事本身，不隔一段墙钟去轮询（同 install-cancel 的理由）。
  function reached(kind: 'download' | 'write', count: number): Promise<void> {
    const ready = () => commands.filter((command) => command.startsWith(`${kind} `)).length >= count
    if (ready()) return Promise.resolve()
    const waiter = deferred<void>()
    waiters.push({ ready, resolve: waiter.resolve })
    return waiter.promise
  }

  const runCommand = vi.fn(async (spec: CommandSpecLike, commandOptions: CommandOptionsLike = {}) => {
    if (spec.executable !== npmExecutable) throw new Error(`Unexpected command: ${spec.executable}`)
    const registry = spec.argv.find((argument) => argument.startsWith('--registry='))?.slice('--registry='.length) ?? ''
    if (spec.argv.includes('--package-lock-only') || spec.argv[0] === 'ci') {
      const cwd = commandOptions.cwd
      if (!cwd) throw new Error('Fake npm requires cwd')
      const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
        name: string
        version: string
        dependencies: Record<string, string>
      }
      const version = manifest.dependencies[definition.name]
      if (spec.argv[0] === 'ci') {
        const attempt = record(`download ${registry}`)
        const failure = options.downloadFails?.(attempt)
        if (failure) throw failure
        if (options.downloadHangs?.(attempt)) {
          // 真实的 npm ci 会跑好几分钟；这里只等取消信号，等到了就照 execFile 被中止时的样子抛错。
          await new Promise((_, reject) => {
            commandOptions.signal?.addEventListener('abort', () => reject(new Error('命令已被中止')), { once: true })
          })
        }
        const nodeModules = path.join(cwd, 'node_modules')
        writePackage(path.join(nodeModules, ...definition.name.split('/')), definition.name, version, definition.platformBuild)
        // npm 下载失败的可选依赖照样退出 0，只是 node_modules 里没有那个包。
        if (definition.platformBuild && (options.downloadHasPlatformBuild?.(attempt) ?? true)) {
          writePlatformBuild(nodeModules, definition.platformBuild)
          downloadsWithPlatformBuild.add(registry)
        }
      } else {
        const failure = options.resolutionFails?.(registry)
        if (failure) throw failure
        fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          lockfileVersion: 3,
          packages: {
            '': { dependencies: manifest.dependencies },
            [`node_modules/${definition.name}`]: { version, integrity },
          },
        }))
      }
    } else if (spec.argv[0] === 'install' && spec.argv.includes('--global')) {
      if (spec.argv.some((argument) => argument.startsWith('--prefix='))) {
        throw new Error('普通权限更新不该带 --prefix')
      }
      const attempt = record(`write ${registry}`)
      const requested = spec.argv.find((argument) => argument.startsWith(`${definition.name}@`))
      if (!requested) throw new Error('Fake npm install requires an exact package')
      await options.beforeFolderWrite?.(attempt, commandOptions.signal)
      writePackage(livePackage, definition.name, requested.slice(definition.name.length + 1), definition.platformBuild)
      if (definition.platformBuild && downloadsWithPlatformBuild.has(registry)) {
        writePlatformBuild(path.join(livePackage, 'node_modules'), definition.platformBuild)
      }
    } else {
      throw new Error(`Unexpected npm command: ${spec.argv.join(' ')}`)
    }
    return {
      executable: spec.executable,
      argv: [...spec.argv],
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputBytes: 0,
      durationMs: 1,
    }
  })

  function installedVersion(): string | null {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(livePackage, 'package.json'), 'utf8')) as { version?: unknown }
      return typeof manifest.version === 'string' ? manifest.version : null
    } catch {
      return null
    }
  }

  const resolveInstallation = vi.fn<typeof resolveCliInstallation>(async () => fs.existsSync(path.join(livePackage, 'package.json'))
    ? {
        commandPath: path.join(nodeDirectory, `${definition.command}.cmd`),
        installDirectory: livePackage,
        packageRoot: livePackage,
        npmPrefix: nodeDirectory,
        packageVersion: installedVersion(),
        source: 'npm',
      }
    : null)

  const target = { isDestroyed: () => false, send: vi.fn() }
  const runtimeLog = { log: vi.fn() }
  const service = createSystemService(
    new AppSettingsStore(path.join(root, 'settings.json'), root),
    {
      platform: 'win32',
      windowsExecutionMode: 'same-user',
      runCommand: runCommand as unknown as SystemServiceOptions['runCommand'],
      findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmExecutable : null),
      resolveCliInstallation: resolveInstallation,
      runtimeLog,
      ...(options.accelerated
        ? { acquireDownloadAcceleration: async () => ({ endpoint: null, accelerated: true, release: async () => undefined }) }
        : {}),
      releaseCodexRemote: async (action) => {
        // 记下这时已经跑过几条 npm：放开要在下载之前。
        releases.push({ action, commandsBefore: commands.length })
        await options.releaseCodexRemote?.(action)
      },
    },
  )
  return { service, target, runtimeLog, commands, releases, reached, installedVersion, livePackage }
}

function progressMessages(target: { send: ReturnType<typeof vi.fn> }) {
  return target.send.mock.calls
    .filter(([channel]) => channel === 'cli:install-progress')
    .map(([, event]) => event as { state: string; message: string; stage?: string })
}

describe('isMachineBoundNpmFailure', () => {
  it('treats a full disk as the same on every registry, whichever step reported it', () => {
    expect(isMachineBoundNpmFailure('命令执行失败（退出码 1）：node（ENOSPC；nospc ENOSPC: no space left on device, write）', false)).toBe(true)
    expect(isMachineBoundNpmFailure("ENOSPC: no space left on device, copyfile 'a' -> 'b'", false)).toBe(true)
  })

  it('treats a locked or denied folder in use as the same on every registry', () => {
    for (const code of ['EBUSY', 'ETXTBSY', 'EPERM', 'EACCES']) {
      expect(isMachineBoundNpmFailure(`命令执行失败（退出码 1）：node（${code}；${code}: rename）`, true)).toBe(true)
    }
  })

  it('lets the next registry try again when the lock was on a fresh staging folder or another step', () => {
    for (const code of ['EBUSY', 'ETXTBSY', 'EPERM', 'EACCES']) {
      expect(isMachineBoundNpmFailure(`命令执行失败（退出码 1）：node（${code}；${code}: rename）`, false)).toBe(false)
    }
  })

  it('lets the next registry try again after a network or registry failure', () => {
    for (const detail of [
      '命令执行失败（退出码 1）：node（ECONNRESET；network aborted）',
      '命令执行失败（退出码 1）：node（E500；500 Internal Server Error）',
      '下载太久没有完成，超时中止',
      'Codex CLI 的主程序没有下载完整，多半是网络不稳定。请关掉代理或换个网络后再装一次',
    ]) {
      expect(isMachineBoundNpmFailure(detail, true)).toBe(false)
    }
  })

  it('does not read a code out of a longer word', () => {
    expect(isMachineBoundNpmFailure('XEBUSYX ENOSPCY', true)).toBe(false)
  })
})

// 注入的 platform 管不到更新前那次进程检测：它读的是真实的 process.platform，在 Windows 主机上
// 会起一个真的 PowerShell，单元测试不许这样做；假 npm 也是 POSIX 脚本。所以只在 macOS / Linux
// 主机上跑，走的仍是 platform: 'win32' + same-user 这一段。
describe.runIf(process.platform !== 'win32')('updating a CLI in place on Windows without administrator rights', () => {
  it('skips a source whose download lacks the platform build before npm touches the folder in use', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      downloadHasPlatformBuild: (attempt) => attempt > 1,
    })

    await fixture.service.installCli('codex', fixture.target)

    // 官方源那次缺了主程序包，连 install --global 都没跑，直接换镜像重下。
    expect(fixture.commands).toEqual([
      `download ${officialRegistry}`,
      `download ${mirrorRegistry}`,
      `write ${mirrorRegistry}`,
    ])
    expect(fixture.installedVersion()).toBe(expectedVersion('codex'))
    const progress = progressMessages(fixture.target)
    expect(progress).toContainEqual(expect.objectContaining({ stage: 'switch-route' }))
    // 「下载校验完成，正在安装到本机」只在镜像那次说：官方源那次没下全，不该先报完成。
    expect(progress.filter((event) => event.stage === 'install')).toHaveLength(1)
    expect(progress).toContainEqual(expect.objectContaining({ state: 'success' }))
  })

  it('leaves the version in use alone when no source delivers the platform build', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      downloadHasPlatformBuild: () => false,
    })

    await expect(fixture.service.installCli('codex', fixture.target)).rejects.toThrow('Codex CLI 的主程序没有下载完整')

    expect(fixture.commands).toEqual([`download ${officialRegistry}`, `download ${mirrorRegistry}`])
    expect(fixture.installedVersion()).toBe(previousVersion)
    expect(fs.existsSync(path.join(fixture.livePackage, 'node_modules', '@openai', 'codex-win32-x64', 'package.json'))).toBe(true)
    const progress = progressMessages(fixture.target)
    expect(progress.filter((event) => event.stage === 'install')).toEqual([])
    expect(progress).not.toContainEqual(expect.objectContaining({ state: 'success' }))
  })

  it('refuses to cancel while npm writes into the folder in use and lets it finish', async () => {
    const writeMayFinish = deferred<void>()
    let writeSignal: AbortSignal | undefined
    const fixture = createInPlaceUpdateFixture({
      provider: 'gemini',
      beforeFolderWrite: async (_attempt, signal) => {
        writeSignal = signal
        await writeMayFinish.promise
      },
    })
    const install = fixture.service.installCli('gemini', fixture.target)
    await fixture.reached('write', 1)

    expect(fixture.service.cancelCliInstall('gemini')).toEqual({ cancelled: false, reason: writeSealReason })
    writeMayFinish.resolve()
    await install

    // 取消要是被接了，Windows 上就是 taskkill /T /F 掐掉写到一半的 npm。
    expect(writeSignal?.aborted).toBe(false)
    expect(fixture.installedVersion()).toBe(expectedVersion('gemini'))
    expect(progressMessages(fixture.target)).toContainEqual(expect.objectContaining({ state: 'success' }))
  })

  it('still cancels while the new version is only being downloaded', async () => {
    const fixture = createInPlaceUpdateFixture({ provider: 'gemini', downloadHangs: () => true })
    const settled = fixture.service.installCli('gemini', fixture.target).catch((error: unknown) => error)
    await fixture.reached('download', 1)

    expect(fixture.service.cancelCliInstall('gemini')).toEqual({ cancelled: true, reason: null })
    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('安装已取消')
    expect(fixture.commands).toEqual([`download ${officialRegistry}`])
    expect(fixture.installedVersion()).toBe(previousVersion)
  })

  // #1407 P3-3：手机遥控开着的那份 Codex 锁着这个目录。放开它要在一个字节都没下之前，挡下来时旧版原样能用。
  it('lets the remote control release its Codex before anything is downloaded', async () => {
    const fixture = createInPlaceUpdateFixture({ provider: 'codex' })

    await fixture.service.installCli('codex', fixture.target)

    expect(fixture.releases).toEqual([{ action: 'update', commandsBefore: 0 }])
    expect(fixture.commands).toEqual([`download ${officialRegistry}`, `write ${officialRegistry}`])
    expect(fixture.installedVersion()).toBe(expectedVersion('codex'))
  })

  it('leaves Codex as it was when the remote control is still using it', async () => {
    const busy = '手机遥控里的 Codex 正在干活，等它做完再更新，或者先在设置里关掉手机遥控。'
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      releaseCodexRemote: async () => { throw new Error(busy) },
    })

    const error = await fixture.service.installCli('codex', fixture.target).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(busy)
    // 错误框原样说这句，不配「文件被占用」「连不上」这类标题。
    expect(classifyOperationError(busy)).toBe('unknown')
    expect(fixture.releases).toEqual([{ action: 'update', commandsBefore: 0 }])
    expect(fixture.commands).toEqual([])
    expect(fixture.installedVersion()).toBe(previousVersion)
  })

  it('does not bother the remote control when another tool is updated', async () => {
    const fixture = createInPlaceUpdateFixture({ provider: 'gemini' })

    await fixture.service.installCli('gemini', fixture.target)

    expect(fixture.releases).toEqual([])
    expect(fixture.commands).toEqual([`download ${officialRegistry}`, `write ${officialRegistry}`])
  })

  it('stops at the first source when the folder in use is locked instead of downloading again', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      beforeFolderWrite: async () => { throw npmFailure(folderBusyStderr) },
    })

    const error = await fixture.service.installCli('codex', fixture.target).catch((failure: unknown) => failure)

    // 以前接着从镜像从头再下一遍，再撞上同一把锁。
    expect(fixture.commands).toEqual([`download ${officialRegistry}`, `write ${officialRegistry}`])
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('文件被占用')
    expect(message).toContain('EBUSY')
    expect(message).not.toContain('国内 npm 镜像')
    expect(classifyOperationError(message)).toBe('toolRunning')
    expect(fixture.installedVersion()).toBe(previousVersion)
    expect(progressMessages(fixture.target)).not.toContainEqual(expect.objectContaining({ stage: 'switch-route' }))
    expect(fixture.runtimeLog.log).toHaveBeenCalledWith(
      'warn',
      'install',
      'cli.install.machine-bound-failure',
      expect.any(String),
      { provider: 'codex', registry: officialRegistry, writingFolderInUse: true, copyingFolderInUse: false },
    )
  })

  it('stops at the first source when the folder in use refuses the write', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      beforeFolderWrite: async () => { throw npmFailure(folderDeniedStderr) },
    })

    const error = await fixture.service.installCli('codex', fixture.target).catch((failure: unknown) => failure)

    expect(fixture.commands).toEqual([`download ${officialRegistry}`, `write ${officialRegistry}`])
    const message = (error as Error).message
    expect(message).toContain('EPERM')
    // EPERM 没数到工具的进程就不说成「文件被占用」，照旧归到权限那一类。
    expect(classifyOperationError(message)).toBe('permission')
    expect(fixture.installedVersion()).toBe(previousVersion)
  })

  it('stops at the first source when the disk fills up during the download', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      downloadFails: () => npmFailure(diskFullStderr),
    })

    const error = await fixture.service.installCli('codex', fixture.target).catch((failure: unknown) => failure)

    expect(fixture.commands).toEqual([`download ${officialRegistry}`])
    const message = (error as Error).message
    expect(message).toBe('Codex CLI 安装失败：npm 官方源：磁盘空间不足（错误码 ENOSPC）。')
    // npm 的原话进运行日志，不上屏（#1100 第1条）。
    expect(((error as Error).cause as Error).message).toBe('npm 官方源：命令执行失败（退出码 1）：node（ENOSPC；nospc ENOSPC: no space left on device, write）')
    expect(classifyOperationError(message)).toBe('diskFull')
    expect(fixture.installedVersion()).toBe(previousVersion)
    expect(fixture.runtimeLog.log).toHaveBeenCalledWith(
      'warn',
      'install',
      'cli.install.machine-bound-failure',
      expect.any(String),
      { provider: 'codex', registry: officialRegistry, writingFolderInUse: false, copyingFolderInUse: false },
    )
  })

  it('lets the next source be cancelled again after writing into the folder failed on the first', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'gemini',
      downloadHangs: (attempt) => attempt > 1,
      beforeFolderWrite: async () => {
        throw new Error('npm error code ECONNRESET')
      },
    })
    const settled = fixture.service.installCli('gemini', fixture.target).catch((error: unknown) => error)
    await fixture.reached('download', 2)

    expect(fixture.service.cancelCliInstall('gemini')).toEqual({ cancelled: true, reason: null })
    const error = await settled
    expect((error as Error).message).toContain('安装已取消')
    expect(fixture.commands).toEqual([
      `download ${officialRegistry}`,
      `write ${officialRegistry}`,
      `download ${mirrorRegistry}`,
    ])
  })
})

const registryTimeoutStderr = [
  'npm error code ETIMEDOUT',
  'npm error errno ETIMEDOUT',
  'npm error network request to https://registry.npmjs.org/@openai%2fcodex failed, reason: connect ETIMEDOUT 104.16.0.35:443',
  '',
].join('\n')

// 装之前到官方源核对安装清单那一步只能走官方源，连不上时要说清这一点和下一步（#1057 第5b条），
// 别的原因按 npm 原因表说（#1100 第1条）。同上，只在 macOS / Linux 主机上跑。
describe.runIf(process.platform !== 'win32')('checking the install manifest against the official registry', () => {
  // 网络加速 2026-10-30 下线以后，没开过加速的人也不再叫他去开，跟 Linux 一样说换个网络。
  it('says the official registry was unreachable and to switch networks, now that acceleration is retired', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      resolutionFails: (registry) => registry === officialRegistry ? npmFailure(registryTimeoutStderr) : undefined,
    })

    const error = await fixture.service.installCli('codex', fixture.target).catch((failure: unknown) => failure)

    const message = (error as Error).message
    expect(message).toBe('Codex CLI 安装失败：装之前要先到 npm 官方源核对安装清单，这一步没连上（错误码 ETIMEDOUT）。换个网络（比如手机热点）后再试。')
    expect(classifyOperationError(message)).toBe('officialRegistryUnreachable')
    expect(((error as Error).cause as CommandRunnerError).stderr).toBe(registryTimeoutStderr)
    expect(fixture.installedVersion()).toBe(previousVersion)
  })

  it('says to switch networks when acceleration was already on', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      accelerated: true,
      resolutionFails: (registry) => registry === officialRegistry ? npmFailure(registryTimeoutStderr) : undefined,
    })

    const error = await fixture.service.installCli('codex', fixture.target).catch((failure: unknown) => failure)

    expect((error as Error).message).toBe('Codex CLI 安装失败：装之前要先到 npm 官方源核对安装清单，这一步没连上（错误码 ETIMEDOUT）。换个网络（比如手机热点）后再试。')
  })

  it('names a version the registry does not have in Chinese and says what to do', async () => {
    const fixture = createInPlaceUpdateFixture({
      provider: 'codex',
      resolutionFails: (registry) => registry === officialRegistry
        ? npmFailure(['npm error code ETARGET', 'npm error notarget No matching version found for @openai/codex@0.0.1.', ''].join('\n'))
        : undefined,
    })

    const error = await fixture.service.installCli('codex', fixture.target).catch((failure: unknown) => failure)

    const message = (error as Error).message
    expect(message).toBe('Codex CLI 安装失败：npm 官方源：找不到要装的版本（错误码 ETARGET）。过一会儿再点「重试」；一直这样请找客服。')
    // 整句自己说清了下一步，错误框不另配标题。
    expect(classifyOperationError(message)).toBe('unknown')
  })
})
