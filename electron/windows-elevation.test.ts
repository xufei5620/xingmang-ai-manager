import { describe, expect, it, vi } from 'vitest'
import {
  assertTrustedElevatedCliCommand,
  buildCliLaunchPlan,
  decodeWindowsPowerShellCommand,
  describeWindowsCliLaunchError,
  encodeWindowsPowerShellCommand,
  inspectCurrentWindowsIntegrityRid,
  inspectCurrentWindowsProcessHighIntegrity,
  inspectWindowsElevationCapability,
  inspectCurrentWindowsTokenElevationType,
  parseWindowsElevationCapability,
  parseWindowsMandatoryLabelRid,
  parseWindowsTokenElevationType,
  parseStartedWindowsProcessId,
  powerShellLiteral,
  classifyWindowsExecutionProbeFailure,
  describeWindowsExecutionProbeFailure,
  resolveWindowsCliExecutionMode,
  resolveWindowsCliExecutionModeDetailed,
  resolveWindowsPowerShellExecutable,
  windowsElevationCancelledMessage,
  windowsElevationDeniedMessage,
  windowsPowerShellCandidates,
  windowsPowerShellExecutable,
  windowsStandardAccountAdvice,
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

  it('keeps the restrictive fallback but reports why the probe failed and how long it took', async () => {
    let clock = 1_000
    const blocked = Object.assign(new Error('Command failed: powershell.exe -Command Add-Type ...'), {
      code: 1,
      stderr: "Add-Type : Cannot add type. Compilation errors occurred.\r\nAt line:2 char:1",
    })
    await expect(resolveWindowsCliExecutionModeDetailed({
      isPackaged: true,
      platform: 'win32',
      now: () => clock,
      probeElevationType: async () => {
        clock += 2_500
        throw blocked
      },
    })).resolves.toEqual({
      mode: 'trusted-only',
      elapsedMs: 2_500,
      probeFailure: {
        reason: 'blocked',
        detail: 'Add-Type : Cannot add type. Compilation errors occurred. At line:2 char:1',
      },
    })

    await expect(resolveWindowsCliExecutionModeDetailed({
      isPackaged: true,
      platform: 'win32',
      probeElevationType: async () => 'limited',
    })).resolves.toMatchObject({ mode: 'same-user' })
    const succeeded = await resolveWindowsCliExecutionModeDetailed({
      isPackaged: true,
      platform: 'win32',
      probeElevationType: async () => 'full',
    })
    expect(succeeded).toMatchObject({ mode: 'trusted-only' })
    expect(succeeded.probeFailure).toBeUndefined()
  })

  it('reads the mandatory label SID from whoami output whatever language the group names are in', () => {
    const medium = [
      '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
      '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
      '"Mandatory Label\\中等强制级别","标签","S-1-16-8192",""',
    ].join('\r\n')
    expect(parseWindowsMandatoryLabelRid(medium)).toBe(8192)
    expect(parseWindowsMandatoryLabelRid('"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""')).toBe(12288)
    // No label, or more than one, is not an answer.
    expect(parseWindowsMandatoryLabelRid('"Everyone","Well-known group","S-1-1-0",""')).toBeNull()
    expect(parseWindowsMandatoryLabelRid('"x","Label","S-1-16-8192",""\r\n"S-1-16-4096","Alias","S-1-5-21-1",""')).toBeNull()
    // Only a whole quoted field counts, not a SID-looking piece of a name.
    expect(parseWindowsMandatoryLabelRid('"Mandatory Label\\S-1-16-8192 lookalike","Label","S-1-16-12288",""')).toBe(12288)
  })

  it('answers same-user from a below-High integrity label without running the slow elevation probe', async () => {
    const probeElevationType = vi.fn(async () => 'full' as const)
    await expect(resolveWindowsCliExecutionModeDetailed({
      isPackaged: true,
      platform: 'win32',
      probeIntegrityRid: async () => 8192,
      probeElevationType,
    })).resolves.toMatchObject({ mode: 'same-user' })
    expect(probeElevationType).not.toHaveBeenCalled()
  })

  it('leaves High integrity and an unreadable label to the elevation probe, including its strict fallback', async () => {
    for (const probeIntegrityRid of [async () => 12288, async () => 16384, async () => null, async () => { throw new Error('whoami failed') }]) {
      await expect(resolveWindowsCliExecutionModeDetailed({
        isPackaged: true, platform: 'win32', probeIntegrityRid, probeElevationType: async () => 'full',
      })).resolves.toMatchObject({ mode: 'trusted-only' })
      // The built-in Administrator with a default token stays same-user, as before.
      await expect(resolveWindowsCliExecutionModeDetailed({
        isPackaged: true, platform: 'win32', probeIntegrityRid, probeElevationType: async () => 'default',
      })).resolves.toMatchObject({ mode: 'same-user' })
      const failed = await resolveWindowsCliExecutionModeDetailed({
        isPackaged: true,
        platform: 'win32',
        probeIntegrityRid,
        probeElevationType: async () => { throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }) },
      })
      expect(failed).toMatchObject({ mode: 'trusted-only', probeFailure: { reason: 'timeout' } })
    }
  })

  it.runIf(process.platform === 'win32')('reads the integrity label of the real process token', async () => {
    const rid = await inspectCurrentWindowsIntegrityRid()
    expect(rid).not.toBeNull()
    expect(rid).toBeGreaterThanOrEqual(4096)
  })

  it('classifies probe failures without reading the echoed command line', () => {
    // execFile's message repeats the whole script, which itself mentions Add-Type.
    const echoOnly = Object.assign(new Error('Command failed: powershell.exe Add-Type TokenElevationType'), { code: 3 })
    expect(classifyWindowsExecutionProbeFailure(echoOnly)).toEqual({ reason: 'failed', detail: 'code=3' })

    const timedOut = Object.assign(new Error('Command failed: powershell.exe Add-Type'), {
      killed: true,
      signal: 'SIGTERM',
      stderr: '',
    })
    expect(classifyWindowsExecutionProbeFailure(timedOut)).toEqual({ reason: 'timeout', detail: 'signal=SIGTERM' })

    const missing = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
    expect(classifyWindowsExecutionProbeFailure(missing).reason).toBe('powershell-unavailable')
    expect(classifyWindowsExecutionProbeFailure(
      new Error('未找到可用的系统 PowerShell；请启用 Windows PowerShell'),
    ).reason).toBe('powershell-unavailable')

    const constrained = Object.assign(new Error('Command failed'), {
      stderr: 'Cannot invoke method. Method invocation is supported only on core types in this language mode.',
    })
    expect(classifyWindowsExecutionProbeFailure(constrained).reason).toBe('blocked')
    expect(classifyWindowsExecutionProbeFailure(Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })).reason)
      .toBe('blocked')

    expect(classifyWindowsExecutionProbeFailure(new Error('无法确认当前 Windows 进程的令牌提升类型')).reason)
      .toBe('unexpected-output')
    expect(classifyWindowsExecutionProbeFailure(Object.assign(new Error('Command failed'), {
      stderr: 'GetTokenInformation(TokenElevationType) failed: 5',
    })).reason).toBe('failed')
    expect(classifyWindowsExecutionProbeFailure('boom')).toEqual({ reason: 'failed', detail: 'boom' })
  })

  it('bounds the logged detail', () => {
    const noisy = Object.assign(new Error('Command failed'), { stderr: 'x'.repeat(5_000) })
    expect(classifyWindowsExecutionProbeFailure(noisy).detail).toHaveLength(300)
  })

  it('describes every failure reason in plain words without technical terms', () => {
    for (const reason of ['timeout', 'powershell-unavailable', 'blocked', 'unexpected-output', 'failed'] as const) {
      const text = describeWindowsExecutionProbeFailure(reason)
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/PowerShell|Add-Type|SID|管理员组|AppData|令牌/)
    }
  })

  it('distinguishes explicit UAC elevation from built-in Administrator default tokens', async () => {
    await expect(resolveWindowsCliExecutionMode({
      isPackaged: true,
      platform: 'win32',
      probeElevationType: async () => 'full',
    })).resolves.toBe('trusted-only')
    await expect(resolveWindowsCliExecutionMode({
      isPackaged: true,
      platform: 'win32',
      probeElevationType: async () => 'limited',
    })).resolves.toBe('same-user')
    await expect(resolveWindowsCliExecutionMode({
      isPackaged: true,
      platform: 'win32',
      probeElevationType: async () => 'default',
    })).resolves.toBe('same-user')

    expect(parseWindowsTokenElevationType(' default\r\n')).toBe('default')
    expect(parseWindowsTokenElevationType('FULL')).toBe('full')
    expect(parseWindowsTokenElevationType('unknown')).toBeNull()
  })

  it.runIf(process.platform === 'win32')('reads the current token elevation type through system PowerShell', async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const value = await inspectCurrentWindowsTokenElevationType({ timeoutMs: 30_000 })
        expect(['default', 'full', 'limited']).toContain(value)
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }, 70_000)

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

  it('switches the visible terminal to UTF-8 before the CLI starts', () => {
    const plan = buildCliLaunchPlan({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\ProgramData\\XingMangAI\\Cli\\node_modules\\tool\\cli.js'],
      workspace: 'C:\\Work',
      title: 'Claude Code',
    }, testPowerShell)

    const brokerScript = decodeWindowsPowerShellCommand(plan.argv.at(-1)!)
    const innerCommand = brokerScript.match(/'-EncodedCommand', '([^']+)'/)?.[1]
    const terminalScript = decodeWindowsPowerShellCommand(innerCommand!)

    expect(terminalScript).toContain('$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')
    expect(terminalScript).toContain('[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)')
    // A console that refuses the code page must not keep the CLI from starting.
    expect(terminalScript).toMatch(/try \{[^}]*\} catch \{ \}/)
    // chcp would be a PATH lookup for a system executable inside a window that
    // can carry an elevated token; the .NET setters already switch the code page.
    expect(terminalScript).not.toMatch(/\bchcp\b/i)
    expect(terminalScript.indexOf('UTF8Encoding')).toBeLessThan(terminalScript.indexOf('Set-Location'))
    expect(terminalScript.indexOf('UTF8Encoding')).toBeLessThan(terminalScript.indexOf('node.exe'))
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

