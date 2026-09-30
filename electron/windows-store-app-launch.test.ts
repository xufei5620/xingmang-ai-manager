import { describe, expect, it } from 'vitest'
import { scanPowerShell, unbalancedBracket } from './powershell-script-scan.test-support'
import {
  buildWindowsStoreAppLaunchContextScript,
  describeStoreAppLaunchBlock,
  inspectWindowsStoreAppLaunchContext,
  parseWindowsStoreAppLaunchContext,
  readWindowsStoreAppLaunchContext,
  resolveStoreAppLaunchBlock,
} from './windows-store-app-launch'

describe('windows store app launch context', () => {
  it('flags the built-in Administrator only while its approval mode is off', () => {
    const builtIn = readWindowsStoreAppLaunchContext({ sid: 'S-1-5-21-9-8-7-500', uacEnabled: 1, filterAdministratorToken: 0 })
    expect(resolveStoreAppLaunchBlock(builtIn)).toBe('builtInAdministrator')
    const unknownPolicy = readWindowsStoreAppLaunchContext({ sid: 'S-1-5-21-9-8-7-500', uacEnabled: 1, filterAdministratorToken: null })
    expect(resolveStoreAppLaunchBlock(unknownPolicy)).toBe('builtInAdministrator')
    // Admin Approval Mode for the built-in account gives it a split token, and
    // store apps open normally there; warning would be a false alarm.
    const approvalMode = readWindowsStoreAppLaunchContext({ sid: 'S-1-5-21-9-8-7-500', uacEnabled: 1, filterAdministratorToken: 1 })
    expect(resolveStoreAppLaunchBlock(approvalMode)).toBeNull()
  })

  it('flags a machine with the consent prompt turned off for any account', () => {
    const context = readWindowsStoreAppLaunchContext({ sid: 'S-1-5-21-9-8-7-1001', uacEnabled: '0' })
    expect(resolveStoreAppLaunchBlock(context)).toBe('uacDisabled')
  })

  it('says nothing for ordinary accounts or unreadable output', () => {
    for (const value of [
      { sid: 'S-1-5-21-9-8-7-1001', uacEnabled: 1, filterAdministratorToken: 0 },
      { sid: 'not-a-sid-500', uacEnabled: 1 },
      null,
      [],
      'S-1-5-21-9-8-7-500',
    ]) {
      expect(resolveStoreAppLaunchBlock(readWindowsStoreAppLaunchContext(value))).toBeNull()
    }
  })

  it('only reads identity and one policy key', () => {
    const script = buildWindowsStoreAppLaunchContextScript()
    expect(script).toContain('WindowsIdentity]::GetCurrent()')
    expect(script).toContain('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System')
    expect(script).not.toMatch(/Set-ItemProperty|New-ItemProperty|Remove-Item|Start-Process/)
  })

  it('never probes off Windows', async () => {
    await expect(inspectWindowsStoreAppLaunchContext({ platform: 'darwin' })).resolves.toEqual({
      userSid: null, isBuiltInAdministrator: false, uacEnabled: null, filterAdministratorToken: null,
    })
  })

  it('keeps Windows internals out of the sentences a customer reads', () => {
    for (const block of ['builtInAdministrator', 'uacDisabled'] as const) {
      const sentence = describeStoreAppLaunchBlock(block)
      expect(sentence).toContain('Codex 桌面端')
      expect(sentence).toContain('Codex 命令行版')
      expect(sentence).not.toMatch(/UAC|AppX|Appx|MSIX|SID|令牌|注册表/)
    }
    expect(describeStoreAppLaunchBlock('builtInAdministrator')).toContain('普通账户')
    expect(describeStoreAppLaunchBlock('uacDisabled')).toContain('用户账户控制')
  })

  // The real run of this script is the Windows packaging job's PowerShell probe
  // smoke (e2e/windows-powershell-probes-smoke.mjs). Started from a vitest shard
  // it kept running out its whole budget on a busy runner and failing unrelated
  // pull requests, so here only its text and the reading of its output.
  it('builds a script PowerShell can parse and reads its output past warning lines', () => {
    const scan = scanPowerShell(buildWindowsStoreAppLaunchContextScript())
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
    const output = 'WARNING: policy value unavailable\r\n{"sid":"S-1-5-21-9-8-7-500","uacEnabled":1,"filterAdministratorToken":null}\r\n'
    expect(parseWindowsStoreAppLaunchContext(output)).toEqual({
      userSid: 'S-1-5-21-9-8-7-500', isBuiltInAdministrator: true, uacEnabled: true, filterAdministratorToken: null,
    })
    for (const unreadable of ['', 'WARNING: only a warning', '{broken}']) {
      expect(parseWindowsStoreAppLaunchContext(unreadable)).toEqual({
        userSid: null, isBuiltInAdministrator: false, uacEnabled: null, filterAdministratorToken: null,
      })
    }
  })
})
