import { describe, expect, it } from 'vitest'
import { buildClearProviderOverridesScript } from './diagnostic-fixes'
import {
  buildPowerShellConstrainedLanguageBranch,
  buildPowerShellEnvironmentBroadcastStatements,
  buildPowerShellJsonOutputStatements,
  powerShellUtf8OutputStatement,
} from './powershell-constrained-language'
import { splitConstrainedLanguageBranch } from './powershell-constrained-language.test-support'
import { buildClearUserProxyScript, buildReadProxyScopesScript } from './stale-proxy-environment'
import { buildEnsureUserPathScript, buildRemoveUserPathScript } from './windows-cli-shell-access'

// The scripts that change or read the current user's environment variables.
// Where an application-control policy runs PowerShell in ConstrainedLanguage
// they were refused at their second line (Windows runner under the system
// lockdown, 2026-11-10), so each now opens with a branch only such a session
// takes. What that branch may use is checked here without a process; the
// Windows smoke runs both ways and compares what lands in the registry.
const scripts: Array<[string, string]> = [
  ['user PATH update', buildEnsureUserPathScript()],
  ['user PATH removal', buildRemoveUserPathScript()],
  ['proxy settings reader', buildReadProxyScopesScript()],
  ['user proxy clean-up', buildClearUserProxyScript()],
  ['provider override clean-up', buildClearProviderOverridesScript()],
]
const writingScripts = scripts.filter(([name]) => name !== 'proxy settings reader')

// Reading an enum value off StringComparison and passing it to a string method
// is allowed there (checked on the runner); calling into the type is not.
const allowedTypeLiterals = ['[System.StringComparison]', '[int]', '[string]']
const escapeStatement = buildPowerShellJsonOutputStatements('$value')[1]
const broadcast = buildPowerShellEnvironmentBroadcastStatements()

function branchOf(script: string): string {
  return splitConstrainedLanguageBranch(script).branch
}

function withoutEscapeStatement(branch: string): string {
  return branch.split(escapeStatement).join('')
}

describe('the ConstrainedLanguage branch builder', () => {
  it('runs its statements only outside FullLanguage and ends the script after them', () => {
    expect(buildPowerShellConstrainedLanguageBranch(['"one"', 'if ($x) {', '  "two"', '}'])).toEqual([
      "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {",
      '  "one"',
      '  if ($x) {',
      '    "two"',
      '  }',
      '  return',
      '}',
    ])
  })

  it('broadcasts through System32 setx with its arguments verbatim and leaves no value behind', () => {
    expect(broadcast[0]).toBe('$null = & $env:XINGMANG_SETX_EXE --% XINGMANG_ENVIRONMENT_REFRESH ""')
    expect(broadcast[1]).toContain('$LASTEXITCODE -ne 0')
    expect(broadcast[2]).toBe("Remove-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name 'XINGMANG_ENVIRONMENT_REFRESH' -ErrorAction SilentlyContinue")
  })
})

