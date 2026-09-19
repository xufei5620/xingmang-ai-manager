import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  addCodexDesktopPackage,
  buildCodexAppxElevationScript,
  buildCodexAppxUacBrokerScript,
  requiresCodexAppxElevation,
} from './codex-desktop-appx'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const packagePath = 'C:\\Temp\\Codex Desktop.msix'
const injectedPackagePath = "D:\\下载缓存\\O'Brien; $(Write-Output XINGMANG_TEST_INJECTION) & Codex.msix"
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const sha256Base64 = Buffer.alloc(32, 1).toString('base64')
const elevationRequired = () => Object.assign(new Error('Appx deployment failed'), { stderr: 'Deployment failed with HRESULT: 0x80073D28' })

function fixture() {
  const run = vi.fn<(executable: string, argv: string[]) => Promise<void>>().mockResolvedValue(undefined)
  const resolvePowerShell = vi.fn(() => powershell)
  const onElevationRequired = vi.fn()
  const install = (file = packagePath, hash = sha256Base64) => addCodexDesktopPackage(file, { sha256Base64: hash, onElevationRequired }, { run, resolvePowerShell })
  return { run, resolvePowerShell, onElevationRequired, install }
}

function decodeScript(argv: string[]): string {
  const encodedIndex = argv.indexOf('-EncodedCommand')
  expect(encodedIndex).toBeGreaterThanOrEqual(0)
  const encoded = argv[encodedIndex + 1]
  expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  expect(Buffer.from(script, 'utf16le').toString('base64')).toBe(encoded)
  return script
}

let temporaryDirectory: string | null = null

afterAll(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

function writeTemporaryFile(name: string, contents: string): string {
  temporaryDirectory ??= mkdtempSync(path.join(os.tmpdir(), 'xingmang-appx-test-'))
  const file = path.join(temporaryDirectory, name)
  // Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, which would corrupt every
  // non-ASCII literal the generated installer script carries.
  writeFileSync(file, name.endsWith('.ps1') ? `\uFEFF${contents}` : contents, 'utf8')
  return file
}

// Windows creates a process from a single command line capped at 32767 characters, and
// -EncodedCommand inflates a script by 8/3 (UTF-16LE, then base64). Feeding these
// multi-kilobyte scripts inline used to put ~30000 characters on that line, so a busy
// runner could fail to spawn the child at all. Reading the script from a file keeps the
// line at the length of a temp path. -ExecutionPolicy Bypass is what lets PowerShell read
// a file this test just wrote into its own temp directory under a Restricted policy; the
// script never comes from anywhere else.
function powerShellScriptArgv(scriptFile: string, ...scriptArguments: string[]): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, ...scriptArguments]
}

function commandLineLength(executable: string, argv: string[]): number {
  return [executable, ...argv].reduce((total, part) => total + part.length + (/\s/.test(part) ? 3 : 1), 0)
}

function buildInjectedScripts(): string[] {
  return [
    buildCodexAppxElevationScript(injectedPackagePath, sha256Base64),
    buildCodexAppxUacBrokerScript(powershell, injectedPackagePath, sha256Base64),
  ]
}

const scriptParser = [
  'param([Parameter(Mandatory = $true)][string]$ScriptsPath)',
  "$ErrorActionPreference = 'Stop'",
  '$scripts = ConvertFrom-Json ([IO.File]::ReadAllText($ScriptsPath, [Text.Encoding]::UTF8))',
  '$result = @()',
  'foreach ($script in $scripts) {',
  '  $tokens = $null; $parseErrors = $null',
  '  $ast = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$parseErrors)',
  "  $injected = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Write-Output' }, $true))",
  '  $result += [pscustomobject]@{ errors = @($parseErrors).Count; injected = $injected.Count }',
  '}',
  'ConvertTo-Json -InputObject $result -Compress',
].join('\n')

