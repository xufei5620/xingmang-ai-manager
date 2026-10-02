import { describe, expect, it } from 'vitest'
import { scanPowerShell, unbalancedBracket } from './powershell-script-scan.test-support'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import {
  buildWindowsStoreAvailabilityScript,
  inspectWindowsStoreAvailability,
  parseWindowsStoreAvailability,
} from './windows-store-app-launch'

describe('powershell module import statement', () => {
  it('imports every module by quoted name before the first cmdlet runs', () => {
    expect(buildPowerShellModuleImportStatement(['Microsoft.PowerShell.Management', 'Appx']))
      .toBe("Import-Module -Name 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Appx' -ErrorAction SilentlyContinue")
    // 收紧环境下自动加载要 20 多秒：第一条 cmdlet 之前必须已经按名字导入（#714）。
    const lines = buildWindowsStoreAvailabilityScript().split('\n')
    const importLine = lines.findIndex((line) => line.startsWith('Import-Module -Name '))
    const firstCmdlet = lines.findIndex((line) => /Get-ItemProperty|Get-AppxPackage|ConvertTo-Json/.test(line))
    expect(importLine).toBeGreaterThanOrEqual(0)
    expect(importLine).toBeLessThan(firstCmdlet)
    expect(lines[importLine]).toContain("'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management'")
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
