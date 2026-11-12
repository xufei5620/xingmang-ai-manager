import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { trustedCommandEnvironment } from './command-runner'
import {
  createProviderLaunchService,
  interactiveTerminalEnvironment,
  withPythonUtf8Output,
  workspaceCarriesClaudeProjectSettings,
} from './provider-launch-service'
import type { DesktopAppStatus, SystemServiceOptions, ToolStatus } from './system-service'
import { createServiceContext } from './system-service-context'
import type { WindowsMachinePaths } from './windows-machine-paths'

// #1070 第 3 步把打开工具那一段搬成了 createProviderLaunchService。真正开终端的各条路仍由 system-service 的测试经
// createSystemService 覆盖；这里钉住搬家新接上的那几处：打开前记下「从星芒打开过」、清掉「需重开生效」（这两份
// 记录现在在上下文里，线路跟随那边读同一份）、打开 Grok 前先修钩子，以及照旧排进安装队列。

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const absent: ToolStatus = { installed: false, version: null, path: null, installDirectory: null }
const desktopMissing: DesktopAppStatus = {
  ...absent,
  appVersion: null,
  mirrorVersion: null,
  mirrorUpdateAvailable: null,
  mirrorError: null,
  running: false,
}

function createService(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-provider-launch-service-'))
  temporaryDirectories.push(root)
  const workspace = path.join(root, 'project')
  fs.mkdirSync(workspace)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'linux',
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    findExecutable: async () => null,
    ...options,
  })
  const inspectCliTool = vi.fn(async () => ({ status: absent, installation: null }))
  const repairGrokHooksBeforeLaunch = vi.fn(async () => undefined)
  const service = createProviderLaunchService(context, {
    providerEnvironment: () => ({}),
    inspectCodexDesktop: async () => desktopMissing,
    launchCodexDesktopOperation: vi.fn(),
    inspectCliTool,
    rememberedWorkspaceFor: () => null,
    repairGrokHooksBeforeLaunch,
  })
  return { context, service, workspace, root, inspectCliTool, repairGrokHooksBeforeLaunch }
}

describe('provider launch service', () => {
  it('refuses a workspace that is gone before touching anything', async () => {
    const { context, service, root, inspectCliTool } = createService()

    await expect(service.launchProvider('claude', path.join(root, 'missing'))).rejects.toThrow('工作目录不存在，请重新选择')
    expect(context.toolLaunchedAt.has('claude')).toBe(false)
    expect(inspectCliTool).not.toHaveBeenCalled()
  })

  it('tells a Mac user to grant folder access instead of calling an existing folder gone (D29)', async () => {
    const { context, service, workspace, inspectCliTool } = createService({ platform: 'darwin' })
    const statSync = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (target === workspace) throw Object.assign(new Error(`EPERM: operation not permitted, stat '${workspace}'`), { code: 'EPERM' })
      return statSync(target, options)
    }) as typeof fs.statSync)

    await expect(service.launchProvider('claude', workspace)).rejects.toThrow('Mac 没允许星芒打开这个文件夹。打开「系统设置 › 隐私与安全性 › 文件和文件夹」，把「星芒AI管理工具」和「终端」两项都打开，再点一次「打开」。')
    expect(context.toolLaunchedAt.has('claude')).toBe(false)
    expect(inspectCliTool).not.toHaveBeenCalled()
  })

  it('records the launch in the shared records and repairs the Grok hooks first', async () => {
    const { context, service, workspace, repairGrokHooksBeforeLaunch } = createService()
    context.toolRouteRestartPending.add('grok')

    await expect(service.launchProvider('grok', workspace)).rejects.toThrow('请先安装')
    expect(context.toolLaunchedAt.has('grok')).toBe(true)
    expect(context.toolRouteRestartPending.has('grok')).toBe(false)
    expect(repairGrokHooksBeforeLaunch).toHaveBeenCalledTimes(1)
  })

  it('does not repair hooks for tools other than Grok', async () => {
    const { service, workspace, repairGrokHooksBeforeLaunch } = createService()

    await expect(service.launchProvider('claude', workspace)).rejects.toThrow('请先安装')
    expect(repairGrokHooksBeforeLaunch).not.toHaveBeenCalled()
  })

  it('opens a tool once when the same launch is asked for twice', async () => {
    const { service, workspace, inspectCliTool } = createService()

    const first = service.launchProvider('codex', workspace)
    const second = service.launchProvider('codex', workspace)

    await expect(first).rejects.toThrow('请先安装')
    await expect(second).rejects.toThrow('请先安装')
    expect(inspectCliTool).toHaveBeenCalledTimes(1)
  })
})

