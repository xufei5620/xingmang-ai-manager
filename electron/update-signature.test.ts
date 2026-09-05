import { describe, expect, it, vi } from 'vitest'
import { decodeWindowsPowerShellCommand } from './windows-elevation'
import type { CommandResult, CommandSpec, RunCommandOptions } from './command-runner'
import {
  createStrictUpdateCodeSignatureVerifier,
  installStrictUpdateCodeSignatureVerifier,
  type StrictUpdateSignatureVerifierOptions,
} from './update-signature'

const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const installer = 'C:\\Users\\Example User\\AppData\\Local\\Temp\\xingmang-update.exe'
const subject = 'CN=绍兴星芒文化传媒有限责任公司, O=绍兴星芒文化传媒有限责任公司, C=CN'

function signatureOutput(overrides: Partial<Record<'Status' | 'Path' | 'Subject', string>> = {}): string {
  return JSON.stringify({
    Status: 'Valid',
    Path: installer,
    Subject: subject,
    ...overrides,
  })
}

function verifierWithResult(stdout: string, stderr = '', extra: Partial<StrictUpdateSignatureVerifierOptions> = {}) {
  const command = vi.fn<
    (spec: CommandSpec, options: RunCommandOptions) => Promise<Pick<CommandResult, 'stdout' | 'stderr'>>
  >(async () => ({ stdout, stderr }))
  const verifier = createStrictUpdateCodeSignatureVerifier({
    platform: 'win32',
    env: process.env,
    resolvePowerShellExecutable: () => powershell,
    runCommand: command,
    buildTrustedEnvironment: () => ({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
    }),
    ...extra,
  })
  return { command, verifier }
}

