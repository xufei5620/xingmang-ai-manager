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
  type CliProcessProbe,
} from './cli-process-probe'
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
    expect(script).not.toMatch(/-match|-like/)
    // The command line must stay inside PowerShell: other processes' arguments
    // can carry their own secrets, and nothing needs them over here (I13).
    expect(script).not.toContain('CommandLine = ')
    expect(script).toContain('ConvertTo-Json -Compress')
  })

  it('reads the probe output back, and refuses rows without a usable pid', () => {
    expect(parseWindowsCliProcessProbeOutput('')).toEqual([])
    expect(parseWindowsCliProcessProbeOutput('not json')).toEqual([])
    expect(parseWindowsCliProcessProbeOutput('[]')).toEqual([])
    expect(parseWindowsCliProcessProbeOutput(JSON.stringify([
      { ProcessId: 4321, Name: 'claude.exe', ExecutablePath: 'C:\\p\\claude.exe' },
      { ProcessId: 0, Name: 'claude.exe', ExecutablePath: 'C:\\p\\claude.exe' },
      { ProcessId: '4322', Name: 'claude.exe', ExecutablePath: 'C:\\p\\claude.exe' },
    ]))).toEqual([{ processId: 4321, name: 'claude.exe', executablePath: 'C:\\p\\claude.exe' }])
    // PowerShell unwraps a one-element array into a bare object.
    expect(parseWindowsCliProcessProbeOutput('\uFEFF{"ProcessId":7,"Name":"node.exe","ExecutablePath":""}'))
      .toEqual([{ processId: 7, name: 'node.exe', executablePath: '' }])
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
          return JSON.stringify([{ ProcessId: 4321, Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe' }])
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
    // No path is ever spliced into the text: the only literal is the empty-result JSON.
    expect(scan.literals).toEqual(['[]'])
    expect(scan.code).toContain(`$root = [string]$env:${cliProcessRootEnvironmentVariable}`)
    expect(scan.code).toContain("if (-not $root) { ''; exit 0 }")
    // A native CLI is its own image; a node-hosted one carries its entry script on the command
    // line. Both are ordinal, case-insensitive comparisons against that one directory.
    expect(scan.code).toContain('$image = [string]$_.ExecutablePath')
    expect(scan.code).toContain('$commandLine = [string]$_.CommandLine')
    expect(scan.code).toContain('$image.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)')
    expect(scan.code).toContain('$commandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0')
    expect(scan.code).toContain('Get-CimInstance Win32_Process')
    // What the script emits is exactly what the parser reads back.
    expect(scan.code).toContain('[pscustomobject]@{ ProcessId = $_.ProcessId; Name = [string]$_.Name; ExecutablePath = $image }')
  })

  it.runIf(process.platform === 'win32')('asks the system PowerShell resolver when nothing is injected', async () => {
    const executables: string[] = []
    await probeRunningCliProcesses(path.join(os.tmpdir(), 'xingmang-probe'), {
      runProbe: async (executable) => { executables.push(executable); return '[]' },
    })
    expect(executables).toEqual([resolveWindowsPowerShellExecutable()])
  })
})