// D4：只有「确实没有」才替客户答信任，看不清的一律交还给 Claude Code 自己问。
describe('telling whether a folder carries Claude Code project settings', () => {
  function folder(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-project-settings-'))
    temporaryDirectories.push(root)
    return root
  }

  function errno(code: string): Error {
    return Object.assign(new Error(`${code}: test`), { code })
  }

  it('finds none in an empty folder or one whose .claude is a plain file', async () => {
    const empty = folder()
    await expect(workspaceCarriesClaudeProjectSettings(empty)).resolves.toBe(false)

    const notADirectory = folder()
    fs.writeFileSync(path.join(notADirectory, '.claude'), 'not a folder')
    await expect(workspaceCarriesClaudeProjectSettings(notADirectory)).resolves.toBe(false)
  })

  it('finds each settings file Claude Code only applies after the trust question', async () => {
    for (const segments of [['.claude', 'settings.json'], ['.claude', 'settings.local.json'], ['.mcp.json']]) {
      const workspace = folder()
      fs.mkdirSync(path.join(workspace, '.claude'))
      fs.writeFileSync(path.join(workspace, ...segments), '{}')
      await expect(workspaceCarriesClaudeProjectSettings(workspace)).resolves.toBe(true)
    }
  })

  it('treats a settings file it cannot look at as present', async () => {
    const lstat = vi.fn(async () => { throw errno('EACCES') })
    await expect(workspaceCarriesClaudeProjectSettings('/work/repo', lstat)).resolves.toBe(true)
    expect(lstat).toHaveBeenCalledTimes(1)
  })

  it('looks at one file at a time and stops at the first one found', async () => {
    const seen: string[] = []
    const lstat = vi.fn(async (file: string) => {
      seen.push(path.relative('/work/repo', file).split(path.sep).join('/'))
      if (file.endsWith('settings.local.json')) return {}
      throw errno('ENOENT')
    })
    await expect(workspaceCarriesClaudeProjectSettings('/work/repo', lstat)).resolves.toBe(true)
    expect(seen).toEqual(['.claude/settings.json', '.claude/settings.local.json'])
  })
})

// D77：中文 Windows 上 Python 接管道输出按 GBK 编码，打印 ✅ 就报错。客户没设过时才补 UTF-8，只管输入输出。
describe('making Python print UTF-8 in a tool window opened on Windows', () => {
  it('asks for UTF-8 standard streams when the customer has set neither variable', () => {
    const env = withPythonUtf8Output({ PATH: 'C:\\Windows\\System32' })

    expect(env.PYTHONIOENCODING).toBe('utf-8')
    // PYTHONUTF8=1 也会改 open() 读文件的默认编码，读 GBK 文件的老脚本会出错，所以不设它。
    expect(Object.keys(env).map((key) => key.toUpperCase())).not.toContain('PYTHONUTF8')
    expect(env.PATH).toBe('C:\\Windows\\System32')
  })

  it('leaves whatever the customer chose alone, whichever variable and letter case it is', () => {
    for (const chosen of [
      { PYTHONIOENCODING: 'gbk' },
      { PythonIOEncoding: 'utf-8:replace' },
      { PYTHONUTF8: '1' },
      // 设成 0 也是客户自己的选择：明说了不要 UTF-8 模式，这里不再从另一头补。
      { pythonutf8: '0' },
    ]) {
      const env = withPythonUtf8Output({ PATH: 'C:\\Windows\\System32', ...chosen })

      expect(env).toEqual({ PATH: 'C:\\Windows\\System32', ...chosen })
    }
  })

  it('treats an empty value as unset, as Python does, and hands over a single spelling', () => {
    const env = withPythonUtf8Output({ pythonioencoding: '', PYTHONUTF8: '' })

    expect(env).toEqual({ PYTHONIOENCODING: 'utf-8' })
  })

  it('does not change the environment it was given', () => {
    const base = { PATH: 'C:\\Windows\\System32' }

    withPythonUtf8Output(base)

    expect(base).toEqual({ PATH: 'C:\\Windows\\System32' })
  })

  // T4：管理员身份打开时基底是 trustedCommandEnvironment。这一层只加一个写死的值，被基底去掉的
  // Python 注入变量不会回来，基底补的那两项保护照旧在。
  it('only adds a fixed value on top of the elevated base and brings back nothing it removed', () => {
    const machinePaths: WindowsMachinePaths = {
      systemRoot: 'D:\\Windows',
      system32: 'D:\\Windows\\System32',
      programFiles: 'D:\\Program Files',
      programFilesX86: 'D:\\Program Files (x86)',
      programData: 'D:\\ProgramData',
    }
    const inherited = {
      PATH: ['C:\\Users\\tester\\AppData\\Roaming\\npm', 'D:\\Windows\\System32'].join(';'),
      PYTHONPATH: 'C:\\Users\\tester\\payload',
      PYTHONSTARTUP: 'C:\\Users\\tester\\startup.py',
      PYTHONHOME: 'C:\\Users\\tester\\python',
    }
    const elevated = interactiveTerminalEnvironment(inherited, (env) => trustedCommandEnvironment(env, machinePaths))

    const env = withPythonUtf8Output(elevated)

    expect(env).toEqual({ ...elevated, PYTHONIOENCODING: 'utf-8' })
    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.PYTHONSTARTUP).toBeUndefined()
    expect(env.PYTHONHOME).toBeUndefined()
    expect(env).toMatchObject({ PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1' })
  })
})
