import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import type { AntigravityManagedKey } from './account-cli-provisioner'
import { staleAccountMessage, type QueuedAccountWork } from './account-work-gate'
import type { AntigravityEnvironmentValues, AntigravityGatewayEnvironment } from './antigravity-gateway'
import {
  antigravityCliLaunchQueueKey,
  antigravityDesktopLaunchQueueKey,
  antigravityDesktopMacCandidates,
  antigravityEnvironmentFingerprint,
  AntigravityElevatedSessionError,
  antigravityInstallQueueKey,
  buildAntigravityDesktopWindowsProcessScript,
  createAntigravityService,
  isAntigravityEnvironmentCurrent,
  isAntigravitySupported,
  isPlainBundleExecutableName,
  parseAntigravityDesktopMacProcesses,
  parseAntigravityDesktopWindowsProcesses,
  withAntigravityEnvironment,
  type AntigravityDetachedLaunchPlan,
  type AntigravityProgress,
  type AntigravityServiceDependencies,
} from './antigravity-service'
import { CommandRunnerError, type CommandResult, type CommandSpec, type RunCommandOptions } from './command-runner'
import { buildPowerShellJsonOutputStatements, powerShellUtf8OutputStatement } from './powershell-constrained-language'
import type { WindowsCliLaunchRequest } from './windows-elevation'
import type { MacosTerminalLaunchPlan } from './macos-platform'

const gatewayBaseUrl = 'https://xm-direct.solov.cc'
const managedKey: AntigravityManagedKey = {
  key: 'sk-antigravity-test-0123456789',
  group: 'Gemini',
  models: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-4-hydrogen'],
}
const writtenEnvironment: AntigravityGatewayEnvironment = {
  AGY_LLM_GATEWAY_URL: gatewayBaseUrl,
  AGY_LLM_GATEWAY_API_KEY: managedKey.key,
  AGY_LLM_GATEWAY_WIRE_PROTOCOL: 'genai',
  AGY_LLM_GATEWAY_MODELS: 'gemini-3.8-flash,gemini-4-argon,gemini-4-hydrogen',
}

const windowsHome = 'C:\\Users\\yoyo'
const windowsLocalAppData = 'C:\\Users\\yoyo\\AppData\\Local'
const windowsCli = 'C:\\Users\\yoyo\\AppData\\Local\\agy\\bin\\agy.exe'
const windowsDesktop = 'C:\\Users\\yoyo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe'
const windowsWorkspace = 'D:\\projects\\demo'
const macHome = '/Users/yoyo'
const macCli = '/Users/yoyo/.local/bin/agy'
const macBundle = '/Applications/Antigravity.app'
const macExecutable = '/Applications/Antigravity.app/Contents/MacOS/Antigravity'
const macWorkspace = '/Users/yoyo/projects/demo'

function commandResult(spec: CommandSpec, stdout = ''): CommandResult {
  return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 }
}

function codesignRefusal(spec: CommandSpec, exitCode: number): CommandRunnerError {
  return new CommandRunnerError('codesign refused', {
    code: 'EXIT_NON_ZERO', executable: spec.executable, argv: [...spec.argv], exitCode, signal: null,
    stdout: '', stderr: 'test-requirement not satisfied', outputBytes: 0, maxOutputBytes: 1024, durationMs: 1,
  })
}

interface Harness {
  service: ReturnType<typeof createAntigravityService>
  queueKeys: string[]
  settingsWrites: number
  writes: AntigravityGatewayEnvironment[]
  commands: Array<{ spec: CommandSpec, options: RunCommandOptions }>
  launches: AntigravityDetachedLaunchPlan[]
  windowsTerminals: WindowsCliLaunchRequest[]
  macTerminals: MacosTerminalLaunchPlan[]
  logs: Array<{ level: string, event: string, message: string, detail?: Record<string, unknown> }>
  verifiedCli: string[]
  deps: AntigravityServiceDependencies
  setMacProcesses(value: string): void
}

