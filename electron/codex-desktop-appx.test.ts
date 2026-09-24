import { describe, expect, it, vi } from 'vitest'
import {
  addCodexDesktopPackage,
  buildCodexAppxElevationScript,
  buildCodexAppxUacBrokerScript,
  codexDesktopElevationFailureMessage,
  requiresCodexAppxElevation,
} from './codex-desktop-appx'
import { scanPowerShell, unbalancedBracket, type PowerShellScan } from './powershell-script-scan.test-support'

const packagePath = 'C:\\Temp\\Codex Desktop.msix'
const injectedPackagePath = "D:\\下载缓存\\O'Brien; $(Write-Output XINGMANG_TEST_INJECTION) & Codex.msix"
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const sha256Base64 = Buffer.alloc(32, 1).toString('base64')
const elevationRequired = () => Object.assign(new Error('Appx deployment failed'), { stderr: 'Deployment failed with HRESULT: 0x80073D28' })

function fixture() {
  const run = vi.fn<(executable: string, argv: string[]) => Promise<void>>().mockResolvedValue(undefined)
  const resolvePowerShell = vi.fn(() => powershell)
  const onElevationRequired = vi.fn()
  // 提权探测在单测里一律注入：真跑它会在 Windows 分片上多起一次 PowerShell。
  const inspectElevationCapability = vi.fn(async () => 'unknown' as const)
  const install = (file = packagePath, hash = sha256Base64) => addCodexDesktopPackage(file, { sha256Base64: hash, onElevationRequired }, { run, resolvePowerShell, inspectElevationCapability })
  return { run, resolvePowerShell, onElevationRequired, inspectElevationCapability, install }
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

function expectInjectionHeldAsData(script: string): PowerShellScan {
  const scan = scanPowerShell(script)
  expect(scan.unterminated).toBe(false)
  expect(unbalancedBracket(scan.code)).toBeNull()
  expect(scan.code).not.toContain('XINGMANG_TEST_INJECTION')
  expect(scan.code).not.toContain('Write-Output')
  for (const body of scan.expandable) expect(body).not.toContain('XINGMANG_TEST_INJECTION')
  return scan
}

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
    await expect(addCodexDesktopPackage(packagePath, { sha256Base64 }, { run: f.run, resolvePowerShell: f.resolvePowerShell, inspectElevationCapability: f.inspectElevationCapability })).resolves.toBeUndefined()
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

  it('embeds a hostile MSIX path in both generated scripts only as quoted data', () => {
    const installer = buildCodexAppxElevationScript(injectedPackagePath, sha256Base64)
    expect(expectInjectionHeldAsData(installer).literals).toContain(injectedPackagePath)
    // The broker carries the whole installer as one verbatim literal; it has to decode back
    // to the exact script, whose own literals are then held to the same standard.
    const broker = buildCodexAppxUacBrokerScript(powershell, injectedPackagePath, sha256Base64)
    expect(expectInjectionHeldAsData(broker).literals).toContain(installer)
  })

  it('stops an unbound installer template at the SID guard before any file operation', () => {
    const script = buildCodexAppxElevationScript('C:\\Xingmang-Fixture-Does-Not-Exist\\Codex.msix', sha256Base64)
    const guard = "if ($identity.User.Value -ne '__XINGMANG_ORIGINAL_USER_SID__') { exit 2225 }"
    const lines = script.split('\n')
    const guardLine = lines.indexOf(guard)
    expect(guardLine).toBeGreaterThanOrEqual(0)
    // A top-level statement: not inside a try or a script block that could swallow the exit.
    expect(unbalancedBracket(scanPowerShell(lines.slice(0, guardLine).join('\n')).code)).toBeNull()
    for (const line of lines.slice(0, guardLine)) expect(line).not.toMatch(/IO\.(File|Directory)|Copy|Add-Appx/)
    expect(script.indexOf(guard)).toBeLessThan(script.indexOf('CreateDirectory'))
    expect(script.indexOf(guard)).toBeLessThan(script.indexOf('[System.IO.File]::Open'))
    // The broker only substitutes a value that looks like a SID, and the literal placeholder
    // never does, so the helper run on its own always takes the exit 2225 branch.
    const broker = buildCodexAppxUacBrokerScript(powershell, packagePath, sha256Base64)
    const sidPattern = /-notmatch '([^']+)'/.exec(broker)?.[1]
    expect(sidPattern).toBe('^S-1-[0-9-]+$')
    expect(new RegExp(sidPattern ?? '').test('__XINGMANG_ORIGINAL_USER_SID__')).toBe(false)
    expect(new RegExp(sidPattern ?? '').test('S-1-5-21-1004336348-1177238915-682003330-1001')).toBe(true)
  })
})

describe('PowerShell quoting scanner used by these tests', () => {
  it('flags a path that closes its quotes and runs as code', () => {
    const naive = `$source = [System.IO.File]::Open('${injectedPackagePath}')`
    const scan = scanPowerShell(naive)
    expect(scan.code).toContain('Write-Output')
  })

  it('reads doubled quotes as one quote inside a verbatim literal', () => {
    expect(scanPowerShell("$a = 'O''Brien'").literals).toEqual(["O'Brien"])
    expect(scanPowerShell("$a = 'O''Brien'").code).toBe("$a = ''")
  })

  it('treats typographic single quotes as quotes the way PowerShell does', () => {
    expect(scanPowerShell('$a = \'O\u2019Brien\'').code).toContain('Brien')
  })

  it('keeps expandable strings apart and reports an unterminated literal', () => {
    const scan = scanPowerShell('$b = "-EncodedCommand $encoded"; $c = \'open')
    expect(scan.expandable).toEqual(['-EncodedCommand $encoded'])
    expect(scan.unterminated).toBe(true)
  })

  it('finds a bracket the generator forgot to close', () => {
    expect(unbalancedBracket('try { if ($a) { exit 1 } ')).toBe('{')
    expect(unbalancedBracket('foreach ($a in @(1, 2)) { $a }')).toBeNull()
    expect(unbalancedBracket('exit $result)')).toBe(')')
  })
})

describe('codexDesktopElevationFailureMessage', () => {
  it('keeps telling the codes apart', () => {
    expect(codexDesktopElevationFailureMessage(1223)).toContain('已取消管理员授权')
    expect(codexDesktopElevationFailureMessage(740)).toContain('未获得管理员权限')
    expect(codexDesktopElevationFailureMessage(2225)).toContain('不同的 Windows 账号')
    expect(codexDesktopElevationFailureMessage(13)).toContain('重新下载')
    // 归不了类的退出码要落回带退出码和事件日志的那一句，别被这里吃掉。
    expect(codexDesktopElevationFailureMessage(1603)).toBeNull()
    expect(codexDesktopElevationFailureMessage(Number.NaN)).toBeNull()
  })

  it('points a standard account at an administrator password instead of a retry', () => {
    expect(codexDesktopElevationFailureMessage(1223, 'standard')).toContain('不在管理员组')
    expect(codexDesktopElevationFailureMessage(740, 'standard')).toContain('管理员账号的密码')
    expect(codexDesktopElevationFailureMessage(1223, 'administrator')).toContain('重新点击安装')
    expect(codexDesktopElevationFailureMessage(1223)).not.toContain('不在管理员组')
  })
})
