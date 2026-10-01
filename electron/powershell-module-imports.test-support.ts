// Checks that a generated PowerShell script imports the module of every cmdlet it calls before
// the first call. Under trustedCommandEnvironment() a single cmdlet left to autoloading costs the
// whole System32 module analysis (#714, #716), so one missing import is as slow as none. The
// scripts are only read as text; no PowerShell is started (#712).
//
// Test-only: tsconfig.electron.json excludes *.test-support.ts, so none of this is compiled
// into dist-electron.

import { buildPowerShellModuleImportStatement, buildPowerShellPinnedModuleImportStatement } from './powershell-module-imports'

/**
 * The module each cmdlet the main process's scripts call comes from. Core cmdlets
 * (Microsoft.PowerShell.Core) are loaded with the engine and need no import. A cmdlet that
 * is not listed here fails the check until someone looks up its module.
 */
export const powerShellCmdletModules: Readonly<Record<string, string | null>> = {
  'ForEach-Object': null,
  'Import-Module': null,
  'Where-Object': null,
  'Add-Type': 'Microsoft.PowerShell.Utility',
  'ConvertFrom-Json': 'Microsoft.PowerShell.Utility',
  'ConvertTo-Json': 'Microsoft.PowerShell.Utility',
  'Select-Object': 'Microsoft.PowerShell.Utility',
  'Sort-Object': 'Microsoft.PowerShell.Utility',
  'Write-Host': 'Microsoft.PowerShell.Utility',
  'Get-ChildItem': 'Microsoft.PowerShell.Management',
  'Get-Item': 'Microsoft.PowerShell.Management',
  'Get-ItemProperty': 'Microsoft.PowerShell.Management',
  'Get-Process': 'Microsoft.PowerShell.Management',
  'Join-Path': 'Microsoft.PowerShell.Management',
  'Remove-Item': 'Microsoft.PowerShell.Management',
  'Set-Location': 'Microsoft.PowerShell.Management',
  'Start-Process': 'Microsoft.PowerShell.Management',
  'Test-Path': 'Microsoft.PowerShell.Management',
  'Get-AuthenticodeSignature': 'Microsoft.PowerShell.Security',
  'Get-CimInstance': 'CimCmdlets',
  'Invoke-CimMethod': 'CimCmdlets',
  'Get-AppxPackage': 'Appx',
  'Get-StartApps': 'StartLayout',
  'Get-NetTCPConnection': 'NetTCPIP',
}

export type PowerShellImportForm = 'by-name' | 'pinned'

export function powerShellImportStatement(modules: readonly string[], form: PowerShellImportForm): string {
  return form === 'pinned'
    ? buildPowerShellPinnedModuleImportStatement(modules)
    : buildPowerShellModuleImportStatement(modules)
}

/** Verb-Noun words the script calls in its own process, minus functions it defines itself. */
export function calledCmdlets(script: string): string[] {
  // Module-qualified calls (Microsoft.PowerShell.Security\Get-Acl) load their module by name.
  const unqualified = script.replace(/[A-Za-z][\w.]*\\[A-Z][A-Za-z]+-[A-Z][A-Za-z]+/g, '')
  const defined = new Set([...script.matchAll(/\bfunction\s+([A-Za-z]+-[A-Za-z]+)/g)].map((match) => match[1]))
  return [...new Set(unqualified.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g) ?? [])]
    .filter((name) => !defined.has(name))
}

/**
 * Cmdlets that would still be autoloaded: unknown, from a module that is not imported, or
 * called before the import statement.
 */
export function unimportedCmdlets(script: string, modules: readonly string[], form: PowerShellImportForm = 'by-name'): string[] {
  const importAt = modules.length ? script.indexOf(powerShellImportStatement(modules, form)) : -1
  return calledCmdlets(script).filter((cmdlet) => {
    if (!(cmdlet in powerShellCmdletModules)) return true
    const module = powerShellCmdletModules[cmdlet]
    if (!module) return false
    return importAt < 0 || !modules.includes(module) || script.indexOf(cmdlet) < importAt
  })
}

/** The modules the script's cmdlets actually need, so an import nobody uses is noticed too. */
export function neededModules(script: string): string[] {
  return [...new Set(calledCmdlets(script)
    .map((cmdlet) => powerShellCmdletModules[cmdlet])
    .filter((module): module is string => Boolean(module)))].sort()
}

/** The script with one module taken out of its import statement. */
export function withoutImportedModule(script: string, modules: readonly string[], module: string, form: PowerShellImportForm = 'by-name'): string {
  const remaining = modules.filter((name) => name !== module)
  return script.replace(powerShellImportStatement(modules, form), remaining.length ? powerShellImportStatement(remaining, form) : '')
}