describe('Codex Desktop Appx elevation eligibility', () => {
  it.each([
    { stderr: 'Deployment failed with HRESULT: 0x80073D28, requires administrator approval.' },
    { stderr: Buffer.from('部署失败，错误代码 0x80073D28。需要管理员权限。', 'utf8') },
    { message: 'Fehler bei der Bereitstellung (0x80073d28).' },
    new Error('安装错误：[0X80073D28]'),
    { stderr: 'Unrelated detail', message: 'HRESULT 0x80073D28' },
  ])('recognizes the exact documented HRESULT independently of language (%#)', (error) => {
    expect(requiresCodexAppxElevation(error)).toBe(true)
  })

  it.each([
    null, undefined, '0x80073D28', {}, { code: '0x80073D28' }, { stdout: '0x80073D28' },
    { stderr: 'Access denied' }, { message: '需要管理员权限' }, { stderr: '0x80073CF9' },
    { stderr: '0x80073D280' }, { stderr: '10x80073D28' }, { message: '0x80073D28suffix' },
    { stderr: '80073D28' }, { stderr: 2147958056 },
  ])('does not infer elevation from unrelated or partial diagnostics (%#)', (error) => {
    expect(requiresCodexAppxElevation(error)).toBe(false)
  })
})

describe('Codex Desktop Appx installation flow', () => {
  it('installs normally without notifying or launching a UAC broker', async () => {
    const f = fixture()
    await f.install()
    expect(f.run).toHaveBeenCalledOnce()
    expect(f.run.mock.calls[0][0]).toBe(powershell)
    expect(f.onElevationRequired).not.toHaveBeenCalled()
    const argv = f.run.mock.calls[0][1]
    expect(argv).toContain('-NoProfile')
    expect(argv).toContain('-NonInteractive')
    const script = argv.includes('-EncodedCommand') ? decodeScript(argv) : argv[argv.indexOf('-Command') + 1]
    expect(script).toContain('Add-AppxPackage')
    expect(script).toContain('-ForceApplicationShutdown')
    expect(script).not.toMatch(/-Verb\s+RunAs/i)
  })

  it('keeps an unrelated Appx error diagnostic short and never tries UAC', async () => {
    const f = fixture()
    f.run.mockRejectedValueOnce({ stderr: Buffer.from(`Package conflict 0x80073CF9: ${'detail '.repeat(1000)}`) })
    const failure = await f.install().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('0x80073CF9')
    expect((failure as Error).message.length).toBeLessThanOrEqual(2200)
    expect(f.run).toHaveBeenCalledOnce()
    expect(f.onElevationRequired).not.toHaveBeenCalled()
  })

  it('notifies once after the documented error and invokes a single encoded UAC broker', async () => {
    const f = fixture()
    const events: string[] = []
    f.run.mockImplementationOnce(async () => { events.push('normal'); throw elevationRequired() })
      .mockImplementationOnce(async () => { events.push('broker') })
    f.onElevationRequired.mockImplementation(() => { events.push('notification') })
    await f.install()
    expect(events).toEqual(['normal', 'notification', 'broker'])
    expect(f.onElevationRequired).toHaveBeenCalledOnce()
    expect(f.run).toHaveBeenCalledTimes(2)
    const [executable, argv] = f.run.mock.calls[1]
    expect(executable).toBe(powershell)
    expect(argv.join(' ')).not.toContain(packagePath)
    expect(decodeScript(argv)).toContain('-Verb RunAs')
  })

  it('supports a buffered HRESULT diagnostic and an omitted progress callback', async () => {
    const f = fixture()
    f.run.mockRejectedValueOnce({ stderr: Buffer.from('安装失败 (0x80073D28)', 'utf8') })
    await expect(addCodexDesktopPackage(packagePath, { sha256Base64 }, { run: f.run, resolvePowerShell: f.resolvePowerShell })).resolves.toBeUndefined()
    expect(f.run).toHaveBeenCalledTimes(2)
  })

  it.each([
    [1223, '取消'], [2225, '不同 Windows 账号'], [13, '安装包发生变化'], [1603, '管理员安装失败'],
  ] as const)('reports broker exit %s without repeating elevation', async (code, diagnostic) => {
    const f = fixture()
    f.run.mockRejectedValueOnce(elevationRequired()).mockRejectedValueOnce(Object.assign(new Error('broker process exited'), { code }))
    const failure = await f.install().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    if (code === 2225) expect((failure as Error).message).toMatch(/不同.*Windows.*账号|Windows.*账号.*不/)
    else expect((failure as Error).message).toContain(diagnostic)
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(f.onElevationRequired).toHaveBeenCalledOnce()
  })

  it('does not retry even if the elevated attempt repeats the elevation HRESULT', async () => {
    const f = fixture()
    f.run.mockRejectedValueOnce(elevationRequired()).mockRejectedValueOnce(elevationRequired())
    await expect(f.install()).rejects.toThrow('0x80073D28')
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(f.onElevationRequired).toHaveBeenCalledOnce()
  })

  it('retains a bounded diagnostic for an unknown elevated failure', async () => {
    const f = fixture()
    f.run.mockRejectedValueOnce(elevationRequired()).mockRejectedValueOnce({ code: 999, stderr: `Unexpected deployment failure: ${'detail '.repeat(1000)}` })
    const failure = await f.install().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('Unexpected deployment failure')
    expect((failure as Error).message.length).toBeLessThanOrEqual(2200)
    expect(f.run).toHaveBeenCalledTimes(2)
  })
})