interface HarnessOptions {
  platform?: NodeJS.Platform
  architecture?: NodeJS.Architecture
  executionMode?: 'same-user' | 'trusted-only'
  files?: string[]
  directories?: string[]
  stored?: AntigravityEnvironmentValues
  readFails?: boolean
  writeOutcome?: 'written' | 'unchanged'
  runningWindows?: string[] | 'probe-fails'
  macProcesses?: string
  codesignExit?: number
  bundleExecutable?: string
  launchPid?: number
  overrides?: Partial<AntigravityServiceDependencies>
}

function harness(options: HarnessOptions = {}): Harness {
  const platform = options.platform ?? 'win32'
  const files = new Set(options.files ?? [])
  const directories = new Set(options.directories ?? [])
  const state: Omit<Harness, 'service' | 'deps' | 'setMacProcesses'> = {
    queueKeys: [], settingsWrites: 0, writes: [], commands: [], launches: [], windowsTerminals: [], macTerminals: [], logs: [], verifiedCli: [],
  }
  let macProcesses = options.macProcesses ?? ''
  const deps: AntigravityServiceDependencies = {
    platform,
    architecture: options.architecture ?? 'arm64',
    env: platform === 'win32' ? { LOCALAPPDATA: windowsLocalAppData, PATH: 'C:\\Windows\\System32' } : { HOME: macHome, PATH: '/usr/bin:/bin' },
    userHome: platform === 'win32' ? windowsHome : macHome,
    executionMode: options.executionMode ?? 'same-user',
    enqueue: (key, task) => {
      state.queueKeys.push(key)
      return task()
    },
    serializeSettingsWrite: (operation) => {
      state.settingsWrites += 1
      return operation()
    },
    gatewayBaseUrl: () => gatewayBaseUrl,
    terminalEnvironment: (env) => ({ ...env, TERM: 'xterm-256color' }),
    fetch: vi.fn<typeof fetch>(),
    log: (level, event, message, detail) => { state.logs.push({ level, event, message, ...(detail ? { detail } : {}) }) },
    isPlainFile: (filePath) => files.has(filePath),
    isPlainDirectory: (directoryPath) => directories.has(directoryPath),
    assertWorkspace: () => undefined,
    readWindowsEnvironment: async () => {
      if (options.readFails) throw new Error('PowerShell 没跑起来')
      return options.stored ?? {}
    },
    readMacosEnvironment: async () => {
      if (options.readFails) throw new Error('读不出来')
      return options.stored ?? {}
    },
    writeWindowsEnvironment: async (environment) => {
      state.writes.push(environment)
      return options.writeOutcome ?? 'written'
    },
    writeMacosEnvironment: async (environment) => {
      state.writes.push(environment)
      return { outcome: options.writeOutcome ?? 'written', profile: 'present' }
    },
    installCli: vi.fn(async (install) => {
      install.onProgress?.({ transferred: 5, total: 10, percent: 50 })
      return { version: '1.5.15', executablePath: platform === 'win32' ? windowsCli : macCli, source: 'bucket' as const }
    }),
    installDesktopWindows: vi.fn(async (install) => {
      install.onProgress?.({ phase: 'verifying', percent: 100 })
      return { version: '2.34.0', executablePath: windowsDesktop }
    }),
    installDesktopMac: vi.fn(async (install) => {
      install.onProgress?.({ phase: 'checking', message: '正在核对', percent: null })
      return { version: '2.34.0', path: macBundle }
    }),
    verifyWindowsCli: async (executablePath) => { state.verifiedCli.push(executablePath) },
    verifyMacosCli: async (executablePath) => { state.verifiedCli.push(executablePath) },
    launchWindowsTerminal: async (request) => { state.windowsTerminals.push(request) },
    launchMacosTerminal: async (plan) => { state.macTerminals.push(plan) },
    launchProcess: async (plan) => {
      state.launches.push(plan)
      return options.launchPid ?? 4242
    },
    resolveWindowsShell: () => ({ explorer: 'C:\\Windows\\explorer.exe', systemRoot: 'C:\\Windows' }),
    resolvePowerShellExecutable: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    runCommand: async (spec, runOptions = {}) => {
      state.commands.push({ spec, options: runOptions })
      if (spec.executable.endsWith('powershell.exe')) {
        if (options.runningWindows === 'probe-fails') throw new Error('PowerShell 超时')
        return commandResult(spec, JSON.stringify(options.runningWindows ?? []))
      }
      if (spec.executable === '/usr/bin/codesign') {
        if (options.codesignExit) throw codesignRefusal(spec, options.codesignExit)
        return commandResult(spec)
      }
      if (spec.executable === '/usr/bin/plutil') return commandResult(spec, `${options.bundleExecutable ?? 'Antigravity'}\n`)
      if (spec.executable === '/bin/ps') return commandResult(spec, macProcesses)
      return commandResult(spec)
    },
    ...options.overrides,
  }
  const service = createAntigravityService(deps)
  return Object.assign(state, { service, deps, setMacProcesses: (value: string) => { macProcesses = value } })
}

