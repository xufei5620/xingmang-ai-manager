import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCliTerminalAccessPlan,
  buildEnsureUserPathScript,
  createCliTerminalAccess,
  ensureDirectoryOnWindowsUserPath,
  isNpmPowerShellShim,
  parseEnsureUserPathOutput,
  pathListIncludesDirectory,
  removeNpmPowerShellShim,
} from './windows-cli-shell-access'

// Verbatim output of npm's cmd-shim 7.0.0 for a JS bin with a node shebang.
const codexShim = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  '  # Fix case when both the Windows and Linux builds of Node',
  '  # are installed in the same directory',
  '  $exe=".exe"',
  '}',
  '$ret=0',
  'if (Test-Path "$basedir/node$exe") {',
  '  # Support pipeline input',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
  '  } else {',
  '    & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '} else {',
  '  # Support pipeline input',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
  '  } else {',
  '    & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '}',
  'exit $ret',
  '',
].join('\n')

// Same generator for a native bin (Claude Code ships bin/claude.exe).
const claudeShim = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  '  # Fix case when both the Windows and Linux builds of Node',
  '  # are installed in the same directory',
  '  $exe=".exe"',
  '}',
  '# Support pipeline input',
  'if ($MyInvocation.ExpectingInput) {',
  '  $input | & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args',
  '} else {',
  '  & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args',
  '}',
  'exit $LASTEXITCODE',
  '',
].join('\n')

const temporaryDirectories: string[] = []

function binDirectory(): string {
  // macOS puts the temp directory behind /var -> /private/var, which the
  // reparse-point guard would (rightly) refuse.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ps1-shim-')))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('isNpmPowerShellShim', () => {
  it('recognises the shims npm writes for a JS bin and for a native bin', () => {
    expect(isNpmPowerShellShim(codexShim, '@openai/codex')).toBe(true)
    expect(isNpmPowerShellShim(claudeShim, '@anthropic-ai/claude-code')).toBe(true)
  })

  it('recognises a shim that was saved with CRLF line endings', () => {
    expect(isNpmPowerShellShim(codexShim.replace(/\n/g, '\r\n'), '@openai/codex')).toBe(true)
  })

  it('rejects a shim that points into another package with the same command name', () => {
    expect(isNpmPowerShellShim(codexShim, '@anthropic-ai/claude-code')).toBe(false)
    expect(isNpmPowerShellShim(codexShim, '@openai/codex-other')).toBe(false)
  })

  it('rejects a script the user wrote by hand', () => {
    expect(isNpmPowerShellShim('& "C:\\tools\\claude.exe" $args\n', '@anthropic-ai/claude-code')).toBe(false)
    expect(isNpmPowerShellShim(`# my wrapper\n${claudeShim}`, '@anthropic-ai/claude-code')).toBe(false)
  })
})

