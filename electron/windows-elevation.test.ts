import { describe, expect, it, vi } from 'vitest'
import { buildClaudeRetainedVersionFilesCommand } from './claude-native-uninstall'
import { cliExitHintLines } from './cli-exit-hint'
import { buildCodexAppxElevationScript, buildCodexAppxUacBrokerScript } from './codex-desktop-appx'
import {
  buildNodeRuntimeElevatedInstallScript,
  buildNodeRuntimeInstallPlan,
  buildNodeRuntimeUacBrokerScript,
} from './node-runtime'
import {
  assertTrustedElevatedCliCommand,
  buildCliLaunchPlan,
  buildUnelevatedCommandScript,
  buildWindowsCliLaunchOutput,
  buildWindowsTokenElevationProbeScript,
  decodeWindowsPowerShellCommand,
  describeWindowsCliLaunchError,
  encodeWindowsPowerShellCommand,
  escapePowerShellWildcard,
  inspectCurrentWindowsIntegrityRid,
  inspectCurrentWindowsProcessHighIntegrity,
  inspectWindowsElevationCapability,
  inspectCurrentWindowsTokenElevationType,
  parseWindowsElevationCapability,
  parseWindowsMandatoryLabelRid,
  parseWindowsTokenElevationType,
  parseStartedWindowsProcessId,
  parseWindowsCliLaunchCause,
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
import { scanPowerShell, unbalancedBracket } from './powershell-script-scan.test-support'
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

  it('uses the restrictive boundary for confirmed elevated tokens but not for an unanswered probe', async () => {
    await expect(resolveWindowsCliExecutionMode({
      isPackaged: true,
      platform: 'win32',
      probeAdministrator: async () => true,
    })).resolves.toBe('trusted-only')

    // Nothing was learned about the token, so the app is treated as the ordinary
    // user it almost always is (product decision, 2026-09-23).
    await expect(resolveWindowsCliExecutionMode({
      isPackaged: false,
      platform: 'win32',
      probeAdministrator: async () => { throw new Error('probe failed') },
    })).resolves.toBe('same-user')
  })

  it('treats an unanswered probe as an ordinary user and reports why it failed and how long it took', async () => {
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
      mode: 'same-user',
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

  it('leaves High integrity and an unreadable label to the elevation probe', async () => {
    const cases = [
      { probeIntegrityRid: async () => 12288, failedMode: 'trusted-only' },
      { probeIntegrityRid: async () => 16384, failedMode: 'trusted-only' },
      { probeIntegrityRid: async () => null, failedMode: 'same-user' },
      { probeIntegrityRid: async () => { throw new Error('whoami failed') }, failedMode: 'same-user' },
    ] as const
    for (const { probeIntegrityRid, failedMode } of cases) {
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
      // A label already read as High keeps the strict fallback; with nothing
      // known at all the failure answers same-user.
      expect(failed).toMatchObject({ mode: failedMode, probeFailure: { reason: 'timeout' } })
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

  // This used to start the real Windows PowerShell and compile the Add-Type below through csc.exe,
  // twice if the first try failed, and on a busy runner even that kept failing (#511). What it
  // pinned is what the probe hands PowerShell and how the answer is read; both are checked here on
  // every platform without starting a process.
  it('hands system PowerShell the probe through a trusted environment and reads its answer', async () => {
    const calls: Array<{ executable: string; argv: string[]; options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number } }> = []
    const value = await inspectCurrentWindowsTokenElevationType({
      platform: 'win32',
      env: { SystemRoot: 'D:\\Windows', NODE_OPTIONS: '--require C:\\Users\\tester\\evil.js', PATH: 'C:\\Users\\tester\\bin' },
      machinePaths: testMachinePaths,
      resolvePowerShell: () => testPowerShell,
      run: async (executable, argv, options) => {
        calls.push({ executable, argv, options })
        return 'limited\r\n'
      },
    })

    expect(value).toBe('limited')
    expect(calls).toHaveLength(1)
    expect(calls[0].executable).toBe(testPowerShell)
    expect(calls[0].argv).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildWindowsTokenElevationProbeScript()])
    expect(calls[0].options.env.NODE_OPTIONS).toBeUndefined()
    expect(calls[0].options).toMatchObject({ timeoutMs: 15_000, maxOutputBytes: 64 * 1024 })
  })

  it('refuses an answer it cannot read and passes a failed probe through unchanged', async () => {
    const options = { platform: 'win32' as const, env: {}, machinePaths: testMachinePaths, resolvePowerShell: () => testPowerShell }
    await expect(inspectCurrentWindowsTokenElevationType({ ...options, run: async () => 'elevated' }))
      .rejects.toThrow('无法确认当前 Windows 进程的令牌提升类型')
    const refused = new Error('spawn EPERM')
    await expect(inspectCurrentWindowsTokenElevationType({ ...options, run: async () => { throw refused } }))
      .rejects.toBe(refused)
  })

  it('answers default without asking PowerShell anywhere but Windows', async () => {
    const run = vi.fn(async () => 'full')
    await expect(inspectCurrentWindowsTokenElevationType({ platform: 'darwin', run })).resolves.toBe('default')
    expect(run).not.toHaveBeenCalled()
  })

  it('asks for TokenElevationType and maps each of its values onto the parser', () => {
    const script = buildWindowsTokenElevationProbeScript()
    // TOKEN_INFORMATION_CLASS: TokenElevationType is 18, and it answers one 4-byte DWORD.
    expect(script).toContain('GetTokenInformation($identity.Token, 18, [ref]$elevationType, 4, [ref]$returnLength)')
    // TOKEN_ELEVATION_TYPE: 1 Default, 2 Full, 3 Limited; anything else must fail, not guess.
    const mapped = [...script.matchAll(/^ {2}(\d) \{ "(\w+)" \}$/gm)].map(([, value, name]) => [Number(value), parseWindowsTokenElevationType(name)])
    expect(mapped).toEqual([[1, 'default'], [2, 'full'], [3, 'limited']])
    expect(script).toMatch(/default \{ throw "Unexpected TokenElevationType: \$elevationType" \}/)
    expect(script.startsWith("$ErrorActionPreference = 'Stop'")).toBe(true)
  })

  it('leaves PowerShell a probe whose here-string and brackets close', () => {
    const script = buildWindowsTokenElevationProbeScript()
    const lines = script.split('\n')
    // A here-string opens at the end of its line and closes only at the start of one.
    const opener = lines.findIndex((line) => line.endsWith("@'"))
    const closer = lines.findIndex((line) => line === "'@")
    expect(opener).toBeGreaterThanOrEqual(0)
    expect(closer).toBeGreaterThan(opener)
    const typeDefinition = lines.slice(opener + 1, closer).join('\n')
    expect(unbalancedBracket(typeDefinition)).toBeNull()
    expect(typeDefinition).toContain('[DllImport("advapi32.dll", SetLastError = true)]')

    // Outside the here-string the text is ordinary PowerShell, so the #454 scanner applies.
    const outside = [...lines.slice(0, opener), 'Add-Type -TypeDefinition $typeDefinition', ...lines.slice(closer + 1)].join('\n')
    const scan = scanPowerShell(outside)
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
  })

  it.runIf(process.platform === 'win32')('asks the system PowerShell resolver when nothing is injected', async () => {
    const run = vi.fn(async (_executable: string, _argv: string[]) => 'default')
    await expect(inspectCurrentWindowsTokenElevationType({ run })).resolves.toBe('default')
    expect(run.mock.calls[0][0]).toBe(resolveWindowsPowerShellExecutable())
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

  it('switches the hidden launch broker to UTF-8 output before Start-Process can fail', () => {
    const plan = buildCliLaunchPlan({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      workspace: 'C:\\Work',
      title: 'Claude Code',
    }, testPowerShell)
    const brokerScript = decodeWindowsPowerShellCommand(plan.argv.at(-1)!)

    // launchCliPowerShell reads the broker's errors as UTF-8.
    const utf8 = brokerScript.indexOf('$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')
    expect(utf8).toBeGreaterThan(-1)
    expect(utf8).toBeLessThan(brokerScript.indexOf('$ErrorActionPreference = "Stop"'))
    expect(utf8).toBeLessThan(brokerScript.indexOf('Start-Process'))
    // A console that refuses the code page must not keep the terminal from opening.
    expect(brokerScript).toMatch(/^try \{ \$OutputEncoding = [^}]*\} catch \{ \}; /)
    expect(brokerScript).not.toMatch(/\bchcp\b/i)
  })

  it('escapes wildcard characters in the folder for -WorkingDirectory only', () => {
    const workspace = 'D:\\[2024]课程资料\\毕业设计[最终版]\\O\'Brien`s'
    const plan = buildCliLaunchPlan({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\ProgramData\\XingMangAI\\Cli\\node_modules\\tool\\cli.js'],
      workspace,
      title: 'Claude Code',
    }, testPowerShell)
    const brokerScript = decodeWindowsPowerShellCommand(plan.argv.at(-1)!)
    const terminalScript = decodeTerminalScript(brokerScript)

    expect(brokerScript).toContain(
      "-WorkingDirectory 'D:\\`[2024`]课程资料\\毕业设计`[最终版`]\\O''Brien``s' -WindowStyle Normal",
    )
    // The broker's own folder and the terminal's Set-Location take it literally.
    expect(plan.cwd).toBe(workspace)
    expect(terminalScript).toContain("Set-Location -LiteralPath 'D:\\[2024]课程资料\\毕业设计[最终版]\\O''Brien`s'")
    expect(terminalScript).not.toContain('`[')
  })

  it('writes only the cause back when the terminal cannot be started', () => {
    const plan = buildCliLaunchPlan({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      workspace: 'D:\\{草稿} [1]\\O\'Brien',
      title: 'Claude Code',
    }, testPowerShell)
    const brokerScript = decodeWindowsPowerShellCommand(plan.argv.at(-1)!)

    // Left to PowerShell, the failure would come back as CLIXML with the failing line of
    // script attached. The catch writes $_ alone and still exits 1, so the launch fails.
    expect(brokerScript.indexOf('try { $process = Start-Process ')).toBeGreaterThan(brokerScript.indexOf('$ErrorActionPreference = "Stop"'))
    expect(brokerScript.endsWith(
      '; [Console]::Out.WriteLine($process.Id) } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }',
    )).toBe(true)
    const scan = scanPowerShell(brokerScript)
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
  })

  it('tells the user what to do next once the CLI exits, keeping the window open', () => {
    const plan = buildCliLaunchPlan({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      argv: ['C:\\ProgramData\\XingMangAI\\Cli\\node_modules\\tool\\cli.js'],
      workspace: 'C:\\Work',
      title: 'Claude Code',
    }, testPowerShell)

    const brokerScript = decodeWindowsPowerShellCommand(plan.argv.at(-1)!)
    expect(brokerScript).toContain("'-NoExit'")
    const innerCommand = brokerScript.match(/'-EncodedCommand', '([^']+)'/)?.[1]
    const terminalScript = decodeWindowsPowerShellCommand(innerCommand!)

    const launch = terminalScript.indexOf("& 'C:\\Program Files\\nodejs\\node.exe'")
    const exitCheck = terminalScript.indexOf('if ($LASTEXITCODE -eq 0) {')
    const otherwise = terminalScript.indexOf('} else {')
    expect(launch).toBeGreaterThan(-1)
    expect(exitCheck).toBeGreaterThan(launch)
    expect(otherwise).toBeGreaterThan(exitCheck)
    for (const line of cliExitHintLines.normal) {
      const index = terminalScript.indexOf(`Write-Host '${line}' -ForegroundColor Cyan`)
      expect(index).toBeGreaterThan(exitCheck)
      expect(index).toBeLessThan(otherwise)
    }
    for (const line of cliExitHintLines.unexpected) {
      expect(terminalScript.indexOf(`Write-Host '${line}' -ForegroundColor Yellow`)).toBeGreaterThan(otherwise)
    }
    expect(terminalScript.trimEnd().endsWith('}')).toBe(true)
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

  // What execFile hands back when the broker exits 1: the command line, then stderr.
  const brokerCommandLine = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${'JABPAHUAdABwAHUAdAA'.repeat(8)}=`
  function brokerFailure(stderr: string, fields: Record<string, unknown> = { code: 1, killed: false, signal: null }) {
    return Object.assign(new Error(`Command failed: ${brokerCommandLine}\n${stderr}`), { ...fields, cmd: brokerCommandLine, stdout: '', stderr })
  }
  const unrecognizedCause = '此命令由于以下错误而无法运行: 指定的程序不是有效的 Win32 应用程序。'
  // How the host writes errors to a redirected stderr: one <S S="Error"> per line of the error
  // view, and the header on its own as soon as it has anything to report.
  function clixmlDocument(body: string, writtenBeforeTheXml = ''): string {
    return `#< CLIXML\r\n${writtenBeforeTheXml}<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">${body}</Objs>`
  }
  function clixml(lines: readonly string[]): string {
    return clixmlDocument(lines.map((line) => `<S S="Error">${line}_x000D__x000A_</S>`).join(''))
  }
  // What PowerShell reports while it prepares modules, as the host serializes it.
  const progressRecord = '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>'
  const powerShellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  // What execFile hands back when PowerShell cannot be started at all.
  function spawnFailure(code: string) {
    return Object.assign(new Error(`spawn ${powerShellPath} ${code}`), {
      code, syscall: `spawn ${powerShellPath}`, path: powerShellPath, cmd: brokerCommandLine, stdout: '', stderr: '',
    })
  }

  it('shows a failed launch by its cause alone, without the command line', () => {
    const message = describeWindowsCliLaunchError(brokerFailure(`${unrecognizedCause}\r\n`))
    expect(message).toBe(`Windows 无法启动 PowerShell：${unrecognizedCause}`)
    expect(message).not.toContain('Command failed')
    expect(message).not.toContain('EncodedCommand')
  })

  it('still recognizes the cause once it is read from stderr alone', () => {
    expect(describeWindowsCliLaunchError(brokerFailure('此命令由于以下错误而无法运行: 目录名称无效。\r\n')))
      .toBe('工作目录已失效或无法访问，请重新选择工作目录')
    expect(describeWindowsCliLaunchError(brokerFailure('This command cannot be run due to the error: Access is denied.\r\n')))
      .toBe('Windows 拒绝访问 PowerShell 或工作目录，请检查目录权限后重试')
  })

  it('still says why PowerShell could not be started, though execFile attaches an empty stderr', () => {
    expect(describeWindowsCliLaunchError(spawnFailure('ENOENT')))
      .toBe('系统 PowerShell 启动文件不存在或已被移除，请修复 Windows PowerShell 或安装 PowerShell 7')
    expect(describeWindowsCliLaunchError(spawnFailure('EMFILE')))
      .toBe(`Windows 无法启动 PowerShell：spawn ${powerShellPath} EMFILE`)
  })

  it('sends a launch that ended without a cause to the log, not to the command line', () => {
    // The broker ran past its limit and was stopped: nothing on stderr to quote.
    const timedOut = brokerFailure('', { code: null, killed: true, signal: 'SIGTERM' })
    expect(describeWindowsCliLaunchError(timedOut)).toBe('Windows 无法启动 PowerShell，请查看反馈与诊断日志')
    // Raised by launchCliPowerShell itself, the reason is the message.
    expect(describeWindowsCliLaunchError(new Error('PowerShell 启动代理未返回有效的终端进程 ID')))
      .toBe('Windows 无法启动 PowerShell：PowerShell 启动代理未返回有效的终端进程 ID')
  })

  it('unwraps a cause PowerShell reported itself in CLIXML, without the position it adds', () => {
    // Constrained Language Mode refuses the [Console] call in the catch, so the host reports.
    const constrained = clixml([
      '无法调用方法。此语言模式仅支持对核心类型调用方法。',
      '所在位置 行:1 字符: 712',
      "+ ... ', '-EncodedCommand', 'JABPAHUAdABwAHUAdAA=') -WorkingDirectory 'D:\\Work' ...",
      '+                                                                ~~~~~~~~~~~~~~~~~~~~~~~~~',
      '    + CategoryInfo          : InvalidOperation: (:) [], RuntimeException',
      '    + FullyQualifiedErrorId : MethodInvocationNotSupportedInConstrainedLanguage',
      ' ',
    ])
    expect(parseWindowsCliLaunchCause(constrained)).toBe('无法调用方法。此语言模式仅支持对核心类型调用方法。')
    const message = describeWindowsCliLaunchError(brokerFailure(constrained))
    expect(message).toBe('Windows 无法启动 PowerShell：无法调用方法。此语言模式仅支持对核心类型调用方法。')
    expect(message).not.toMatch(/CLIXML|<S|_x000D_|CategoryInfo|所在位置/)

    // As Windows PowerShell 5.1 on the CI runner wrote a failed Start-Process: the cause
    // broken over two lines at the console width, then where it happened.
    const wrapped = clixml([
      'Start-Process : Cannot perform operation because the wildcard path ',
      'D:\\作业[1] did not resolve to a file.',
      'At line:1 char:236',
      "+ ... ; try { $process = Start-Process -FilePath 'C:\\Windows\\System32\\Windo ...",
      '+                  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      '    + CategoryInfo          : OpenError: (D:\\作业[1]:String) [Start-Process], FileNotFoundException',
      '    + FullyQualifiedErrorId : FileOpenFailure,Microsoft.PowerShell.Commands.StartProcessCommand',
      ' ',
    ])
    expect(describeWindowsCliLaunchError(brokerFailure(wrapped)))
      .toBe('Windows 无法启动 PowerShell：Cannot perform operation because the wildcard path D:\\作业[1] did not resolve to a file.')
  })

  it('unwraps the cause of a script PowerShell never ran, which comes after the quote of it', () => {
    const blocked = 'This script contains malicious content and has been blocked by your antivirus software.'
    // Windows PowerShell 5.1: where, the quote, then the cause, wrapped like the category
    // lines, whose spill-over does not start with "+".
    const fromWindowsPowerShell = clixml([
      'At line:1 char:1',
      '+ try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8E ...',
      '+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      'This script contains malicious content and has been blocked by your antivirus',
      'software.',
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordExce',
      '   ption',
      '    + FullyQualifiedErrorId : ScriptContainedMaliciousContent',
      ' ',
    ])
    expect(describeWindowsCliLaunchError(brokerFailure(fromWindowsPowerShell))).toBe(`Windows 无法启动 PowerShell：${blocked}`)
    // PowerShell 7: the reason alone, "Line |", the quote, then "~" and the cause behind a bar.
    const fromPowerShell7 = clixml([
      '_x001B_[31;1mParserError: ',
      '_x001B_[36;1mLine _x001B_[36;1m|',
      '_x001B_[36;1m   1 | _x001B_[0m try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8E ...',
      '_x001B_[36;1m_x001B_[36;1m     | _x001B_[31;1m ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      `_x001B_[36;1m_x001B_[36;1m     | _x001B_[31;1m${blocked}_x001B_[0m`,
    ])
    expect(describeWindowsCliLaunchError(brokerFailure(fromPowerShell7))).toBe(`Windows 无法启动 PowerShell：${blocked}`)
  })

  it.each([
    ['plain text', `${unrecognizedCause}\r\n`, unrecognizedCause],
    ['nothing', ' \r\n', null],
    ['CLIXML with escapes', clixml(['a &lt;b&gt; &amp; &quot;c&quot;_x0009_d _x005F_x0041_ D:\\作业[1]']), 'a <b> & "c"\td _x0041_ D:\\作业[1]'],
    ['CLIXML with a line written in two parts', clixmlDocument(
      '<S S="Error">Start-Process : The directory name </S><S S="Error">is invalid._x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S>',
    ), 'The directory name is invalid.'],
    // As PowerShell 7 on the CI runner wrote it: ConciseView on one line, coloured.
    ['CLIXML from PowerShell 7', clixml([
      '_x001B_[31;1mStart-Process: _x001B_[31;1mCannot perform operation because the wildcard path D:\\作业[1] did not resolve to a file._x001B_[0m',
    ]), 'Cannot perform operation because the wildcard path D:\\作业[1] did not resolve to a file.'],
    ['CLIXML with no error in it', clixmlDocument(''), null],
    // The host held its XML while the catch wrote the cause: the header comes first anyway.
    ['the cause between the CLIXML header and the XML', clixmlDocument(progressRecord, `${unrecognizedCause}\r\n`), unrecognizedCause],
    ['the cause before anything in CLIXML', `${unrecognizedCause}\r\n${clixmlDocument(progressRecord)}`, unrecognizedCause],
    ['CLIXML with progress and an error', clixmlDocument(`${progressRecord}<S S="Error">The directory name is invalid._x000D__x000A_</S>`), 'The directory name is invalid.'],
    ['CLIXML cut short', clixmlDocument(progressRecord).slice(0, 120), null],
  ])('reads the cause from stderr holding %s', (_name, stderr, cause) => {
    expect(parseWindowsCliLaunchCause(stderr)).toBe(cause)
  })

  it('keeps what the broker and Node reported for the log, the encoded script left out', () => {
    const constrained = clixml(["+ ... @('-NoLogo', '-EncodedCommand', 'JABPAHUAdABwAHUAdAA=') -WorkingDirectory ..."])
    const output = buildWindowsCliLaunchOutput(brokerFailure(constrained))
    expect(output).toEqual({
      stderr: expect.stringContaining("'-EncodedCommand', '[REDACTED]')"),
      message: expect.stringContaining('-NonInteractive -EncodedCommand [REDACTED]'),
      code: 1,
      signal: null,
      killed: false,
    })
    expect(JSON.stringify(output)).not.toContain('JABPAHUAdABwAHUAdAA')
    expect(buildWindowsCliLaunchOutput(brokerFailure('', { code: null, killed: true, signal: 'SIGTERM' })))
      .toMatchObject({ stderr: null, code: null, signal: 'SIGTERM', killed: true })
    expect(buildWindowsCliLaunchOutput(new Error('PowerShell 启动代理未返回有效的终端进程 ID'))).toEqual({
      stderr: null, message: 'PowerShell 启动代理未返回有效的终端进程 ID', code: null, signal: null, killed: false,
    })
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

// PowerShell reads U+2018..U+201B as single quotes and U+201C..U+201E as double
// quotes (CharExtensions.IsSingleQuote / IsDoubleQuote in engine/parser/CharTraits.cs).
const powerShellSingleQuotes = ['\'', '\u2018', '\u2019', '\u201a', '\u201b']
const powerShellDoubleQuotes = ['"', '\u201c', '\u201d', '\u201e']
const injectionMarker = 'XINGMANG_TEST_INJECTION'

interface PowerShellQuoteScan {
  /** The script with every string literal replaced by an empty pair of quotes. */
  code: string
  /** Decoded values of the verbatim (single-quoted) literals, in order. */
  literals: string[]
  unterminated: boolean
}

// Follows Tokenizer.ScanStringLiteral / ScanStringExpandable: inside a string a
// quote of the same kind followed by another is one literal copy of the second,
// and a backtick escapes the next character in code and in expandable strings.
// The generated scripts use no comments or here-strings, so neither is modelled.
function scanPowerShellQuotes(script: string): PowerShellQuoteScan {
  const scan: PowerShellQuoteScan = { code: '', literals: [], unterminated: false }
  let index = 0
  while (index < script.length) {
    const char = script[index]
    if (char === '`') {
      scan.code += script.slice(index, index + 2)
      index += 2
      continue
    }
    const quotes = powerShellSingleQuotes.includes(char)
      ? powerShellSingleQuotes
      : powerShellDoubleQuotes.includes(char) ? powerShellDoubleQuotes : null
    if (!quotes) {
      scan.code += char
      index += 1
      continue
    }
    let value = ''
    let closed = false
    index += 1
    while (index < script.length) {
      const next = script[index]
      if (quotes === powerShellDoubleQuotes && next === '`') {
        value += script.slice(index, index + 2)
        index += 2
      } else if (quotes.includes(next) && quotes.includes(script[index + 1] ?? '')) {
        value += script[index + 1]
        index += 2
      } else if (quotes.includes(next)) {
        index += 1
        closed = true
        break
      } else {
        value += next
        index += 1
      }
    }
    if (!closed) scan.unterminated = true
    if (quotes === powerShellSingleQuotes) scan.literals.push(value)
    scan.code += quotes === powerShellSingleQuotes ? "''" : '""'
  }
  return scan
}

/** A legal Windows path that ends its literal early and runs a command if a quote is left unescaped. */
function hostilePath(quote: string, extension: string): string {
  return `C:\\Users\\O${quote}Brien${quote}; Write-Output ${injectionMarker}; ${quote}\\AppData\\Local\\Temp\\x${extension}`
}

function expectQuotedLike(script: string, benignScript: string): PowerShellQuoteScan {
  const scan = scanPowerShellQuotes(script)
  expect(scan.unterminated).toBe(false)
  expect(scan.code).not.toContain(injectionMarker)
  // Only literal contents may differ from the same script built from a harmless path.
  expect(scan.code).toBe(scanPowerShellQuotes(benignScript).code)
  return scan
}

function decodeTerminalScript(brokerScript: string): string {
  const literals = scanPowerShellQuotes(brokerScript).literals
  const encoded = literals[literals.indexOf('-EncodedCommand') + 1]
  expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/)
  return decodeWindowsPowerShellCommand(encoded)
}

describe('PowerShell verbatim literals', () => {
  it.each(powerShellSingleQuotes)('doubles the single quote %j so it stays inside the literal', (quote) => {
    const value = `C:\\Users\\O${quote}Brien`
    const literal = powerShellLiteral(value)
    expect(literal).toBe(`'C:\\Users\\O${quote}${quote}Brien'`)
    expect(scanPowerShellQuotes(`$path = ${literal}`))
      .toEqual({ code: "$path = ''", literals: [value], unterminated: false })
  })

  it('escapes typographic and ASCII quotes mixed in one value, including at both ends', () => {
    const value = '\u2019\'\u2018 it\'s \u201a\u201b\'\' \u2019'
    const literal = powerShellLiteral(value)
    expect(literal).toBe('\'\u2019\u2019\'\'\u2018\u2018 it\'\'s \u201a\u201a\u201b\u201b\'\'\'\' \u2019\u2019\'')
    expect(scanPowerShellQuotes(literal)).toEqual({ code: "''", literals: [value], unterminated: false })
  })

  it('leaves double quotes and backticks alone, since a verbatim literal never expands them', () => {
    expect(powerShellLiteral('\u201c$env:PATH\u201d `n "x"')).toBe('\'\u201c$env:PATH\u201d `n "x"\'')
  })

  it.each(powerShellSingleQuotes)('keeps a hostile path with %j as data in the CLI terminal scripts', (quote) => {
    const workspace = hostilePath(quote, '')
    const request = {
      executable: `${workspace}\\codex.cmd`,
      argv: [`${workspace}\\cli.js`, `--note=${quote}x`],
      workspace,
      title: `Codex CLI ${quote}`,
    }
    const benign = {
      executable: 'C:\\Tools\\codex.cmd',
      argv: ['C:\\Tools\\cli.js', '--note=x'],
      workspace: 'C:\\Work',
      title: 'Codex CLI',
    }
    const broker = decodeWindowsPowerShellCommand(buildCliLaunchPlan(request, testPowerShell).argv.at(-1)!)
    const benignBroker = decodeWindowsPowerShellCommand(buildCliLaunchPlan(benign, testPowerShell).argv.at(-1)!)
    expect(expectQuotedLike(broker, benignBroker).literals).toContain(workspace)
    const terminal = decodeTerminalScript(broker)
    expect(expectQuotedLike(terminal, decodeTerminalScript(benignBroker)).literals)
      .toEqual(expect.arrayContaining([workspace, request.executable, ...request.argv, request.title]))
  })

  it.each(powerShellSingleQuotes)('keeps a hostile MSI path with %j as data in both Node.js UAC scripts', (quote) => {
    function scripts(msiPath: string) {
      const plan = buildNodeRuntimeInstallPlan(msiPath, testPowerShell, false, testMachinePaths, 'a'.repeat(64))
      return {
        broker: buildNodeRuntimeUacBrokerScript(plan.msi, testPowerShell),
        installer: buildNodeRuntimeElevatedInstallScript(plan.msi),
      }
    }
    const msiPath = hostilePath(quote, '.msi')
    const hostile = scripts(msiPath)
    const benign = scripts('C:\\Temp\\node.msi')
    const brokerLiterals = expectQuotedLike(hostile.broker, benign.broker).literals
    expect(brokerLiterals).toContain(msiPath)
    // The elevated script travels inside the broker as one literal and must decode back exactly.
    expect(brokerLiterals).toContain(hostile.installer)
    expect(expectQuotedLike(hostile.installer, benign.installer).literals).toContain(msiPath)
  })

  it.each(powerShellSingleQuotes)('keeps a hostile MSIX path with %j as data in both Codex Desktop UAC scripts', (quote) => {
    const sha256Base64 = Buffer.alloc(32, 1).toString('base64')
    const packagePath = hostilePath(quote, '.msix')
    const benignPath = 'C:\\Temp\\Codex.msix'
    const installer = buildCodexAppxElevationScript(packagePath, sha256Base64)
    const broker = buildCodexAppxUacBrokerScript(testPowerShell, packagePath, sha256Base64)
    const benignBroker = buildCodexAppxUacBrokerScript(testPowerShell, benignPath, sha256Base64)
    expect(expectQuotedLike(broker, benignBroker).literals).toContain(installer)
    expect(expectQuotedLike(installer, buildCodexAppxElevationScript(benignPath, sha256Base64)).literals)
      .toContain(packagePath)
  })

  it.each(powerShellSingleQuotes)('keeps a leftover Claude version path with %j as data in the copyable command', (quote) => {
    const file = hostilePath(quote, '')
    const command = buildClaudeRetainedVersionFilesCommand([file, 'C:\\Other'], 'win32')!
    const benign = buildClaudeRetainedVersionFilesCommand(['C:\\Temp\\2.1.0', 'C:\\Other'], 'win32')!
    expect(expectQuotedLike(command, benign).literals).toEqual([file, 'C:\\Other'])
  })
})

// WildcardPattern.ContainsWildcardCharacters and WildcardPattern.Unescape
// (engine/regex.cs): what the globber does with Start-Process -WorkingDirectory
// before it looks on disk. A value with no wildcard left is unescaped once and
// must then exist exactly as it reads.
const powerShellWildcardCharacters = '*?[]'

function containsPowerShellWildcard(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (powerShellWildcardCharacters.includes(pattern[index])) return true
    if (pattern[index] === '`') index += 1
  }
  return false
}

function unescapePowerShellWildcard(pattern: string): string {
  let result = ''
  let escaping = false
  for (const char of pattern) {
    if (char === '`' && !escaping) {
      escaping = true
      continue
    }
    if (escaping && char !== '`' && !powerShellWildcardCharacters.includes(char)) result += '`'
    result += char
    escaping = false
  }
  return escaping ? `${result}\`` : result
}

describe('PowerShell wildcard escaping', () => {
  it.each([
    ['D:\\作业[1]', 'D:\\作业`[1`]'],
    ['D:\\[2024]课程资料\\作业', 'D:\\`[2024`]课程资料\\作业'],
    ['C:\\a`b', 'C:\\a``b'],
    ['C:\\a`[1]', 'C:\\a```[1`]'],
    ['*?', '`*`?'],
  ])('escapes %j', (value, escaped) => {
    expect(escapePowerShellWildcard(value)).toBe(escaped)
  })

  it.each([
    'C:\\Work & Test\\O\'Brien',
    'D:\\毕业设计【最终版】(1) {x}',
  ])('leaves %j as it is, since nothing in it is a wildcard', (value) => {
    expect(escapePowerShellWildcard(value)).toBe(value)
  })

  it.each([
    'D:\\作业[1]',
    'D:\\作业[12]',
    'D:\\a]b[',
    'C:\\a`b',
    'C:\\a`[1]',
    'C:\\a``[x]``',
    'C:\\trailing`',
    'C:\\x`*`?',
  ])('lets PowerShell read %j back as the same literal folder', (value) => {
    const escaped = escapePowerShellWildcard(value)
    expect(containsPowerShellWildcard(escaped)).toBe(false)
    expect(unescapePowerShellWildcard(escaped)).toBe(value)
  })

  it('reads an unescaped folder as a pattern, which is what kept it from opening', () => {
    expect(containsPowerShellWildcard('D:\\作业[1]')).toBe(true)
    // Escaping only the brackets is not enough once a backtick comes before one.
    expect(containsPowerShellWildcard('C:\\a`[1]'.replace(/[[\]]/g, '`$&'))).toBe(true)
  })
})

describe('unelevated uninstall command window', () => {
  const text = {
    title: '星芒：卸载 Claude Code',
    running: '正在卸载 Claude Code，请稍等，别关这个窗口。',
    succeeded: '卸载完成。现在可以关掉这个窗口，回星芒点「重新检测」。',
    failed: '卸载没有完成（错误代码 {code}）。关掉这个窗口，回星芒点「重新检测」看看；还不行请找客服。',
  }
  const chcp = 'C:\\Windows\\System32\\chcp.com'

  it('switches the window to UTF-8 before any Chinese line is read', () => {
    // 已知33：窗口里的字说中文。cmd 一行一行按当时的代码页读，头两行必须只有 ASCII。
    const script = buildUnelevatedCommandScript('npm.cmd uninstall -g @anthropic-ai/claude-code', text, chcp)
    const lines = script.split('\r\n')
    expect(lines.slice(0, 2)).toEqual(['@echo off', '"C:\\Windows\\System32\\chcp.com" 65001 >nul'])
    expect(lines.slice(0, 2).every((line) => /^[\x20-\x7E]*$/.test(line))).toBe(true)
    expect(lines).toEqual([
      '@echo off',
      '"C:\\Windows\\System32\\chcp.com" 65001 >nul',
      'title 星芒：卸载 Claude Code',
      'echo 正在卸载 Claude Code，请稍等，别关这个窗口。',
      'echo.',
      'call npm.cmd uninstall -g @anthropic-ai/claude-code',
      'echo.',
      'if errorlevel 1 (echo 卸载没有完成（错误代码 %errorlevel%）。关掉这个窗口，回星芒点「重新检测」看看；还不行请找客服。) else (echo 卸载完成。现在可以关掉这个窗口，回星芒点「重新检测」。)',
      'echo.',
      'pause',
      'del "%~f0"',
      '',
    ])
    expect(script).not.toMatch(/Running:|Completed successfully|FAILED with code|refresh the app/)
  })

  it('refuses a command line or a sentence that could become another command', () => {
    expect(() => buildUnelevatedCommandScript('npm.cmd uninstall -g 包', text, chcp)).toThrow('非 ASCII')
    for (const unsafe of ['卸载 & calc', '卸载 | more', '卸载 > out', '卸载 ^', '卸载 %PATH%', '卸载 "x"', '卸载 (x)', '卸载\r\ncalc'])
      expect(() => buildUnelevatedCommandScript('npm.cmd uninstall -g x', { ...text, running: unsafe }, chcp)).toThrow('命令符号')
    expect(() => buildUnelevatedCommandScript('npm.cmd uninstall -g x', { ...text, title: ' ' }, chcp)).toThrow('命令符号')
    expect(() => buildUnelevatedCommandScript('npm.cmd uninstall -g x', text, 'chcp.com')).toThrow('chcp 路径')
    expect(() => buildUnelevatedCommandScript('npm.cmd uninstall -g x', text, 'C:\\系统\\chcp.com')).toThrow('chcp 路径')
  })
})