function resolveKey(): Promise<AntigravityManagedKey> {
  return Promise.resolve(managedKey)
}

describe('antigravity-service pure helpers', () => {
  it('names install entries so the quit guard counts them as installs', () => {
    expect(antigravityInstallQueueKey('cli')).toBe('antigravity:install:cli')
    expect(antigravityInstallQueueKey('desktop')).toBe('antigravity:install:desktop')
    expect(antigravityInstallQueueKey('cli').startsWith('cli:launch:')).toBe(false)
    expect(antigravityDesktopLaunchQueueKey.startsWith('cli:launch:')).toBe(false)
  })

  it('merges two CLI opens of the same folder and keeps the launch prefix', () => {
    expect(antigravityCliLaunchQueueKey('D:\\Projects\\Demo\\', 'win32')).toBe(antigravityCliLaunchQueueKey('d:\\projects\\demo', 'win32'))
    expect(antigravityCliLaunchQueueKey('/Users/yoyo/a/../b', 'darwin')).toBe('cli:launch:antigravity:/Users/yoyo/b')
    expect(antigravityCliLaunchQueueKey('/Users/yoyo/A', 'darwin')).not.toBe(antigravityCliLaunchQueueKey('/Users/yoyo/a', 'darwin'))
  })

  it('supports Windows and macOS on x64 and arm64 only', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      for (const architecture of ['x64', 'arm64'] as const) expect(isAntigravitySupported(platform, architecture)).toBe(true)
      expect(isAntigravitySupported(platform, 'ia32')).toBe(false)
    }
    expect(isAntigravitySupported('linux', 'x64')).toBe(false)
    expect(isAntigravitySupported('linux', 'arm64')).toBe(false)
  })

  it('counts settings as current only when all four point at this line with genai', () => {
    expect(isAntigravityEnvironmentCurrent(writtenEnvironment, gatewayBaseUrl)).toBe(true)
    expect(isAntigravityEnvironmentCurrent(writtenEnvironment, 'https://xm.solov.cc')).toBe(false)
    expect(isAntigravityEnvironmentCurrent({ ...writtenEnvironment, AGY_LLM_GATEWAY_WIRE_PROTOCOL: 'openai' }, gatewayBaseUrl)).toBe(false)
    expect(isAntigravityEnvironmentCurrent({ ...writtenEnvironment, AGY_LLM_GATEWAY_MODELS: ' ' }, gatewayBaseUrl)).toBe(false)
    const { AGY_LLM_GATEWAY_API_KEY: _key, ...withoutKey } = writtenEnvironment
    expect(isAntigravityEnvironmentCurrent(withoutKey, gatewayBaseUrl)).toBe(false)
    expect(isAntigravityEnvironmentCurrent(writtenEnvironment, 'https://xm-direct.solov.cc.evil.com')).toBe(false)
    expect(isAntigravityEnvironmentCurrent({}, gatewayBaseUrl)).toBe(false)
  })

  it('replaces gateway variables whatever their case and keeps everything else', () => {
    const merged = withAntigravityEnvironment({
      agy_llm_gateway_url: 'https://old.example', Agy_Llm_Gateway_Api_Key: 'old', AGY_LLM_GATEWAY_HEADERS: 'x-a: 1', PATH: 'C:\\bin',
    }, writtenEnvironment)
    expect(merged).toEqual({ ...writtenEnvironment, AGY_LLM_GATEWAY_HEADERS: 'x-a: 1', PATH: 'C:\\bin' })
  })

  it('fingerprints the written settings and changes with any value', () => {
    const base = antigravityEnvironmentFingerprint(writtenEnvironment)
    expect(antigravityEnvironmentFingerprint({ ...writtenEnvironment })).toBe(base)
    expect(base).not.toContain(managedKey.key)
    for (const name of Object.keys(writtenEnvironment) as Array<keyof AntigravityGatewayEnvironment>) {
      expect(antigravityEnvironmentFingerprint({ ...writtenEnvironment, [name]: `${writtenEnvironment[name]}x` })).not.toBe(base)
    }
  })

  it('looks for the app in /Applications first, then ~/Applications', () => {
    expect(antigravityDesktopMacCandidates(macHome)).toEqual([macBundle, '/Users/yoyo/Applications/Antigravity.app'])
  })

  it('lists running Windows apps in a way constrained language mode and a narrowed module path still run', () => {
    const script = buildAntigravityDesktopWindowsProcessScript()
    const lines = script.split('\n')
    const imports = lines.findIndex((line) => line.startsWith('Import-Module'))
    const stop = lines.findIndex((line) => line.includes('$ErrorActionPreference'))
    const listing = lines.findIndex((line) => line.includes('Get-Process'))
    // The UTF-8 line is refused in ConstrainedLanguage, so it runs only in FullLanguage.
    expect(lines[0]).toBe(powerShellUtf8OutputStatement)
    // Get-Process lives in Management; under trustedCommandEnvironment autoloading it costs seconds.
    expect(lines[imports]).toMatch(/^Import-Module -Name 'Microsoft\.PowerShell\.Utility', 'Microsoft\.PowerShell\.Management'/)
    expect(imports).toBeLessThan(listing)
    expect(stop).toBeLessThan(listing)
    // A Chinese user name in the path stays readable where the output is left in the console code page.
    expect(script.endsWith(buildPowerShellJsonOutputStatements('ConvertTo-Json -InputObject @($paths) -Compress').join('\n'))).toBe(true)
    expect(script).not.toMatch(/pscustomobject|Add-Type|\[Environment\]::/i)
    const escaped = JSON.stringify(['C:\\Users\\\u5f20\u4e09\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe']).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    expect(parseAntigravityDesktopWindowsProcesses(escaped, 'C:\\Users\\张三\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe')).toBe(true)
  })

  it('reads the running Windows app paths case-insensitively', () => {
    expect(buildAntigravityDesktopWindowsProcessScript()).toContain('Get-Process -Name Antigravity')
    expect(parseAntigravityDesktopWindowsProcesses(JSON.stringify([windowsDesktop.toUpperCase()]), windowsDesktop)).toBe(true)
    expect(parseAntigravityDesktopWindowsProcesses('[]', windowsDesktop)).toBe(false)
    expect(parseAntigravityDesktopWindowsProcesses('', windowsDesktop)).toBe(false)
    expect(parseAntigravityDesktopWindowsProcesses(JSON.stringify(['D:\\Other\\Antigravity.exe']), windowsDesktop)).toBe(false)
    expect(parseAntigravityDesktopWindowsProcesses('not json', windowsDesktop)).toBeNull()
    expect(parseAntigravityDesktopWindowsProcesses('{"a":1}', windowsDesktop)).toBeNull()
  })

  it('takes only main processes of this bundle on macOS', () => {
    const stdout = [
      `  101 ${macExecutable}`,
      `  102 ${macBundle}/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper`,
      '  103 /Users/yoyo/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      'garbage',
    ].join('\n')
    expect(parseAntigravityDesktopMacProcesses(stdout, macBundle)).toEqual([101])
  })

  it('accepts only a plain file name as the bundle executable', () => {
    expect(isPlainBundleExecutableName('Antigravity')).toBe(true)
    expect(isPlainBundleExecutableName('Antigravity Hub')).toBe(true)
    for (const name of ['', '.', '..', '../x', 'a/b', '-x', 'a\0b', 'x'.repeat(200)]) expect(isPlainBundleExecutableName(name)).toBe(false)
  })
})