describe('strict Windows update signature verifier', () => {
  it('uses the trusted absolute PowerShell path and accepts matching CN or DN publishers', async () => {
    const { command, verifier } = verifierWithResult(signatureOutput())

    await expect(verifier(['绍兴星芒文化传媒有限责任公司'], installer)).resolves.toBeNull()
    await expect(verifier([
      'C=cn, O=绍兴星芒文化传媒有限责任公司, CN=绍兴星芒文化传媒有限责任公司',
    ], installer.toLowerCase())).resolves.toBeNull()

    expect(command).toHaveBeenCalledTimes(2)
    const [spec, options] = command.mock.calls[0]
    expect(spec.executable).toBe(powershell)
    expect(spec.argv).toContain('-EncodedCommand')
    expect(spec.argv.join(' ')).not.toContain(installer)
    const encodedIndex = spec.argv.indexOf('-EncodedCommand') + 1
    const script = decodeWindowsPowerShellCommand(spec.argv[encodedIndex])
    expect(script).toContain('Microsoft.PowerShell.Security\\Get-AuthenticodeSignature')
    expect(script).toContain('Microsoft.PowerShell.Utility\\ConvertTo-Json')
    expect(script).toContain('$env:XINGMANG_UPDATE_SIGNATURE_TARGET')
    expect(options).toMatchObject({
      trustedOnly: true,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      windowsHide: true,
    })
    expect(options.env?.XINGMANG_UPDATE_SIGNATURE_TARGET).toBe(installer)
    expect(options.env?.PATH).toContain('System32')
  })

  it.each([
    ['NotSigned 状态', signatureOutput({ Status: 'NotSigned' }), '', '签名状态不是 Valid'],
    ['返回路径不一致', signatureOutput({ Path: 'C:\\Temp\\other.exe' }), '', '文件路径与更新安装包不一致'],
    ['缺少发布者', signatureOutput({ Subject: '' }), '', '缺少状态、路径或发布者'],
    ['无效 JSON', '<html>not-json</html>', '', '不是有效 JSON'],
    ['错误输出', signatureOutput(), 'Get-AuthenticodeSignature failed', '返回了错误输出'],
    ['无效字符', `${signatureOutput()}\0`, '', '包含无效字符'],
  ])('fails closed for %s', async (_label, stdout, stderr, expected) => {
    const { verifier } = verifierWithResult(stdout, stderr)
    const result = await verifier(['绍兴星芒文化传媒有限责任公司'], installer)
    expect(result).toContain('Authenticode 签名校验失败')
    expect(result).toContain(expected)
  })

  it('warns when the match relies on the bare-CN fallback and stays silent for DN matches', async () => {
    const warn = vi.fn()
    const { verifier } = verifierWithResult(signatureOutput(), '', { warn })

    await expect(verifier(['绍兴星芒文化传媒有限责任公司'], installer)).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('裸公司名(CN)')
    expect(warn.mock.calls[0][0]).toContain('IMPROVEMENT-PLAN.md 3.4')

    warn.mockClear()
    await expect(verifier([
      'C=cn, O=绍兴星芒文化传媒有限责任公司, CN=绍兴星芒文化传媒有限责任公司',
    ], installer)).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()

    warn.mockClear()
    await expect(verifier(['另一家公司'], installer)).resolves.toContain('签名发布者与当前程序配置不一致')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the passing verdict when the warning callback throws', async () => {
    const warn = vi.fn(() => { throw new Error('log sink unavailable') })
    const { verifier } = verifierWithResult(signatureOutput(), '', { warn })

    await expect(verifier(['绍兴星芒文化传媒有限责任公司'], installer)).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects publisher mismatch and empty publisher configuration', async () => {
    const { command, verifier } = verifierWithResult(signatureOutput())

    await expect(verifier(['另一家公司'], installer)).resolves.toContain('签名发布者与当前程序配置不一致')
    await expect(verifier([], installer)).resolves.toContain('未配置可信更新发布者')
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid paths and non-Windows execution before spawning PowerShell', async () => {
    const command = vi.fn(async () => ({ stdout: signatureOutput(), stderr: '' }))
    const invalidPathVerifier = createStrictUpdateCodeSignatureVerifier({
      platform: 'win32',
      resolvePowerShellExecutable: () => powershell,
      runCommand: command,
      buildTrustedEnvironment: () => ({ PATH: 'C:\\Windows\\System32' }),
    })
    const nonWindowsVerifier = createStrictUpdateCodeSignatureVerifier({
      platform: 'linux',
      runCommand: command,
    })

    await expect(invalidPathVerifier(['Publisher'], 'relative-update.exe')).resolves.toContain('不是有效的 Windows 绝对路径')
    await expect(nonWindowsVerifier(['Publisher'], installer)).resolves.toContain('仅支持 Windows')
    expect(command).not.toHaveBeenCalled()
  })

  it('fails closed when PowerShell resolution or command execution fails', async () => {
    const resolutionFailure = createStrictUpdateCodeSignatureVerifier({
      platform: 'win32',
      resolvePowerShellExecutable: () => { throw new Error('未找到系统 PowerShell') },
      runCommand: vi.fn(),
      buildTrustedEnvironment: () => ({ PATH: 'C:\\Windows\\System32' }),
    })
    const commandFailure = createStrictUpdateCodeSignatureVerifier({
      platform: 'win32',
      resolvePowerShellExecutable: () => powershell,
      runCommand: vi.fn(async () => { throw new Error('PowerShell timed out') }),
      buildTrustedEnvironment: () => ({ PATH: 'C:\\Windows\\System32' }),
    })

    await expect(resolutionFailure(['Publisher'], installer)).resolves.toContain('未找到系统 PowerShell')
    await expect(commandFailure(['Publisher'], installer)).resolves.toContain('PowerShell timed out')
  })

  it('rejects oversized output and injects the strict verifier into the updater', async () => {
    const { verifier } = verifierWithResult('x'.repeat(64 * 1024 + 1))
    await expect(verifier(['Publisher'], installer)).resolves.toContain('超过大小限制')

    const updater = { verifyUpdateCodeSignature: vi.fn() }
    installStrictUpdateCodeSignatureVerifier(updater, {
      platform: 'win32',
      resolvePowerShellExecutable: () => powershell,
      runCommand: vi.fn(async () => ({ stdout: signatureOutput(), stderr: '' })),
      buildTrustedEnvironment: () => ({ PATH: 'C:\\Windows\\System32' }),
    })
    expect(typeof updater.verifyUpdateCodeSignature).toBe('function')
    await expect(updater.verifyUpdateCodeSignature(['绍兴星芒文化传媒有限责任公司'], installer)).resolves.toBeNull()
  })
})