describe('Codex Desktop Appx script boundaries', () => {
  it('checks the manifest size before copying the elevated payload', () => {
    const script = buildCodexAppxElevationScript(packagePath, sha256Base64, 12345678)
    expect(script).toContain('$source.Length -ne 12345678')
    expect(script.indexOf('$source.Length')).toBeLessThan(script.indexOf('$source.CopyTo'))
    for (const size of [0, -1, 1.2, NaN, 1500 * 1024 * 1024 + 1]) {
      expect(() => buildCodexAppxElevationScript(packagePath, sha256Base64, size)).toThrow('长度无效')
    }
  })

  it.each(['Codex.msix', 'C:Codex.msix', 'C:\\Temp\\Codex.exe', 'C:\\Temp\\Codex.msix\n', 'C:\\Temp\\bad\0.msix', 'C:\\Temp\\bad".msix'])('rejects an invalid package path before starting a process: %j', async (file) => {
    const f = fixture()
    expect(() => buildCodexAppxElevationScript(file, sha256Base64)).toThrow()
    expect(() => buildCodexAppxUacBrokerScript(powershell, file, sha256Base64)).toThrow()
    await expect(f.install(file)).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.onElevationRequired).not.toHaveBeenCalled()
  })

  it.each(['', 'not-a-digest', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), `${sha256Base64}\n`, `${sha256Base64.slice(0, -2)}B=`])('requires a canonical Base64 SHA-256 digest before executing (%#)', async (hash) => {
    const f = fixture()
    expect(() => buildCodexAppxElevationScript(packagePath, hash)).toThrow()
    expect(() => buildCodexAppxUacBrokerScript(powershell, packagePath, hash)).toThrow()
    await expect(f.install(packagePath, hash)).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
  })

  it('binds the elevated installation to the original user and expected file digest', () => {
    const script = buildCodexAppxElevationScript(packagePath, sha256Base64)
    expect(script).toContain('__XINGMANG_ORIGINAL_USER_SID__')
    expect(script).toContain(sha256Base64)
    expect(script).toMatch(/WindowsIdentity.*GetCurrent/)
    expect(script).toMatch(/SHA256|SHA-?256/i)
    expect(script).toMatch(/exit\s+2225/)
    expect(script).toMatch(/exit\s+13|\$result\s*=\s*13/)
    expect(script).toMatch(/exit\s+1603|\$result\s*=\s*1603/)
    expect(script.indexOf('Add-AppxPackage')).toBeGreaterThan(script.indexOf('__XINGMANG_ORIGINAL_USER_SID__'))
    expect(script.indexOf('Add-AppxPackage')).toBeGreaterThan(script.indexOf('ComputeHash'))
    expect(script).not.toContain('-AllUsers')
    expect(script).not.toContain('-AllowUnsigned')
    const broker = buildCodexAppxUacBrokerScript(powershell, packagePath, sha256Base64)
    expect(broker).toContain('__XINGMANG_ORIGINAL_USER_SID__')
    expect(broker).toMatch(/WindowsIdentity.*GetCurrent/)
    expect(broker).toContain('-Verb RunAs')
    expect(broker).toContain('-Wait')
    expect(broker).toContain('-PassThru')
    expect(broker).toContain('-WindowStyle Hidden')
    expect(broker).toContain('-EncodedCommand')
    expect(broker).toContain('1223')
  })

  it.each(['powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\cmd.exe'])('rejects a non-system-PowerShell broker executable: %s', (executable) => {
    expect(() => buildCodexAppxUacBrokerScript(executable, packagePath, sha256Base64)).toThrow()
  })

  it('quotes shell metacharacters in legal MSIX paths as data and sends only encoded commands to the broker', async () => {
    const file = injectedPackagePath
    const script = buildCodexAppxElevationScript(file, sha256Base64)
    expect(script).toContain(`'${file.replace(/'/g, "''")}'`)
    const f = fixture()
    f.run.mockRejectedValueOnce(elevationRequired())
    await f.install(file)
    expect(f.run).toHaveBeenCalledTimes(2)
    const brokerArgv = f.run.mock.calls[1][1]
    expect(brokerArgv.join(' ')).not.toContain('XINGMANG_TEST_INJECTION')
    expect(decodeScript(brokerArgv)).toBe(buildCodexAppxUacBrokerScript(powershell, file, sha256Base64))
  })

  it('keeps the generated scripts off the PowerShell command line', () => {
    const scriptsFile = writeTemporaryFile('scripts.json', JSON.stringify(buildInjectedScripts()))
    const parserFile = writeTemporaryFile('parse-scripts.ps1', scriptParser)
    // cmd.exe's 8191-character limit is the stricter of the two Windows ceilings; staying
    // under it keeps the 32767 process limit out of reach however far these scripts grow.
    expect(commandLineLength(powershell, powerShellScriptArgv(parserFile, scriptsFile))).toBeLessThan(8191)
    const installerFile = writeTemporaryFile('installer.ps1', buildCodexAppxElevationScript(packagePath, sha256Base64))
    expect(commandLineLength(powershell, powerShellScriptArgv(installerFile))).toBeLessThan(8191)
    // Encoding the same payload inline is what used to approach the process limit, so this
    // is the cliff the file route removes rather than merely moves.
    expect(Math.ceil((buildInjectedScripts().join('').length * 8) / 3)).toBeGreaterThan(8191)
  })

  it.skipIf(process.platform !== 'win32')('parses both generated PowerShell scripts without executing either script or injected text', async () => {
    const scriptsFile = writeTemporaryFile('scripts.json', JSON.stringify(buildInjectedScripts()))
    const executable = resolveWindowsPowerShellExecutable()
    const argv = powerShellScriptArgv(writeTemporaryFile('parse-scripts.ps1', scriptParser), scriptsFile)
    expect(commandLineLength(executable, argv)).toBeLessThan(8191)
    const { stdout } = await promisify(execFile)(executable, argv, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
    expect(JSON.parse(stdout.trim())).toEqual([{ errors: 0, injected: 0 }, { errors: 0, injected: 0 }])
  })

  it.skipIf(process.platform !== 'win32')('stops an unbound installer template at the SID guard before any file operation', async () => {
    const script = buildCodexAppxElevationScript('C:\\Xingmang-Fixture-Does-Not-Exist\\Codex.msix', sha256Base64)
    const guard = script.indexOf("if ($identity.User.Value -ne '__XINGMANG_ORIGINAL_USER_SID__') { exit 2225 }")
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(script.indexOf('CreateDirectory'))
    expect(guard).toBeLessThan(script.indexOf('[System.IO.File]::Open'))
    // This is the helper itself, never the RunAs broker. The literal placeholder
    // cannot equal a Windows SID, so neither package I/O nor installation is reached.
    const executable = resolveWindowsPowerShellExecutable()
    const argv = powerShellScriptArgv(writeTemporaryFile('installer.ps1', script))
    expect(commandLineLength(executable, argv)).toBeLessThan(8191)
    const failure = await promisify(execFile)(executable, argv, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 2225, stdout: '' })
  })
})