describe('createAntigravityService inspect', () => {
  it('reports an unsupported computer without touching anything', async () => {
    const readWindowsEnvironment = vi.fn()
    const { service } = harness({ platform: 'linux', architecture: 'x64', overrides: { readWindowsEnvironment, readMacosEnvironment: readWindowsEnvironment } })
    await expect(service.inspect()).resolves.toEqual({ supported: false, cliInstalled: false, desktopInstalled: false, configured: false })
    expect(readWindowsEnvironment).not.toHaveBeenCalled()
  })

  it('finds both Windows installs and current settings', async () => {
    const { service } = harness({ files: [windowsCli, windowsDesktop], stored: writtenEnvironment })
    await expect(service.inspect()).resolves.toEqual({ supported: true, cliInstalled: true, desktopInstalled: true, configured: true })
  })

  it('treats unreadable settings as not configured and logs why', async () => {
    const { service, logs } = harness({ files: [windowsCli], readFails: true })
    await expect(service.inspect()).resolves.toEqual({ supported: true, cliInstalled: true, desktopInstalled: false, configured: false })
    expect(logs.map((entry) => entry.event)).toContain('antigravity.settings.read-failed')
  })

  it('finds the Mac app in ~/Applications and settings for another line as stale', async () => {
    const { service } = harness({
      platform: 'darwin', directories: ['/Users/yoyo/Applications/Antigravity.app'], stored: { ...writtenEnvironment, AGY_LLM_GATEWAY_URL: 'https://xm.solov.cc' },
    })
    await expect(service.inspect()).resolves.toEqual({ supported: true, cliInstalled: false, desktopInstalled: true, configured: false })
  })
})

