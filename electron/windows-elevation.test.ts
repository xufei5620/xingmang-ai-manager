import { describe, expect, it, vi } from 'vitest'
import {
  assertTrustedElevatedCliCommand,
  buildCliLaunchPlan,
  decodeWindowsPowerShellCommand,
  describeWindowsCliLaunchError,
  encodeWindowsPowerShellCommand,
  parseStartedWindowsProcessId,
  powerShellLiteral,
  resolveWindowsCliExecutionMode,
  resolveWindowsPowerShellExecutable,
  windowsPowerShellCandidates,
  windowsPowerShellExecutable,
} from './windows-elevation'
import type { WindowsMachinePaths } from './windows-machine-paths'

const testMachinePaths: WindowsMachinePaths = {
  systemRoot: 'D:\\Windows',
  system32: 'D:\\Windows\\System32',
  programFiles: 'D:\\Program Files',
  programFilesX86: 'D:\\Program Files (x86)',
  programData: 'D:\\ProgramData',
}
const testPowerShell = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

describe('Windows CLI launch', () => {
  it('uses same-user execution for confirmed non-admin packaged and development processes', async () => {
    const nonAdminProbe = vi.fn(async () => false)
    await expect(resolveWindowsCliExecutionMode({
      isPackaged: false,
      platform: 'win32',
      probeAdministrator: nonAdminProbe,
    })).resolves.toBe('same-user')
    expect(nonAdminProbe).toHaveBeenCalledOnce()

    const packagedProbe = vi.fn(async () => false)
    await expect(resolveWindowsCliExecutionMode({
      isPackaged: true,
      platform: 'win32',
      probeAdministrator: packagedProbe,
    })).resolves.toBe('same-user')
    expect(packagedProbe).toHaveBeenCalledOnce()
  })

  it('uses the restrictive boundary only for elevated tokens or probe failures', async () => {
    await expect(resolveWindowsCliExecutionMode({
      isPackaged: true,
      platform: 'win32',
      probeAdministrator: async () => true,
    })).resolves.toBe('trusted-only')

    await expect(resolveWindowsCliExecutionMode({
      isPackaged: false,
      platform: 'win32',
      probeAdministrator: async () => { throw new Error('probe failed') },
    })).resolves.toBe('trusted-only')
  })

  it('round-trips PowerShell scripts through UTF-16LE EncodedCommand', () => {
    const script = `$env:TERM = 'xterm-256color'; Write-Host '星芒AI'`
    expect(decodeWindowsPowerShellCommand(encodeWindowsPowerShellCommand(script))).toBe(script)
  })

  it('escapes PowerShell single-quoted literals', () => {
    expect(powerShellLiteral(`C:\\Users\\O'Brien\\work & more`))
      .toBe(`'C:\\Users\\O''Brien\\work & more'`)
  })

  it('resolves PowerShell from the Windows system root instead of PATH', () => {
    expect(windowsPowerShellExecutable({ SystemRoot: 'E:\\attacker' }, testMachinePaths))
      .toBe(testPowerShell)
  })

  it('never uses a PowerShell executable injected through PATH', () => {
    const candidates = windowsPowerShellCandidates({
      SystemRoot: 'D:\\Windows',
      ProgramFiles: 'D:\\Program Files',
      PATH: 'C:\\Users\\tester\\bin',
    }, 'win32', testMachinePaths)

    expect(candidates).toEqual([
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'D:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'D:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
    ])
    expect(candidates.join(';')).not.toContain('Users\\tester')
    expect(candidates).not.toContain('powershell.exe')
  })

  it('falls back to machine-level PowerShell 7 when Windows PowerShell is missing', () => {
    const resolved = resolveWindowsPowerShellExecutable({
      platform: 'win32',
      env: {
        SystemRoot: 'D:\\Windows',
        ProgramFiles: 'D:\\Program Files',
        PATH: 'C:\\Users\\tester\\bin',
      },
      isFile: (candidate) => candidate.endsWith('\\pwsh.exe'),
      isTrustedPath: () => true,
      machinePaths: testMachinePaths,
    })

    expect(resolved).toBe('D:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('reports an actionable error when no machine-level PowerShell exists', () => {
    expect(() => resolveWindowsPowerShellExecutable({
      platform: 'win32',
      env: { SystemRoot: 'D:\\Windows', ProgramFiles: 'D:\\Program Files' },
      isFile: () => false,
      machinePaths: testMachinePaths,
    })).toThrow('未找到可用的系统 PowerShell')
  })

  it('rejects user-writable or unresolved absolute CLI targets before elevation', () => {
    const command = {
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\tool\\cli.js'],
    }
    expect(() => assertTrustedElevatedCliCommand(command, 'Codex CLI', {
      isUserWritableResolvedPath: (candidate) => candidate.includes('\\Users\\'),
    })).toThrow('CLI 脚本或绝对路径参数位于用户可写目录')
    expect(() => assertTrustedElevatedCliCommand({ executable: 'node.exe', argv: [] }, 'Codex CLI'))
      .toThrow('运行时不是绝对路径')
  })

  it('builds a same-user PowerShell plan without RunAs or raw argv interpolation', () => {
    const request = {
      executable: `C:\\Tools & More\\O'Brien\\codex.cmd`,
      argv: [`C:\\Tools & More\\O'Brien\\cli.js`, '--flag', `value & 'quoted'`],
      workspace: `C:\\Work & Test\\O'Brien`,
      title: `Codex CLI & 'User'`,
    }
    const plan = buildCliLaunchPlan(request, testPowerShell)

    expect(plan).toMatchObject({
      executable: testPowerShell,
      cwd: request.workspace,
      windowsHide: true,
    })
    expect(plan.argv).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      expect.any(String),
    ])
    expect(plan.argv.join(' ')).not.toContain(request.executable)
    expect(plan.argv.join(' ')).not.toContain(request.workspace)
    expect(plan.argv.join(' ')).not.toContain(request.title)

    const brokerScript = decodeWindowsPowerShellCommand(plan.argv.at(-1)!)
    const innerCommand = brokerScript.match(/'-EncodedCommand', '([^']+)'/)?.[1]
    expect(innerCommand).toBeTruthy()
    const terminalScript = decodeWindowsPowerShellCommand(innerCommand!)
    expect(brokerScript).toContain('Start-Process')
    expect(brokerScript).toContain('-WindowStyle Normal')
    expect(brokerScript).toContain('-PassThru')
    expect(brokerScript).not.toContain('-Verb RunAs')
    expect(terminalScript).toContain(`Set-Location -LiteralPath 'C:\\Work & Test\\O''Brien'`)
    expect(terminalScript).toContain(`& 'C:\\Tools & More\\O''Brien\\codex.cmd'`)
    expect(terminalScript).toContain(`'C:\\Tools & More\\O''Brien\\cli.js' '--flag' 'value & ''quoted'''`)
    expect(terminalScript).toContain(`WindowTitle = 'Codex CLI & ''User'''`)
    expect(terminalScript).not.toContain('-Verb RunAs')
    expect(plan.executable.toLowerCase()).not.toBe('powershell.exe')
    expect(`${plan.executable} ${terminalScript}`.toLowerCase()).not.toContain('wt.exe')
  })

  it('uses the resolved absolute PowerShell 7 path directly', () => {
    const powershell = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    const plan = buildCliLaunchPlan({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\ProgramData\\XingMangAI\\Cli\\npm\\node_modules\\tool\\cli.js'],
      workspace: 'C:\\Work & Test',
      title: 'Codex CLI',
    }, powershell)

    expect(plan.executable).toBe(powershell)
    expect(plan.argv.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive'])
  })

  it('accepts only a positive process id from the visible terminal broker', () => {
    expect(parseStartedWindowsProcessId('48364\r\n')).toBe(48364)
    expect(parseStartedWindowsProcessId('\r\n48364\r\n')).toBe(48364)
    expect(parseStartedWindowsProcessId('0\r\n')).toBeNull()
    expect(parseStartedWindowsProcessId('started\r\n')).toBeNull()
  })

  it.each([
    [{ code: 'ENOENT', message: 'spawn failed' }, '系统 PowerShell 启动文件不存在'],
    [{ code: 'EACCES', message: 'spawn failed' }, 'Windows 拒绝访问 PowerShell 或工作目录'],
    [{ message: 'The directory name is invalid' }, '工作目录已失效或无法访问'],
  ])('classifies Windows CLI launch failures', (error, expected) => {
    expect(describeWindowsCliLaunchError(error)).toContain(expected)
  })

  it.each([
    [{ executable: '', workspace: 'C:\\Work', title: 'Codex' }, 'CLI 路径不能为空'],
    [{ executable: 'codex.cmd', workspace: '  ', title: 'Codex' }, '工作目录不能为空'],
    [{ executable: 'codex.cmd', workspace: 'C:\\Work', title: '\0' }, '窗口标题包含无效字符'],
  ])('rejects invalid launch values', (request, message) => {
    expect(() => buildCliLaunchPlan(request, testPowerShell)).toThrow(message)
  })

  it('rejects a bare PowerShell broker path', () => {
    expect(() => buildCliLaunchPlan({
      executable: 'C:\\Tools\\codex.exe',
      workspace: 'C:\\Work',
      title: 'Codex',
    }, 'powershell.exe')).toThrow('系统 PowerShell 路径必须是绝对路径')
  })
})
