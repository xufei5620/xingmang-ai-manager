import { describe, expect, it } from 'vitest'
import { scanPowerShell, unbalancedBracket } from './powershell-script-scan.test-support'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import {
  buildWindowsStoreAppLaunchContextScript,
  buildWindowsStoreAvailabilityScript,
  describeStoreAppLaunchBlock,
  inspectWindowsStoreAppLaunchContext,
  inspectWindowsStoreAvailability,
  parseWindowsStoreAppLaunchContext,
  parseWindowsStoreAvailability,
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

describe('powershell module import statement', () => {
  it('imports every module by quoted name before the first cmdlet runs', () => {
    expect(buildPowerShellModuleImportStatement(['Microsoft.PowerShell.Management', 'Appx']))
      .toBe("Import-Module -Name 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Appx' -ErrorAction SilentlyContinue")
    // 收紧环境下自动加载要 20 多秒：第一条 cmdlet 之前必须已经按名字导入（#714）。
    for (const script of [buildWindowsStoreAppLaunchContextScript(), buildWindowsStoreAvailabilityScript()]) {
      const lines = script.split('\n')
      const importLine = lines.findIndex((line) => line.startsWith('Import-Module -Name '))
      const firstCmdlet = lines.findIndex((line) => /Get-ItemProperty|Get-AppxPackage|ConvertTo-Json/.test(line))
      expect(importLine).toBeGreaterThanOrEqual(0)
      expect(importLine).toBeLessThan(firstCmdlet)
      expect(lines[importLine]).toContain("'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management'")
    }
    expect(buildWindowsStoreAvailabilityScript()).toContain("'Appx' -ErrorAction SilentlyContinue")
  })
})

describe('windows store availability', () => {
  it('turns the store route off only on a definite answer', () => {
    expect(parseWindowsStoreAvailability('{"installed":false,"removedByPolicy":false}')).toBe(false)
    expect(parseWindowsStoreAvailability('{"installed":true,"removedByPolicy":false}')).toBe(true)
    // 公司策略关掉商店时应用可能还在，但打不开，也装不了东西。
    expect(parseWindowsStoreAvailability('{"installed":true,"removedByPolicy":true}')).toBe(false)
    expect(parseWindowsStoreAvailability('WARNING: something\r\n{"installed":false,"removedByPolicy":false}\r\n')).toBe(false)
  })

  it('keeps the store-first route when the probe could not tell', () => {
    for (const output of ['', 'garbage', '{"installed":null,"removedByPolicy":false}', '[1]', '{"installed":"maybe"}', '{broken}']) {
      expect([output, parseWindowsStoreAvailability(output)]).toEqual([output, null])
    }
  })

  it('only reads the package list and the store policy keys', () => {
    const script = buildWindowsStoreAvailabilityScript()
    expect(script).toContain('Get-AppxPackage -Name "Microsoft.WindowsStore" -ErrorAction Stop')
    expect(script).toContain('RemoveWindowsStore')
    expect(script).not.toMatch(/Set-ItemProperty|Remove-|New-Item|Add-AppxPackage|Start-Process/i)
  })

  it('answers unknown off Windows without starting a process', async () => {
    await expect(inspectWindowsStoreAvailability({ platform: 'linux' })).resolves.toBeNull()
  })

  // Run for real once in the Windows packaging job's PowerShell probe smoke.
  it('builds a store probe PowerShell can parse', () => {
    const scan = scanPowerShell(buildWindowsStoreAvailabilityScript())
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
  })
})