describe('createAntigravityService install', () => {
  it('installs agy in the install queue, then writes settings from the resolved key', async () => {
    const progress: AntigravityProgress[] = []
    const h = harness({ files: [windowsCli], stored: writtenEnvironment })
    const result = await h.service.install('cli', resolveKey, (event) => progress.push(event))
    expect(h.queueKeys).toEqual(['antigravity:install:cli'])
    expect(h.deps.installCli).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'same-user', platform: 'win32', homeDirectory: windowsHome }))
    expect(progress).toEqual([
      { target: 'cli', phase: 'downloading', percent: 50 },
      { target: 'cli', phase: 'configuring', percent: null },
    ])
    expect(h.writes).toEqual([writtenEnvironment])
    expect(h.settingsWrites).toBe(1)
    expect(result).toEqual({ status: { supported: true, cliInstalled: true, desktopInstalled: false, configured: true } })
  })

  it('keeps a finished install when the key cannot be resolved', async () => {
    const h = harness({ files: [windowsDesktop] })
    const result = await h.service.install('desktop', () => Promise.reject(new Error('服务暂时不可用')))
    expect(h.deps.installDesktopWindows).toHaveBeenCalledOnce()
    expect(h.writes).toEqual([])
    expect(result).toEqual({ status: { supported: true, cliInstalled: false, desktopInstalled: true, configured: false }, configureError: '服务暂时不可用' })
    expect(h.logs.map((entry) => entry.event)).toContain('antigravity.settings.failed')
  })

  it('does not write settings when the install itself fails', async () => {
    const installCli = vi.fn(async () => { throw new Error('下载失败') })
    const key = vi.fn(resolveKey)
    const h = harness({ overrides: { installCli } })
    await expect(h.service.install('cli', key)).rejects.toThrow('下载失败')
    expect(key).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('installs the Mac app through the desktop source table and maps its phases', async () => {
    const progress: AntigravityProgress[] = []
    const h = harness({ platform: 'darwin', architecture: 'x64', directories: [macBundle] })
    await h.service.install('desktop', resolveKey, (event) => progress.push(event))
    expect(h.deps.installDesktopMac).toHaveBeenCalledWith(expect.objectContaining({ tool: 'antigravityDesktop', architecture: 'x64', userHome: macHome }))
    expect(progress[0]).toEqual({ target: 'desktop', phase: 'verifying', percent: null })
    expect(h.writes).toEqual([writtenEnvironment])
  })

  it('refuses an unknown target and an unsupported computer', async () => {
    const h = harness()
    // @ts-expect-error the IPC parser only lets cli and desktop through
    await expect(h.service.install('gemini', resolveKey)).rejects.toThrow('未知的 Antigravity 安装项')
    const linux = harness({ platform: 'linux', architecture: 'x64' })
    await expect(linux.service.install('cli', resolveKey)).rejects.toThrow('不支持 Antigravity')
    expect(linux.queueKeys).toEqual([])
  })
})

