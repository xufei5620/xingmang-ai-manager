import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCliTerminalAccessPlan,
  buildEnsureUserPathScript,
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