describe('windows elevation capability', () => {
  it('counts a deny-only administrators group, the way a UAC-filtered admin runs', () => {
    // An administrator running unelevated: the group is there, but deny-only.
    const filteredAdmin = [
      '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
      '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
      '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
    ].join('\r\n')
    expect(parseWindowsElevationCapability(filteredAdmin)).toBe('administrator')
    const standard = [
      '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
      '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"',
      '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
    ].join('\r\n')
    expect(parseWindowsElevationCapability(standard)).toBe('standard')
  })

  it('asks for the administrators group by SID, not by its localized name, and refuses to guess', () => {
    const localized = [
      '"BUILTIN\\管理员","别名","S-1-5-32-544","仅用于拒绝的组"',
      '"Mandatory Label\\中等强制级别","标签","S-1-16-8192",""',
    ].join('\r\n')
    expect(parseWindowsElevationCapability(localized)).toBe('administrator')
    // A name that merely mentions the SID is not membership.
    expect(parseWindowsElevationCapability('"x S-1-5-32-544","Alias","S-1-5-32-545",""\r\n"L","Label","S-1-16-8192",""'))
      .toBe('standard')
    // Anything that is not whoami's output is no answer.
    expect(parseWindowsElevationCapability('')).toBe('unknown')
    expect(parseWindowsElevationCapability('administrator')).toBe('unknown')
    expect(parseWindowsElevationCapability('"BUILTIN\\Administrators","Alias","S-1-5-32-544",""')).toBe('unknown')
  })

  it.runIf(process.platform === 'win32')('answers the real account without falling back to unknown', async () => {
    await expect(inspectWindowsElevationCapability()).resolves.toMatch(/^(administrator|standard)$/)
    await expect(inspectCurrentWindowsProcessHighIntegrity()).resolves.toEqual(expect.any(Boolean))
  })

  it('tells a cancelled prompt apart from an account that cannot elevate', () => {
    const cancelled = windowsElevationCancelledMessage('Node.js', 'administrator')
    expect(cancelled).toContain('已取消管理员授权')
    expect(cancelled).toContain('重新点击安装')
    expect(cancelled).not.toContain('不在管理员组')

    const blocked = windowsElevationCancelledMessage('Node.js', 'standard')
    expect(blocked).toContain('已取消管理员授权')
    expect(blocked).toContain(windowsStandardAccountAdvice())
    expect(blocked).not.toContain('重新点击安装')
  })

  it('keeps the old advice when the probe could not answer', () => {
    expect(windowsElevationDeniedMessage('Codex 桌面端')).toContain('点击「是」')
    expect(windowsElevationDeniedMessage('Codex 桌面端', 'standard')).toContain('管理员账号的密码')
  })

  it('never proposes running this app elevated as the fix', () => {
    for (const capability of ['administrator', 'standard', 'unknown'] as const) {
      expect(windowsElevationCancelledMessage('Node.js', capability)).not.toContain('以管理员身份运行')
      expect(windowsElevationDeniedMessage('Node.js', capability)).not.toContain('以管理员身份运行')
    }
  })
})