describe('createAntigravityService configure', () => {
  it('refuses an elevated Windows session before asking for a key', async () => {
    const key = vi.fn(resolveKey)
    const h = harness({ executionMode: 'trusted-only' })
    await expect(h.service.configure(key)).rejects.toBeInstanceOf(AntigravityElevatedSessionError)
    await expect(h.service.openDesktop(key)).rejects.toBeInstanceOf(AntigravityElevatedSessionError)
    await expect(h.service.openCli(windowsWorkspace, key)).rejects.toBeInstanceOf(AntigravityElevatedSessionError)
    expect(key).not.toHaveBeenCalled()
    expect(h.queueKeys).toEqual([])
  })

  it('ignores the Windows execution mode on macOS', async () => {
    const h = harness({ platform: 'darwin', executionMode: 'trusted-only' })
    await h.service.configure(resolveKey)
    expect(h.writes).toEqual([writtenEnvironment])
  })

  it('reads the gateway address once per write', async () => {
    let calls = 0
    const h = harness({ overrides: { gatewayBaseUrl: () => { calls += 1; return calls === 1 ? gatewayBaseUrl : 'https://xm.solov.cc' } } })
    await h.service.configure(resolveKey)
    expect(h.writes[0].AGY_LLM_GATEWAY_URL).toBe(gatewayBaseUrl)
  })

  it('never puts the key in a log entry, whatever the key', async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9._~+/=-]{8,64}$/), async (key) => {
      const h = harness({ platform: 'darwin', directories: [macBundle], files: [macExecutable] })
      await h.service.configure(() => Promise.resolve({ ...managedKey, key }))
      await h.service.openDesktop(() => Promise.resolve({ ...managedKey, key }))
      expect(JSON.stringify(h.logs)).not.toContain(key)
      expect(h.launches).toHaveLength(1)
      expect(h.launches.every((plan) => !plan.argv.some((argument) => argument.includes(key)))).toBe(true)
    }), { numRuns: 40 })
  })
})