describe('user environment scripts that have to run in ConstrainedLanguage', () => {
  it.each(scripts)('takes the branch right after its first line and leaves the FullLanguage lines after it in the %s', (_name, script) => {
    const parts = splitConstrainedLanguageBranch(script)
    expect(parts.head).toBe('$ErrorActionPreference = "Stop"\n')
    // The refused UTF-8 line is still the first thing FullLanguage runs, as before.
    expect(parts.fullLanguage.split('\n')[0]).toBe('$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)')
    expect(parts.branch).not.toContain('UTF8Encoding')
    expect(parts.branch).not.toContain(powerShellUtf8OutputStatement)
  })

  it.each(scripts)('calls into no .NET type ConstrainedLanguage refuses in the branch of the %s', (_name, script) => {
    const branch = withoutEscapeStatement(branchOf(script))
    const typeLiterals = [...new Set(branch.match(/\[[A-Za-z][A-Za-z0-9.]*\]/g) ?? [])]
    expect(typeLiterals.filter((literal) => !allowedTypeLiterals.includes(literal))).toEqual([])
    expect(branch).not.toMatch(/\[pscustomobject\]/i)
    expect(branch).not.toMatch(/\bNew-Object\b|\bAdd-Type\b|\]::new|List\[/i)
    expect(branch.replaceAll('[System.StringComparison]::Ordinal', '')).not.toContain('::')
  })

  it.each(writingScripts)('writes only the current user environment in the branch of the %s', (_name, script) => {
    const writes = branchOf(script).split('\n').filter((line) => /\b(?:New-ItemProperty|Remove-ItemProperty|Set-ItemProperty|New-Item)\b/.test(line))
    expect(writes.length).toBeGreaterThan(0)
    for (const line of writes) {
      expect(line).toContain("'HKCU:\\Environment'")
      expect(line).not.toContain('HKLM')
    }
    expect(branchOf(script)).not.toMatch(/ExecutionPolicy/i)
  })

  it.each(writingScripts)('tells running programs after its last write in the branch of the %s', (_name, script) => {
    const branch = branchOf(script)
    const lastWrite = Math.max(...branch.split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /\b(?:New-ItemProperty -LiteralPath|Remove-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name \$name)/.test(line))
      .map(({ index }) => index))
    const broadcastAt = branch.split('\n').findIndex((line) => line.trim() === broadcast[0])
    expect(broadcastAt).toBeGreaterThan(lastWrite)
  })

  it('reads the stored user PATH with every variable put back before anything is written', () => {
    for (const script of [buildEnsureUserPathScript(), buildRemoveUserPathScript()]) {
      const branch = branchOf(script)
      const read = branch.slice(branch.indexOf('function Read-XingmangStoredUserPath'), branch.indexOf('function Get-XingmangUserPathKind'))
      const tryBlock = read.slice(read.indexOf('try {'), read.indexOf('} finally {'))
      // Inside the window without variables: the removals and the one read, nothing else.
      expect(tryBlock.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual([
        'try {',
        "foreach ($variable in $saved) { Remove-Item -LiteralPath ('Env:' + $variable.Key) }",
        "$item = Get-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name 'Path' -ErrorAction SilentlyContinue",
      ])
      expect(read).toContain("} finally {\n      foreach ($variable in $saved) { Set-Item -LiteralPath ('Env:' + $variable.Key) -Value $variable.Value }")
      expect(branch.indexOf('$stored = Read-XingmangStoredUserPath')).toBeLessThan(branch.indexOf('New-ItemProperty'))
    }
  })

  it('keeps the kind of the stored PATH and takes the directory from the environment', () => {
    const ensure = branchOf(buildEnsureUserPathScript())
    const remove = branchOf(buildRemoveUserPathScript())
    for (const branch of [ensure, remove]) {
      expect(branch).toContain('$kind = Get-XingmangUserPathKind')
      expect(branch).toContain('-PropertyType $kind -Force')
      expect(branch).toContain("& $env:XINGMANG_REG_EXE query 'HKCU\\Environment' /v Path")
    }
    expect(ensure).toContain('$target = ConvertTo-XingmangDirectory $env:XINGMANG_ADD_PATH')
    expect(remove).toContain('$target = ConvertTo-XingmangDirectory $env:XINGMANG_REMOVE_PATH')
    // Nothing is written when no entry matches.
    expect(remove.indexOf('if (-not $removed) { "absent"; return }')).toBeLessThan(remove.indexOf('New-ItemProperty'))
    expect(ensure.indexOf('{ "present"; return }')).toBeLessThan(ensure.indexOf('New-ItemProperty'))
  })

  it('checks every name against the fixed allow-list in the branch as well', () => {
    for (const [script, source] of [
      [buildClearUserProxyScript(), '$env:XINGMANG_CLEAR_PROXY'],
      [buildClearProviderOverridesScript(), '$env:XINGMANG_CLEAR_OVERRIDES'],
    ]) {
      const branch = branchOf(script)
      expect(branch).toContain(`foreach ($name in (${source} -split ";")) {`)
      expect(branch.indexOf('if (-not ($allowed -contains $name)) { continue }')).toBeLessThan(branch.indexOf('Remove-ItemProperty'))
    }
  })

  it('prints the proxy settings through the escaping lines in the branch', () => {
    const branch = branchOf(buildReadProxyScopesScript())
    expect(branch).toContain(escapeStatement)
    expect(branch.trimEnd()).toMatch(/\$xingmangJson$/)
    expect(branch).toContain("Read-XingmangEnvironmentValue 'HKCU:\\Environment' $name")
    expect(branch).toContain("Read-XingmangEnvironmentValue 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' $name")
  })
})
