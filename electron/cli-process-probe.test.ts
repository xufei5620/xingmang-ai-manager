import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyOperationError } from '../src/renderer-v2/operation-error'
import {
  buildDarwinCliProcessProbeArgv,
  buildWindowsCliProcessProbeScript,
  cliPackageDirectory,
  cliProcessRootEnvironmentVariable,
  describeOccupiedUpdateFailure,
  describeRunningCliProcessWarning,
  fileLockErrorCode,
  isDefiniteFileLockError,
  managedCliPackageDirectory,
  parseDarwinCliProcessProbeOutput,
  parseWindowsCliProcessProbeOutput,
  probeRunningCliProcesses,
  windowsCliProcessProbeModules,
  type CliProcessProbe,
} from './cli-process-probe'
import { buildPowerShellJsonOutputStatements, powerShellUtf8OutputStatement } from './powershell-constrained-language'
import { inspectRunningTools, type RunningToolsReport } from './running-tools'
import { scanPowerShell, unbalancedBracket } from './powershell-script-scan.test-support'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const temporaryDirectories: string[] = []
const spawned: ChildProcess[] = []

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-process-probe-'))
  temporaryDirectories.push(directory)
  return directory
}

afterAll(() => {
  for (const child of spawned) {
    if (child.pid && child.exitCode === null) child.kill('SIGKILL')
  }
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function checkedProbe(processes: number): CliProcessProbe {
  return {
    status: 'checked',
    processes: Array.from({ length: processes }, (_unused, index) => ({
      processId: 1000 + index,
      name: 'claude.exe',
      executablePath: 'C:\\prefix\\node_modules\\@anthropic-ai\\claude-code\\claude.exe',
    })),
  }
}

describe('cli process probe', () => {
  it('keeps the probed directory out of the PowerShell source text', () => {
    const script = buildWindowsCliProcessProbeScript()
    // A path is data the user chose. Splicing it into the script would make
    // PowerShell quoting the only thing standing between a directory name and
    // arbitrary code, so it travels as an environment variable instead (I1).
    expect(script).toContain(`$env:${cliProcessRootEnvironmentVariable}`)
    expect(script).toContain('[System.StringComparison]::OrdinalIgnoreCase')
    // The one -match left is the fixed ASCII check on the JSON this script
    // prints, never on the path.
    const escapeStatement = buildPowerShellJsonOutputStatements('$result | ConvertTo-Json -Compress -Depth 3')[1]
    expect(script).toContain(escapeStatement)
    expect(script.replace(escapeStatement, '')).not.toMatch(/-match|-like/)
    // The command line must stay inside PowerShell: other processes' arguments
    // can carry their own secrets, and nothing needs them over here (I13).
    expect(script).not.toContain('CommandLine = ')
    expect(script).toContain('ConvertTo-Json -Compress')
  })

  it('counts a listing as checked only when the script says it went through', () => {
    expect(parseWindowsCliProcessProbeOutput('{"ok":true,"items":[]}')).toEqual({ status: 'checked', processes: [] })
    expect(parseWindowsCliProcessProbeOutput(JSON.stringify({
      ok: true,
      items: [{ ProcessId: 4321, Name: 'claude.exe', ExecutablePath: 'C:\\p\\claude.exe' }],
    }))).toEqual({
      status: 'checked',
      processes: [{ processId: 4321, name: 'claude.exe', executablePath: 'C:\\p\\claude.exe' }],
    })
    // Windows PowerShell may lead with a byte order mark, and a row may lack the optional fields.
    expect(parseWindowsCliProcessProbeOutput('\uFEFF{"items":[{"ProcessId":7,"Name":null}],"ok":true}'))
      .toEqual({ status: 'checked', processes: [{ processId: 7, name: '', executablePath: '' }] })
  })

  it('answers "cannot tell" for every output that is not a finished listing', () => {
    // Each of these used to come back as "checked, nothing running", which is what lets the
    // startup pass rewrite a CLI's config while it is open (C-1).
    for (const output of [
      '',
      '   \r\n',
      'not json',
      // What the script printed before it said whether the listing ran.
      '[]',
      JSON.stringify([{ ProcessId: 4321, Name: 'claude.exe', ExecutablePath: 'C:\\p\\claude.exe' }]),
      'null',
      '{}',
      '{"ok":"true","items":[]}',
      '{"ok":true}',
      '{"ok":true,"items":{"ProcessId":7}}',
    ]) {
      const probe = parseWindowsCliProcessProbeOutput(output)
      expect(probe.status, output).toBe('unavailable')
      expect(probe.processes, output).toEqual([])
      expect(probe.detail, output).toBeTruthy()
    }
  })

  it('passes on why the listing failed, bounded for the log', () => {
    expect(parseWindowsCliProcessProbeOutput('{"ok":false,"error":"Invalid class \\"Win32_Process\\""}'))
      .toEqual({ status: 'unavailable', processes: [], detail: '进程检测失败：Invalid class "Win32_Process"' })
    expect(parseWindowsCliProcessProbeOutput('{"ok":false}'))
      .toEqual({ status: 'unavailable', processes: [], detail: '进程检测失败' })
    const long = parseWindowsCliProcessProbeOutput(JSON.stringify({ ok: false, error: 'x'.repeat(1000) }))
    expect(long.detail?.length).toBe(200)
  })

  it('refuses the whole answer when a matched row cannot be read, rather than dropping that row', () => {
    // The script prints a row only for a process it matched; skipping one it cannot read would
    // turn a running CLI back into a stopped one.
    for (const row of [
      { ProcessId: 0, Name: 'claude.exe', ExecutablePath: 'C:\\p\\claude.exe' },
      { ProcessId: '4322', Name: 'claude.exe', ExecutablePath: 'C:\\p\\claude.exe' },
      { ProcessId: 12.5, Name: 'claude.exe' },
      { Name: 'claude.exe' },
      null,
      'claude.exe',
    ]) {
      const probe = parseWindowsCliProcessProbeOutput(JSON.stringify({
        ok: true,
        items: [{ ProcessId: 4321, Name: 'claude.exe', ExecutablePath: 'C:\\p\\claude.exe' }, row],
      }))
      expect(probe, JSON.stringify(row)).toMatchObject({ status: 'unavailable', processes: [] })
    }
  })

  it('leaves the tool as "cannot tell" for the caller when the listing failed', async () => {
    // running-tools.ts is where the startup pass and the account switch read the probe: a
    // listing that failed has to land there as unknown, never as stopped.
    const outputs = ['', '{"ok":false,"error":"RPC server is unavailable"}', '{"ok":true,"items":[]}']
    const reports: RunningToolsReport[] = []
    for (const output of outputs) {
      reports.push(await inspectRunningTools(['claude'], {
        probeRoots: async () => ['C:\\prefix\\node_modules\\@anthropic-ai\\claude-code'],
        probe: (root) => probeRunningCliProcesses(root, {
          platform: 'win32',
          resolvePowerShell: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          runProbe: async () => output,
        }),
        codexDesktopRunning: async () => false,
        canRestartCodexDesktop: true,
      }))
    }
    expect(reports.map((report) => ({ running: report.running, unknown: report.unknown }))).toEqual([
      { running: [], unknown: ['claude'] },
      { running: [], unknown: ['claude'] },
      { running: [], unknown: [] },
    ])
  })

  it('only claims the processes that point inside this one package directory', () => {
    const root = '/usr/local/lib/node_modules/@anthropic-ai/claude-code'
    const output = [
      ' 101 /usr/local/lib/node_modules/@anthropic-ai/claude-code/claude --resume',
      ' 102 /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      // A bare node, and another CLI from the same global prefix: neither is ours.
      ' 103 /usr/local/bin/node server.js',
      ' 104 /usr/local/bin/node /usr/local/lib/node_modules/@google/gemini-cli/dist/index.js',
      ' bad line',
      '',
    ].join('\n')
    expect(parseDarwinCliProcessProbeOutput(output, root)).toEqual([
      { processId: 101, name: 'claude', executablePath: `${root}/claude` },
      { processId: 102, name: 'node', executablePath: '' },
    ])
    expect(parseDarwinCliProcessProbeOutput(output, '')).toEqual([])
  })

  it('asks ps only for the current user, and never for another account', () => {
    // Another account's CLI is not ours to talk about, and its command line can
    // carry that person's own secrets.
    expect(buildDarwinCliProcessProbeArgv()).toEqual({ executable: '/bin/ps', argv: ['-xo', 'pid=,args='] })
  })

  it('builds the package directory npm actually installs into, per platform', () => {
    expect(managedCliPackageDirectory('C:\\prefix', '@anthropic-ai/claude-code', 'win32'))
      .toBe(path.join('C:\\prefix', 'node_modules', '@anthropic-ai', 'claude-code'))
    expect(managedCliPackageDirectory('/opt/prefix', '@openai/codex', 'darwin'))
      .toBe(path.join('/opt/prefix', 'lib', 'node_modules', '@openai', 'codex'))
    expect(managedCliPackageDirectory('/home/a/.local/share/XingMangAI/Cli/npm', '@openai/codex', 'linux'))
      .toBe(path.join('/home/a/.local/share/XingMangAI/Cli/npm', 'lib', 'node_modules', '@openai', 'codex'))
    expect(cliPackageDirectory('/root/node_modules', '@google/gemini-cli'))
      .toBe(path.join('/root/node_modules', '@google', 'gemini-cli'))
  })

  it('reads the lock code off a wrapped error as well as a bare one', () => {
    expect(fileLockErrorCode(Object.assign(new Error('rename failed'), { code: 'EBUSY' }))).toBe('EBUSY')
    expect(fileLockErrorCode(new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'EPERM' }) }))).toBe('EPERM')
    expect(fileLockErrorCode('npm 官方源：EBUSY: resource busy or locked')).toBe('EBUSY')
    expect(fileLockErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeNull()
    expect(fileLockErrorCode(null)).toBeNull()
    expect(isDefiniteFileLockError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true)
    expect(isDefiniteFileLockError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(false)
  })

  it('counts the processes it found rather than guessing how many there are', () => {
    const counted = describeOccupiedUpdateFailure({
      toolName: 'Claude Code',
      action: '更新',
      error: Object.assign(new Error('rename'), { code: 'EBUSY' }),
      probe: checkedProbe(2),
      detail: 'EBUSY: resource busy or locked, rename',
    })
    expect(counted).toContain('文件被占用')
    expect(counted).toContain('正在运行（2 个进程）')
    expect(counted).toContain('原始报错：EBUSY: resource busy or locked, rename')

    const uncounted = describeOccupiedUpdateFailure({
      toolName: 'Codex CLI',
      action: '安装',
      error: Object.assign(new Error('rename'), { code: 'EBUSY' }),
      probe: { status: 'unavailable', processes: [], detail: 'timeout' },
    })
    expect(uncounted).toContain('Codex CLI 可能正在运行')
    expect(uncounted).not.toContain('个进程')
  })

  it('leaves EPERM alone until a process is actually found', () => {
    const permissionOnly = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    expect(describeOccupiedUpdateFailure({
      toolName: 'Claude Code',
      action: '更新',
      error: permissionOnly,
      probe: { status: 'checked', processes: [] },
    })).toBeNull()
    expect(describeOccupiedUpdateFailure({
      toolName: 'Claude Code',
      action: '更新',
      error: permissionOnly,
      probe: checkedProbe(1),
    })).toContain('文件被占用')
  })

  it('hands the renderer a sentence it files under the running tool', () => {
    // 这一句是两层之间唯一的接口:主进程写「文件被占用」,渲染层的 toolRunning
    // 认这几个字。改了任何一边,用户就又被送去关杀毒了。
    const message = describeOccupiedUpdateFailure({
      toolName: 'Claude Code',
      action: '更新',
      error: Object.assign(new Error('rename'), { code: 'EPERM' }),
      probe: checkedProbe(1),
      detail: 'EPERM: operation not permitted',
    })
    expect(classifyOperationError(message!)).toBe('toolRunning')
  })

  it('says it was the uninstall that the running tool stopped', () => {
    // 卸载撞上的是同一把锁（npm 先把包目录挪开再删），客户看到的还是同一句，只是
    // 动作说成「卸载」（第三十三批 C）。
    const detail = '命令执行失败（退出码 1）：node.exe（EPERM；Error: EPERM: operation not permitted, rename）'
    const counted = describeOccupiedUpdateFailure({
      toolName: 'Codex CLI',
      action: '卸载',
      error: detail,
      probe: checkedProbe(1),
      detail,
    })
    expect(counted).toBe(
      'Codex CLI 卸载失败：文件被占用，检测到 Codex CLI 正在运行（1 个进程），请关掉它的窗口再试。'
        + `原始报错：${detail}`,
    )
    expect(classifyOperationError(counted!)).toBe('toolRunning')

    const busy = '命令执行失败（退出码 1）：node.exe（EBUSY；Error: EBUSY: resource busy or locked, rename）'
    const uncounted = describeOccupiedUpdateFailure({
      toolName: 'Codex CLI',
      action: '卸载',
      error: busy,
      probe: { status: 'checked', processes: [] },
      detail: busy,
    })
    expect(uncounted).toBe(
      'Codex CLI 卸载失败：文件被占用，Codex CLI 可能正在运行，请关掉正在使用它的窗口再试。'
        + `原始报错：${busy}`,
    )
  })

  it('only warns before the update when it really saw something', () => {
    expect(describeRunningCliProcessWarning('Claude Code', checkedProbe(3))).toContain('3 个进程')
    expect(describeRunningCliProcessWarning('Claude Code', { status: 'checked', processes: [] })).toBeNull()
    expect(describeRunningCliProcessWarning('Claude Code', { status: 'unavailable', processes: [], detail: 'denied' })).toBeNull()
  })

  it('never blocks the update when the probe cannot run', async () => {
    const probe = await probeRunningCliProcesses('/tmp/whatever', {
      platform: 'darwin',
      runProbe: async () => { throw new Error('拒绝访问') },
    })
    expect(probe).toEqual({ status: 'unavailable', processes: [], detail: '拒绝访问' })
    expect(await probeRunningCliProcesses('', { platform: 'darwin' })).toMatchObject({ status: 'unsupported' })
    expect(await probeRunningCliProcesses('/tmp/x', { platform: 'linux' })).toMatchObject({ status: 'unsupported' })
  })

  // `ps` behaves the same here as on macOS for this one question — does a
  // process's argument list point inside our package directory — so the real
  // matching gets exercised rather than only its parser.
  it.runIf(process.platform !== 'win32')('finds a live process under the package directory and no other node', async () => {
    const root = path.join(createTemporaryDirectory(), 'node_modules', '@anthropic-ai', 'claude-code')
    await fs.promises.mkdir(root, { recursive: true })
    const entry = path.join(root, 'cli.js')
    await fs.promises.writeFile(entry, 'setInterval(() => {}, 1000)\n', 'utf8')

    const ours = spawn(process.execPath, [entry], { stdio: 'ignore' })
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    spawned.push(ours, unrelated)
    await new Promise((resolve) => setTimeout(resolve, 500))

    const probe = await probeRunningCliProcesses(root, { platform: 'darwin' })
    expect(probe.status).toBe('checked')
    expect(probe.processes.map((entryFound) => entryFound.processId)).toContain(ours.pid)
    expect(probe.processes.map((entryFound) => entryFound.processId)).not.toContain(unrelated.pid)
  })

  /**
   * Linux lets a directory be renamed with files inside it open, so the failure
   * this whole feature exists for only reproduces on Windows. The assertion is
   * on the classification rather than on the errno: a directory rename over a
   * held file reports ERROR_SHARING_VIOLATION (EBUSY) or ERROR_ACCESS_DENIED
   * (EPERM) depending on how the handle was opened, and the user must land on
   * 「工具正在运行」either way.
   */
  it.runIf(process.platform === 'win32')('classifies a real Windows directory rename over a held file as the tool running', async () => {
    const transaction = createTemporaryDirectory()
    const active = path.join(transaction, 'active')
    await fs.promises.mkdir(active, { recursive: true })
    const held = path.join(active, 'claude.exe')
    await fs.promises.writeFile(held, 'placeholder', 'utf8')
    const handle = await fs.promises.open(held, 'r+')
    try {
      let failure: unknown = null
      try {
        await fs.promises.rename(active, path.join(transaction, 'previous-prefix'))
      } catch (error) {
        failure = error
      }
      expect(failure).not.toBeNull()
      expect(fileLockErrorCode(failure)).not.toBeNull()
      const message = describeOccupiedUpdateFailure({
        toolName: 'Claude Code',
        action: '更新',
        error: failure,
        // The pre-update probe already found the process holding this file;
        // without that, an EPERM stays a permission failure by design.
        probe: checkedProbe(1),
        detail: failure instanceof Error ? failure.message : String(failure),
      })
      expect(message).not.toBeNull()
      expect(classifyOperationError(message!)).toBe('toolRunning')
    } finally {
      await handle.close()
    }
  })

  // This used to hand the script to a real powershell.exe and look for a live node process.
  // On a busy windows-latest runner Get-CimInstance alone outlasted the 60-second probe budget
  // three times (#452, #457 and an earlier run), so the Windows branch is now checked in two
  // halves that need no process: what Node hands PowerShell, and what the script text does
  // with it.
  it('hands PowerShell the resolved package directory through a trusted environment', async () => {
    const root = path.join(os.tmpdir(), 'xingmang-probe', 'node_modules', '@anthropic-ai', 'claude-code')
    const calls: Array<{ executable: string; argv: string[]; options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number } }> = []
    const previousNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--require C:\\Users\\Public\\hook.js'
    let probe: CliProcessProbe
    try {
      probe = await probeRunningCliProcesses(root, {
        platform: 'win32',
        resolvePowerShell: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        runProbe: async (executable, argv, options) => {
          calls.push({ executable, argv, options })
          return JSON.stringify({ ok: true, items: [{ ProcessId: 4321, Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe' }] })
        },
      })
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
    }
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(call.argv).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildWindowsCliProcessProbeScript()])
    expect(call.argv.join(' ')).not.toContain(root)
    expect(call.options.env[cliProcessRootEnvironmentVariable]).toBe(root)
    // The probe reads every process's command line; nothing the parent inherited may load
    // code into it first (I2).
    expect(call.options.env.NODE_OPTIONS).toBeUndefined()
    expect(call.options.timeoutMs).toBe(8_000)
    expect(call.options.maxOutputBytes).toBe(1024 * 1024)
    expect(probe).toEqual({
      status: 'checked',
      processes: [{ processId: 4321, name: 'node.exe', executablePath: 'C:\\Program Files\\nodejs\\node.exe' }],
    })
  })

  it('matches only against the directory it reads from the environment, in both process shapes', () => {
    const scan = scanPowerShell(buildWindowsCliProcessProbeScript())
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
    // No path is ever spliced into the text: the only literals are the module names, the
    // error preference and the fixed lines that keep it working in ConstrainedLanguage.
    expect(scan.literals).toEqual([
      ...scanPowerShell(powerShellUtf8OutputStatement).literals,
      ...windowsCliProcessProbeModules,
      'Stop',
      ...scanPowerShell(buildPowerShellJsonOutputStatements('$result').join('\n')).literals,
    ])
    expect(scan.code).toContain(`$root = [string]$env:${cliProcessRootEnvironmentVariable}`)
    // A native CLI is its own image; a node-hosted one carries its entry script on the command
    // line. Both are ordinal, case-insensitive comparisons against that one directory.
    expect(scan.code).toContain('$image = [string]$_.ExecutablePath')
    expect(scan.code).toContain('$commandLine = [string]$_.CommandLine')
    expect(scan.code).toContain('$image.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)')
    expect(scan.code).toContain('$commandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0')
    expect(scan.code).toContain('Get-CimInstance Win32_Process')
    // What the script emits is exactly what the parser reads back, as a hashtable:
    // ConstrainedLanguage refuses [pscustomobject] and silently dropped every match.
    expect(scan.code).toContain('@{ ProcessId = $_.ProcessId; Name = [string]$_.Name; ExecutablePath = $image }')
    expect(scan.code).not.toMatch(/\[pscustomobject\]/i)
  })

  it('reports a listing that failed or was refused instead of printing an empty one', () => {
    const { code } = scanPowerShell(buildWindowsCliProcessProbeScript())
    // Get-CimInstance only writes an error when WMI is stopped or denied; under the old
    // SilentlyContinue that came back as an empty list with exit code 0 (C-1). Stop turns it,
    // and any line the language mode refuses while matching, into the catch below. The one
    // SilentlyContinue left is the module import, which falls back to autoloading on purpose.
    expect(code).not.toContain('$ErrorActionPreference = "SilentlyContinue"')
    expect(code.match(/SilentlyContinue/g)).toHaveLength(1)
    expect(code).toContain("Import-Module -Name '', '' -ErrorAction SilentlyContinue")
    const order = [
      "$ErrorActionPreference = ''",
      '$result = @{ ok = $false }',
      'if ($root) {',
      'try {',
      '$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {',
      '$result = @{ ok = $true; items = $items }',
      '} catch {',
      '$result = @{ ok = $false; error = [string]$_ }',
      '$xingmangJson = $result | ConvertTo-Json -Compress -Depth 3',
    ].map((line) => code.indexOf(line))
    expect(order.every((position) => position >= 0), JSON.stringify(order)).toBe(true)
    expect([...order].sort((left, right) => left - right)).toEqual(order)
    // Nothing leaves the script early with a bare list any more: the one answer is printed last.
    expect(code).not.toMatch(/\bexit\b/)
    expect(code.trimEnd().endsWith('$xingmangJson')).toBe(true)
  })

  it.runIf(process.platform === 'win32')('asks the system PowerShell resolver when nothing is injected', async () => {
    const executables: string[] = []
    await probeRunningCliProcesses(path.join(os.tmpdir(), 'xingmang-probe'), {
      runProbe: async (executable) => { executables.push(executable); return '{"ok":true,"items":[]}' },
    })
    expect(executables).toEqual([resolveWindowsPowerShellExecutable()])
  })
})