describe('createAntigravityService openDesktop on Windows', () => {
  it('says the app is missing before writing anything', async () => {
    const h = harness()
    await expect(h.service.openDesktop(resolveKey)).rejects.toThrow('未检测到 Antigravity，请先安装')
    expect(h.writes).toEqual([])
  })

  it('writes settings and hands the unsigned app to Explorer without a signature check', async () => {
    const verifyWindowsCli = vi.fn()
    const h = harness({ files: [windowsDesktop], overrides: { verifyWindowsCli } })
    await expect(h.service.openDesktop(resolveKey)).resolves.toEqual({ opened: true })
    expect(h.queueKeys).toEqual([antigravityDesktopLaunchQueueKey])
    expect(h.writes).toEqual([writtenEnvironment])
    expect(h.launches).toEqual([expect.objectContaining({ executable: 'C:\\Windows\\explorer.exe', argv: [windowsDesktop], cwd: 'C:\\Windows', windowsHide: true })])
    expect(h.launches[0].env.AGY_LLM_GATEWAY_API_KEY).toBeUndefined()
    expect(verifyWindowsCli).not.toHaveBeenCalled()
    const probe = h.commands.find((entry) => entry.spec.executable.endsWith('powershell.exe'))
    expect(probe?.options).toEqual(expect.objectContaining({ trustedOnly: true }))
  })

  it('asks to close a running app that has the old settings', async () => {
    const h = harness({ files: [windowsDesktop], runningWindows: [windowsDesktop], writeOutcome: 'written' })
    await expect(h.service.openDesktop(resolveKey)).resolves.toEqual({ opened: false, closeFirst: true })
    expect(h.launches).toEqual([])
  })

  it('brings a running app forward when the settings did not change', async () => {
    const h = harness({ files: [windowsDesktop], runningWindows: [windowsDesktop], writeOutcome: 'unchanged' })
    await expect(h.service.openDesktop(resolveKey)).resolves.toEqual({ opened: true })
    expect(h.launches).toHaveLength(1)
  })

  it('still opens when it cannot tell whether the app is running', async () => {
    const h = harness({ files: [windowsDesktop], runningWindows: 'probe-fails' })
    await expect(h.service.openDesktop(resolveKey)).resolves.toEqual({ opened: true })
    expect(h.logs.map((entry) => entry.event)).toContain('antigravity.desktop.process-probe-failed')
  })

  it('does not open when the key cannot be resolved', async () => {
    const h = harness({ files: [windowsDesktop] })
    await expect(h.service.openDesktop(() => Promise.reject(new Error('服务暂时不可用')))).rejects.toThrow('服务暂时不可用')
    expect(h.launches).toEqual([])
  })

  it('neither writes settings nor opens anything once the account the click was queued for has changed', async () => {
    const enqueued: Array<{ signal?: AbortSignal } | undefined> = []
    const h = harness({ files: [windowsDesktop, windowsCli], overrides: { enqueue: (_key, task, options) => { enqueued.push(options); return task() } } })
    const controller = new AbortController()
    const changed: QueuedAccountWork = { signal: controller.signal, run: async () => { throw new Error(staleAccountMessage) }, isCurrent: () => false }
    await expect(h.service.openDesktop(resolveKey, changed)).rejects.toThrow(staleAccountMessage)
    await expect(h.service.openCli(windowsWorkspace, resolveKey, changed)).rejects.toThrow(staleAccountMessage)
    // The queue drops a waiting open as soon as the account starts changing.
    expect(enqueued).toEqual([{ signal: controller.signal }, { signal: controller.signal }])
    expect(h.writes).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.windowsTerminals).toEqual([])
  })
})

describe('createAntigravityService openDesktop on macOS', () => {
  it('verifies the bundle, then starts its main program with the settings in the environment only', async () => {
    const h = harness({ platform: 'darwin', directories: [macBundle], files: [macExecutable] })
    await expect(h.service.openDesktop(resolveKey)).resolves.toEqual({ opened: true })
    const codesign = h.commands.find((entry) => entry.spec.executable === '/usr/bin/codesign')
    expect(codesign?.spec.argv).toEqual(expect.arrayContaining(['--deep', macBundle]))
    expect(codesign?.spec.argv.join(' ')).toContain('EQHXZ8M8AV')
    expect(codesign?.spec.argv.join(' ')).toContain('com.google.antigravity')
    expect(h.launches).toHaveLength(1)
    expect(h.launches[0]).toEqual(expect.objectContaining({ executable: macExecutable, argv: [], cwd: macHome }))
    expect(h.launches[0].env).toEqual(expect.objectContaining(writtenEnvironment))
  })

  it('refuses a bundle that is not Google\'s and writes nothing', async () => {
    for (const exitCode of [1, 3]) {
      const h = harness({ platform: 'darwin', directories: [macBundle], files: [macExecutable], codesignExit: exitCode })
      await expect(h.service.openDesktop(resolveKey)).rejects.toThrow('不是谷歌官方签名的原版')
      expect(h.writes).toEqual([])
      expect(h.launches).toEqual([])
    }
  })

  it('refuses a bundle executable name that leaves Contents/MacOS', async () => {
    const h = harness({ platform: 'darwin', directories: [macBundle], files: [macExecutable], bundleExecutable: '../../../../bin/sh' })
    await expect(h.service.openDesktop(resolveKey)).rejects.toThrow('不是谷歌官方签名的原版')
    expect(h.launches).toEqual([])
  })

  it('asks to close an app it did not start, and only focuses the one it started with the same settings', async () => {
    const h = harness({ platform: 'darwin', directories: [macBundle], files: [macExecutable], macProcesses: `  77 ${macExecutable}`, launchPid: 4242 })
    await expect(h.service.openDesktop(resolveKey)).resolves.toEqual({ opened: false, closeFirst: true })
    expect(h.launches).toEqual([])

    const ours = harness({ platform: 'darwin', directories: [macBundle], files: [macExecutable], launchPid: 4242 })
    await ours.service.openDesktop(resolveKey)
    ours.setMacProcesses(`  4242 ${macExecutable}`)
    await expect(ours.service.openDesktop(resolveKey)).resolves.toEqual({ opened: true })
    expect(ours.launches).toHaveLength(1)
    expect(ours.commands.some((entry) => entry.spec.executable === '/usr/bin/open' && entry.spec.argv.join(' ') === `-a ${macBundle}`)).toBe(true)

    await expect(ours.service.openDesktop(() => Promise.resolve({ ...managedKey, models: ['gemini-4-argon'] }))).resolves.toEqual({ opened: false, closeFirst: true })
  })
})