describe('removeNpmPowerShellShim', () => {
  it('removes the npm .ps1 and keeps the .cmd PowerShell falls back to', async () => {
    const directory = binDirectory()
    fs.writeFileSync(path.join(directory, 'claude.ps1'), claudeShim)
    fs.writeFileSync(path.join(directory, 'claude.cmd'), '@ECHO off\r\n')

    await expect(removeNpmPowerShellShim({
      binDirectory: directory,
      command: 'claude',
      packageName: '@anthropic-ai/claude-code',
    })).resolves.toBe('removed')

    expect(fs.existsSync(path.join(directory, 'claude.ps1'))).toBe(false)
    expect(fs.existsSync(path.join(directory, 'claude.cmd'))).toBe(true)
  })

  it('reports absent when there is no .ps1 to remove', async () => {
    const directory = binDirectory()
    fs.writeFileSync(path.join(directory, 'codex.cmd'), '@ECHO off\r\n')

    await expect(removeNpmPowerShellShim({
      binDirectory: directory,
      command: 'codex',
      packageName: '@openai/codex',
    })).resolves.toBe('absent')
  })

  it('keeps the .ps1 when no .cmd sits next to it', async () => {
    const directory = binDirectory()
    fs.writeFileSync(path.join(directory, 'codex.ps1'), codexShim)

    await expect(removeNpmPowerShellShim({
      binDirectory: directory,
      command: 'codex',
      packageName: '@openai/codex',
    })).resolves.toBe('kept')
    expect(fs.existsSync(path.join(directory, 'codex.ps1'))).toBe(true)
  })

  it('keeps a .ps1 that is not the npm shim for this package', async () => {
    const directory = binDirectory()
    fs.writeFileSync(path.join(directory, 'codex.ps1'), '& "D:\\my\\codex.exe" $args\n')
    fs.writeFileSync(path.join(directory, 'codex.cmd'), '@ECHO off\r\n')

    await expect(removeNpmPowerShellShim({
      binDirectory: directory,
      command: 'codex',
      packageName: '@openai/codex',
    })).resolves.toBe('kept')
    expect(fs.readFileSync(path.join(directory, 'codex.ps1'), 'utf8')).toContain('D:\\my\\codex.exe')
  })

  it('keeps a .ps1 that has a second hard link', async () => {
    const directory = binDirectory()
    const elsewhere = path.join(directory, 'elsewhere.ps1')
    fs.writeFileSync(elsewhere, codexShim)
    fs.linkSync(elsewhere, path.join(directory, 'codex.ps1'))
    fs.writeFileSync(path.join(directory, 'codex.cmd'), '@ECHO off\r\n')

    await expect(removeNpmPowerShellShim({
      binDirectory: directory,
      command: 'codex',
      packageName: '@openai/codex',
    })).resolves.toBe('kept')
    expect(fs.existsSync(path.join(directory, 'codex.ps1'))).toBe(true)
  })

  // Creating symlinks needs Developer Mode or elevation on Windows (#40).
  it.skipIf(process.platform === 'win32')('keeps a .ps1 that is a symbolic link', async () => {
    const directory = binDirectory()
    const target = path.join(directory, 'target.ps1')
    fs.writeFileSync(target, codexShim)
    fs.symlinkSync(target, path.join(directory, 'codex.ps1'))
    fs.writeFileSync(path.join(directory, 'codex.cmd'), '@ECHO off\r\n')

    await expect(removeNpmPowerShellShim({
      binDirectory: directory,
      command: 'codex',
      packageName: '@openai/codex',
    })).resolves.toBe('kept')
    expect(fs.existsSync(target)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('refuses a bin directory reached through a symbolic link', async () => {
    const real = binDirectory()
    fs.writeFileSync(path.join(real, 'codex.ps1'), codexShim)
    fs.writeFileSync(path.join(real, 'codex.cmd'), '@ECHO off\r\n')
    const link = path.join(binDirectory(), 'redirected')
    fs.symlinkSync(real, link)

    await expect(removeNpmPowerShellShim({
      binDirectory: link,
      command: 'codex',
      packageName: '@openai/codex',
    })).rejects.toThrow('命令行启动文件不能经过符号链接或目录联接')
    expect(fs.existsSync(path.join(real, 'codex.ps1'))).toBe(true)
  })
})

describe('pathListIncludesDirectory', () => {
  it('matches entries case-insensitively and ignores a trailing separator or quotes', () => {
    const pathValue = 'C:\\Windows\\system32;"C:\\Users\\Ann\\AppData\\Roaming\\npm\\";C:\\Program Files\\nodejs\\'
    expect(pathListIncludesDirectory(pathValue, 'c:\\users\\ann\\appdata\\roaming\\npm')).toBe(true)
    expect(pathListIncludesDirectory(pathValue, 'C:\\Program Files\\nodejs')).toBe(true)
  })

  it('does not treat a parent or sibling directory as a match', () => {
    const pathValue = 'C:\\Users\\Ann\\AppData\\Roaming;C:\\Users\\Ann\\AppData\\Roaming\\npm-cache'
    expect(pathListIncludesDirectory(pathValue, 'C:\\Users\\Ann\\AppData\\Roaming\\npm')).toBe(false)
  })

  it('is false for a missing or empty PATH', () => {
    expect(pathListIncludesDirectory(undefined, 'C:\\npm')).toBe(false)
    expect(pathListIncludesDirectory(';;', 'C:\\npm')).toBe(false)
  })
})

describe('buildEnsureUserPathScript', () => {
  const script = buildEnsureUserPathScript()

  it('reads the raw user PATH so %VAR% entries are written back unexpanded', () => {
    expect(script).toContain('DoNotExpandEnvironmentNames')
    expect(script).toContain('$key.SetValue("Path", $next, $kind)')
    // SetEnvironmentVariable("Path", ...) would store the expanded text as REG_SZ.
    expect(script).not.toContain('SetEnvironmentVariable("Path"')
  })

  it('takes the directory from the environment instead of splicing it into the script', () => {
    expect(script).toContain('$env:XINGMANG_ADD_PATH')
  })

  it('never touches the machine PATH or the execution policy', () => {
    expect(script).not.toContain('LocalMachine')
    expect(script).not.toMatch(/SetEnvironmentVariable\([^)]*"Machine"/)
    expect(script).not.toMatch(/ExecutionPolicy/i)
    expect(script).toContain('[Microsoft.Win32.Registry]::CurrentUser')
  })
})

describe('parseEnsureUserPathOutput', () => {
  it('takes the last non-empty line', () => {
    expect(parseEnsureUserPathOutput('added\r\n')).toBe('added')
    expect(parseEnsureUserPathOutput('\r\npresent\r\n\r\n')).toBe('present')
  })

  it('throws on anything else', () => {
    expect(() => parseEnsureUserPathOutput('')).toThrow('无法确认')
    expect(() => parseEnsureUserPathOutput('Access is denied.')).toThrow('无法确认')
  })
})

describe('ensureDirectoryOnWindowsUserPath', () => {
  it('starts no PowerShell when the inherited PATH already lists the directory', async () => {
    const runPowerShell = vi.fn(async () => 'added')

    await expect(ensureDirectoryOnWindowsUserPath('C:\\Users\\Ann\\AppData\\Roaming\\npm', {
      inheritedPath: 'C:\\Windows;C:\\Users\\Ann\\AppData\\Roaming\\npm',
      runPowerShell,
    })).resolves.toBe('present')
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('hands the directory to PowerShell through the environment', async () => {
    const runPowerShell = vi.fn(async (_script: string, _env: NodeJS.ProcessEnv) => 'added\r\n')

    await expect(ensureDirectoryOnWindowsUserPath('C:\\ProgramData\\XingMangAI\\Cli\\npm', {
      inheritedPath: 'C:\\Windows',
      runPowerShell,
    })).resolves.toBe('added')
    expect(runPowerShell).toHaveBeenCalledTimes(1)
    const [script, env] = runPowerShell.mock.calls[0]
    expect(script).toBe(buildEnsureUserPathScript())
    expect(env.XINGMANG_ADD_PATH).toBe('C:\\ProgramData\\XingMangAI\\Cli\\npm')
  })

  it('rejects a directory that would split into several PATH entries', async () => {
    const runPowerShell = vi.fn(async () => 'added')

    await expect(ensureDirectoryOnWindowsUserPath('C:\\npm;C:\\evil', { inheritedPath: '', runPowerShell }))
      .rejects.toThrow('命令行工具目录无效')
    await expect(ensureDirectoryOnWindowsUserPath('npm', { inheritedPath: '', runPowerShell }))
      .rejects.toThrow('命令行工具目录无效')
    expect(runPowerShell).not.toHaveBeenCalled()
  })
})

describe('buildCliTerminalAccessPlan', () => {
  const base = {
    platform: 'win32' as const,
    executionMode: 'same-user' as const,
    source: 'npm' as const,
    npmPrefix: 'C:\\Users\\Ann\\AppData\\Roaming\\npm',
    managed: false,
    reason: 'install' as const,
  }

  it('cleans the shim and checks PATH right after a same-user npm install', () => {
    expect(buildCliTerminalAccessPlan(base)).toEqual({ binDirectory: base.npmPrefix, ensureUserPath: true })
  })

  it('only cleans the shim at startup, without starting PowerShell for PATH', () => {
    expect(buildCliTerminalAccessPlan({ ...base, reason: 'startup' }))
      .toEqual({ binDirectory: base.npmPrefix, ensureUserPath: false })
  })

  it('leaves user-writable directories alone under an elevated token', () => {
    expect(buildCliTerminalAccessPlan({ ...base, executionMode: 'trusted-only' }).binDirectory).toBeNull()
    expect(buildCliTerminalAccessPlan({
      ...base,
      executionMode: 'trusted-only',
      managed: true,
      npmPrefix: 'C:\\ProgramData\\XingMangAI\\Cli\\npm',
    })).toEqual({ binDirectory: 'C:\\ProgramData\\XingMangAI\\Cli\\npm', ensureUserPath: true })
  })

  it('does nothing for native installs, installs without a prefix, or other platforms', () => {
    expect(buildCliTerminalAccessPlan({ ...base, source: 'native' }).binDirectory).toBeNull()
    expect(buildCliTerminalAccessPlan({ ...base, npmPrefix: null }).binDirectory).toBeNull()
    expect(buildCliTerminalAccessPlan({ ...base, platform: 'darwin' }).binDirectory).toBeNull()
  })
})

// Runs on every platform, real Windows included: the Windows behaviour here is
// plain file removal, so only the platform the service reports is faked.
describe('createCliTerminalAccess', () => {
  function npmPrefixWithShims(...commands: Array<'claude' | 'codex'>): string {
    const prefix = binDirectory()
    for (const command of commands) {
      fs.writeFileSync(path.join(prefix, `${command}.cmd`), '@ECHO off\r\n')
      fs.writeFileSync(path.join(prefix, `${command}.ps1`), command === 'claude' ? claudeShim : codexShim)
    }
    return prefix
  }

  function npmInstall(prefix: string) {
    return { source: 'npm' as const, npmPrefix: prefix }
  }

  it('sweeps the shims of detected installs once, without touching PATH', async () => {
    const prefix = npmPrefixWithShims('claude', 'codex')
    const ensureUserPath = vi.fn(async () => 'added' as const)
    const access = createCliTerminalAccess({
      platform: 'win32',
      executionMode: 'same-user',
      isManaged: () => false,
      ensureUserPath,
    })
    const targets = [
      { provider: 'claude' as const, installation: npmInstall(prefix) },
      { provider: 'codex' as const, installation: npmInstall(prefix) },
    ]

    await access.sweepOnce(targets)

    expect(fs.existsSync(path.join(prefix, 'claude.ps1'))).toBe(false)
    expect(fs.existsSync(path.join(prefix, 'codex.ps1'))).toBe(false)
    expect(fs.existsSync(path.join(prefix, 'claude.cmd'))).toBe(true)
    expect(ensureUserPath).not.toHaveBeenCalled()

    // Only the first scan of a session sweeps.
    fs.writeFileSync(path.join(prefix, 'claude.ps1'), claudeShim)
    await access.sweepOnce(targets)
    expect(fs.existsSync(path.join(prefix, 'claude.ps1'))).toBe(true)
  })

  it('removes the shim after an install and checks PATH once per directory', async () => {
    const prefix = npmPrefixWithShims('claude', 'codex')
    const ensureUserPath = vi.fn(async () => 'added' as const)
    const access = createCliTerminalAccess({
      platform: 'win32',
      executionMode: 'same-user',
      isManaged: () => false,
      ensureUserPath,
    })

    await access.prepare({ provider: 'claude', installation: npmInstall(prefix) }, 'install')
    await access.prepare({ provider: 'codex', installation: npmInstall(prefix) }, 'install')

    expect(fs.existsSync(path.join(prefix, 'claude.ps1'))).toBe(false)
    expect(fs.existsSync(path.join(prefix, 'codex.ps1'))).toBe(false)
    expect(ensureUserPath).toHaveBeenCalledTimes(1)
    expect(ensureUserPath).toHaveBeenCalledWith(prefix)
  })

  it('tries PATH again on the next install after a failure and logs the failure', async () => {
    const prefix = npmPrefixWithShims('claude')
    const ensureUserPath = vi.fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce('present')
    const log = vi.fn()
    const access = createCliTerminalAccess({
      platform: 'win32',
      executionMode: 'same-user',
      isManaged: () => false,
      ensureUserPath,
      log,
    })

    await access.prepare({ provider: 'claude', installation: npmInstall(prefix) }, 'install')
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('warn', 'cli.user-path.failed', expect.any(String), expect.objectContaining({ error: 'timed out' })))
    await access.prepare({ provider: 'claude', installation: npmInstall(prefix) }, 'install')

    expect(ensureUserPath).toHaveBeenCalledTimes(2)
  })

  it('logs a shim it cannot read instead of failing the install', async () => {
    const prefix = binDirectory()
    fs.writeFileSync(path.join(prefix, 'claude.cmd'), '@ECHO off\r\n')
    fs.writeFileSync(path.join(prefix, 'claude.ps1'), `${claudeShim}${'#'.repeat(70 * 1024)}`)
    const log = vi.fn()
    const access = createCliTerminalAccess({
      platform: 'win32',
      executionMode: 'same-user',
      isManaged: () => false,
      log,
    })

    await expect(access.prepare({ provider: 'claude', installation: npmInstall(prefix) }, 'install')).resolves.toBeUndefined()

    expect(fs.existsSync(path.join(prefix, 'claude.ps1'))).toBe(true)
    expect(log).toHaveBeenCalledWith('warn', 'cli.powershell-shim.failed', expect.any(String), expect.objectContaining({ provider: 'claude' }))
  })

  it('under an elevated token only touches the managed prefix', async () => {
    const userPrefix = npmPrefixWithShims('claude')
    const managedPrefix = npmPrefixWithShims('claude')
    const access = createCliTerminalAccess({
      platform: 'win32',
      executionMode: 'trusted-only',
      isManaged: (installation) => installation.npmPrefix === managedPrefix,
    })

    await access.prepare({ provider: 'claude', installation: npmInstall(userPrefix) }, 'install')
    await access.prepare({ provider: 'claude', installation: npmInstall(managedPrefix) }, 'install')

    expect(fs.existsSync(path.join(userPrefix, 'claude.ps1'))).toBe(true)
    expect(fs.existsSync(path.join(managedPrefix, 'claude.ps1'))).toBe(false)
  })

  it('leaves the files alone when the managed check itself fails', async () => {
    const prefix = npmPrefixWithShims('claude')
    const access = createCliTerminalAccess({
      platform: 'win32',
      executionMode: 'trusted-only',
      isManaged: () => { throw new Error('未找到可信的 Windows ProgramData 目录') },
    })

    await access.prepare({ provider: 'claude', installation: npmInstall(prefix) }, 'install')

    expect(fs.existsSync(path.join(prefix, 'claude.ps1'))).toBe(true)
  })

  it('touches no shim or PATH on macOS and checks the shell profile once per session instead', async () => {
    const prefix = npmPrefixWithShims('claude')
    const ensureUserPath = vi.fn(async () => 'added' as const)
    const ensureShellProfile = vi.fn(async () => 'added')
    const access = createCliTerminalAccess({
      platform: 'darwin',
      executionMode: 'same-user',
      isManaged: () => false,
      ensureUserPath,
      ensureShellProfile,
    })

    await access.sweepOnce([{ provider: 'claude', installation: npmInstall(prefix) }])
    expect(ensureShellProfile).not.toHaveBeenCalled()

    await access.prepare({ provider: 'claude', installation: npmInstall(prefix) }, 'install')
    await access.prepare({ provider: 'codex', installation: npmInstall(prefix) }, 'install')

    expect(fs.existsSync(path.join(prefix, 'claude.ps1'))).toBe(true)
    expect(ensureUserPath).not.toHaveBeenCalled()
    expect(ensureShellProfile).toHaveBeenCalledTimes(1)
    expect(ensureShellProfile).toHaveBeenCalledWith('install')
  })

  it('on macOS checks the shell profile at startup only for an install the app made', async () => {
    const prefix = binDirectory()
    const ensureShellProfile = vi.fn(async () => 'present')
    const access = createCliTerminalAccess({
      platform: 'darwin',
      executionMode: 'same-user',
      isManaged: (installation) => installation.npmPrefix === prefix,
      ensureShellProfile,
    })

    await access.sweepOnce([
      { provider: 'claude', installation: npmInstall('/opt/homebrew') },
      { provider: 'codex', installation: npmInstall(prefix) },
    ])

    expect(ensureShellProfile).toHaveBeenCalledTimes(1)
    expect(ensureShellProfile).toHaveBeenCalledWith('startup')
  })

  it('on macOS tries the shell profile again on the next install after a failure', async () => {
    const ensureShellProfile = vi.fn()
      .mockRejectedValueOnce(new Error('终端启动设置必须是单链接普通文件'))
      .mockResolvedValueOnce('added')
    const log = vi.fn()
    const access = createCliTerminalAccess({
      platform: 'darwin',
      executionMode: 'same-user',
      isManaged: () => true,
      ensureShellProfile,
      log,
    })
    const target = { provider: 'claude' as const, installation: npmInstall('/Users/ann/Library/Application Support/XingMangAI/Cli/npm') }

    await expect(access.prepare(target, 'install')).resolves.toBeUndefined()
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('warn', 'cli.shell-profile.failed', expect.any(String), expect.objectContaining({ error: '终端启动设置必须是单链接普通文件' })))
    await access.prepare(target, 'install')

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('info', 'cli.shell-profile.checked', expect.any(String), expect.objectContaining({ outcome: 'added' })))
    expect(ensureShellProfile).toHaveBeenCalledTimes(2)
  })

  it('on macOS says in the log that a login shell it does not handle was left alone', async () => {
    const cases = [
      ['added', '已让新开的终端可以直接敲工具名'],
      ['present', '终端启动设置无需改动'],
      ['already-handled', '终端启动设置无需改动'],
      ['unsupported-shell', '登录 shell 不是 zsh、bash、fish，没改终端启动设置'],
    ] as const
    for (const [outcome, message] of cases) {
      const log = vi.fn()
      const access = createCliTerminalAccess({
        platform: 'darwin',
        executionMode: 'same-user',
        isManaged: () => true,
        ensureShellProfile: async () => outcome,
        log,
      })

      await access.prepare({ provider: 'claude', installation: npmInstall('/Users/ann/Library/Application Support/XingMangAI/Cli/npm') }, 'install')

      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('info', 'cli.shell-profile.checked', message, { provider: 'claude', reason: 'install', outcome }))
    }
  })

  it('does nothing on release outside Linux', async () => {
    const ensureShellProfile = vi.fn(async () => 'added')
    const syncTerminalCommands = vi.fn(async () => ({ outcome: 'removed', skipped: [] }))
    for (const platform of ['win32', 'darwin'] as const) {
      const access = createCliTerminalAccess({ platform, executionMode: 'same-user', isManaged: () => true, ensureShellProfile, syncTerminalCommands })
      await access.release('claude')
      // The Linux hook is never used off Linux, even when one is passed.
      await access.prepare({ provider: 'claude', installation: npmInstall(binDirectory()) }, 'install')
    }
    expect(syncTerminalCommands).not.toHaveBeenCalled()
  })

  describe('on Linux', () => {
    function linuxAccess(overrides: Partial<Parameters<typeof createCliTerminalAccess>[0]> = {}) {
      const syncTerminalCommands = vi.fn(async (reason: string) => ({ outcome: reason === 'uninstall' ? 'removed' : 'added', skipped: [] as string[] }))
      const ensureShellProfile = vi.fn(async () => 'added')
      const ensureUserPath = vi.fn(async () => 'added' as const)
      const log = vi.fn()
      const access = createCliTerminalAccess({
        platform: 'linux',
        executionMode: 'same-user',
        isManaged: (installation) => installation.npmPrefix === '/home/ann/.local/share/XingMangAI/Cli/npm',
        syncTerminalCommands,
        ensureShellProfile,
        ensureUserPath,
        log,
        ...overrides,
      })
      return { access, syncTerminalCommands, ensureShellProfile, ensureUserPath, log }
    }
    const managed = { source: 'npm' as const, npmPrefix: '/home/ann/.local/share/XingMangAI/Cli/npm' }

    it('syncs after every install, touching no shim, PATH or macOS profile', async () => {
      const prefix = npmPrefixWithShims('claude')
      const { access, syncTerminalCommands, ensureShellProfile, ensureUserPath, log } = linuxAccess()

      await access.prepare({ provider: 'claude', installation: npmInstall(prefix) }, 'install')
      await access.prepare({ provider: 'codex', installation: managed }, 'install')

      // Each install may add a launcher, so a second one in the same session syncs again.
      await vi.waitFor(() => expect(syncTerminalCommands).toHaveBeenCalledTimes(2))
      expect(syncTerminalCommands).toHaveBeenNthCalledWith(1, 'install')
      expect(fs.existsSync(path.join(prefix, 'claude.ps1'))).toBe(true)
      expect(ensureShellProfile).not.toHaveBeenCalled()
      expect(ensureUserPath).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('info', 'cli.shell-profile.checked', '已让新开的终端可以直接敲工具名', expect.objectContaining({ provider: 'codex', reason: 'install', outcome: 'added' })))
    })

    it('at startup syncs once, and only when one of the installs is the app\'s own', async () => {
      const first = linuxAccess()
      await first.access.sweepOnce([
        { provider: 'claude', installation: npmInstall('/usr/local') },
        { provider: 'codex', installation: managed },
        { provider: 'gemini', installation: managed },
      ])
      await first.access.sweepOnce([{ provider: 'codex', installation: managed }])
      await vi.waitFor(() => expect(first.syncTerminalCommands).toHaveBeenCalledTimes(1))
      expect(first.syncTerminalCommands).toHaveBeenCalledWith('startup')

      const second = linuxAccess({ isManaged: () => { throw new Error('未找到有效的用户主目录') } })
      await second.access.sweepOnce([{ provider: 'codex', installation: npmInstall('/usr/local') }])
      await second.access.prepare({ provider: 'codex', installation: npmInstall('/usr/local') }, 'startup')
      expect(second.syncTerminalCommands).not.toHaveBeenCalled()
    })

    it('at startup also syncs for Grok, which never lives in the app\'s npm folder', async () => {
      const { access, syncTerminalCommands } = linuxAccess()
      const grok = { source: 'native' as const, npmPrefix: null }

      await access.sweepOnce([
        { provider: 'claude', installation: npmInstall('/usr/local') },
        { provider: 'grok', installation: grok },
      ])

      await vi.waitFor(() => expect(syncTerminalCommands).toHaveBeenCalledTimes(1))
      expect(syncTerminalCommands).toHaveBeenCalledWith('startup')
    })

    it('syncs again after an uninstall and logs that the lines came out', async () => {
      const { access, syncTerminalCommands, log } = linuxAccess()

      await access.release('codex')

      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('info', 'cli.shell-profile.removed', expect.any(String), expect.objectContaining({ provider: 'codex', reason: 'uninstall', outcome: 'removed' })))
      expect(syncTerminalCommands).toHaveBeenCalledWith('uninstall')
    })

    it('runs one sync at a time so two installs never append to the same file together', async () => {
      let running = 0
      let overlapped = false
      const releases: Array<() => void> = []
      const syncTerminalCommands = vi.fn(async () => {
        running += 1
        if (running > 1) overlapped = true
        await new Promise<void>((resolve) => releases.push(resolve))
        running -= 1
        return { outcome: 'added', skipped: [] as string[] }
      })
      const { access } = linuxAccess({ syncTerminalCommands })

      await access.prepare({ provider: 'claude', installation: managed }, 'install')
      await access.release('codex')
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      releases[0]()
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      releases[1]()
      await vi.waitFor(() => expect(syncTerminalCommands).toHaveBeenCalledTimes(2))

      expect(overlapped).toBe(false)
    })

    it('logs skipped files and failures without failing the install, and tries again next time', async () => {
      const syncTerminalCommands = vi.fn()
        .mockResolvedValueOnce({ outcome: 'added', skipped: ['~/.bashrc'] })
        .mockRejectedValueOnce(new Error('终端启动器目录无效'))
        .mockResolvedValueOnce({ outcome: 'present', skipped: [] })
      const { access, log } = linuxAccess({ syncTerminalCommands })

      await expect(access.prepare({ provider: 'claude', installation: managed }, 'install')).resolves.toBeUndefined()
      await access.prepare({ provider: 'claude', installation: managed }, 'install')
      await access.prepare({ provider: 'claude', installation: managed }, 'install')

      await vi.waitFor(() => expect(syncTerminalCommands).toHaveBeenCalledTimes(3))
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('info', 'cli.shell-profile.checked', '终端启动设置无需改动', expect.objectContaining({ outcome: 'present' })))
      expect(log).toHaveBeenCalledWith('warn', 'cli.shell-profile.skipped', expect.any(String), expect.objectContaining({ skipped: ['~/.bashrc'] }))
      expect(log).toHaveBeenCalledWith('warn', 'cli.shell-profile.failed', expect.any(String), expect.objectContaining({ error: '终端启动器目录无效' }))
    })
  })
})