describe('createAntigravityService openCli', () => {
  it('verifies agy, then opens PowerShell in the folder with this write\'s settings', async () => {
    const h = harness({ files: [windowsCli] })
    await h.service.openCli(windowsWorkspace, resolveKey)
    expect(h.queueKeys).toEqual([antigravityCliLaunchQueueKey(windowsWorkspace, 'win32')])
    expect(h.verifiedCli).toEqual([windowsCli])
    expect(h.windowsTerminals).toHaveLength(1)
    expect(h.windowsTerminals[0]).toEqual(expect.objectContaining({ executable: windowsCli, argv: [], workspace: windowsWorkspace, title: 'Antigravity 命令行 · 星芒AI' }))
    expect(h.windowsTerminals[0].env).toEqual(expect.objectContaining({ ...writtenEnvironment, TERM: 'xterm-256color' }))
  })

  it('refuses an agy that is not Google\'s before writing settings', async () => {
    const h = harness({ files: [windowsCli], overrides: { verifyWindowsCli: async () => { throw new Error('签名发布者不一致') } } })
    await expect(h.service.openCli(windowsWorkspace, resolveKey)).rejects.toThrow('不是谷歌官方签名的原版')
    expect(h.writes).toEqual([])
    expect(h.windowsTerminals).toEqual([])
  })

  it('says agy is missing', async () => {
    const h = harness()
    await expect(h.service.openCli(windowsWorkspace, resolveKey)).rejects.toThrow('未检测到 Antigravity 命令行，请先安装')
  })

  it('checks the folder before queueing', async () => {
    const h = harness({ files: [windowsCli], overrides: { assertWorkspace: () => { throw new Error('项目文件夹不存在，请重新选择') } } })
    await expect(h.service.openCli(windowsWorkspace, resolveKey)).rejects.toThrow('项目文件夹不存在')
    expect(h.queueKeys).toEqual([])
  })

  it('leaves the key out of the Mac launcher, which reads the settings from the login shell', async () => {
    const h = harness({ platform: 'darwin', architecture: 'x64', files: [macCli] })
    await h.service.openCli(macWorkspace, resolveKey)
    expect(h.verifiedCli).toEqual([macCli])
    expect(h.writes).toEqual([writtenEnvironment])
    expect(h.macTerminals).toHaveLength(1)
    expect(h.macTerminals[0]).toEqual(expect.objectContaining({ executable: macCli, argv: [], workspace: macWorkspace }))
    expect(JSON.stringify(h.macTerminals[0].env)).not.toContain(managedKey.key)
  })
})
