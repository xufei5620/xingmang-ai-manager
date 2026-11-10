import { describe, expect, it } from 'vitest'
import { buildPowerShellJsonOutputStatements, powerShellUtf8OutputStatement } from './powershell-constrained-language'

/** What the escaping line does to the JSON, written out so its contract can be checked without a process. */
function escapeLikeTheProbe(json: string): string {
  return json.split('').map((char) => char.charCodeAt(0) > 127 ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char).join('')
}

describe('PowerShell probe lines that survive ConstrainedLanguage', () => {
  it('asks for UTF-8 output only where the .NET call is allowed', () => {
    expect(powerShellUtf8OutputStatement).toBe(
      "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }",
    )
  })

  it('prints the expression untouched in FullLanguage and escapes past ASCII only outside it', () => {
    const [assign, escape, emit] = buildPowerShellJsonOutputStatements('$value | ConvertTo-Json -Compress')
    expect(assign).toBe('$xingmangJson = $value | ConvertTo-Json -Compress')
    expect(escape).toMatch(/^if \(\$ExecutionContext\.SessionState\.LanguageMode -ne 'FullLanguage' -and /)
    expect(escape).toContain("$xingmangJson -match '[^\\x00-\\x7F]'")
    expect(escape).toContain("'\\u{0:x4}' -f [int]$xingmangChar")
    expect(emit).toBe('$xingmangJson')
  })

  it('escapes with core types alone, so the escaping line is not itself refused', () => {
    const escape = buildPowerShellJsonOutputStatements('$value')[1]
    const typeLiterals = [...new Set(escape.match(/\[[A-Za-z][A-Za-z.]*\]/g) ?? [])].sort()
    expect(typeLiterals).toEqual(['[int]', '[string]'])
    expect(escape).not.toContain('::')
    expect(escape).not.toContain('New-Object')
  })

  it('keeps what the main process parses identical once escaped', () => {
    const raw = JSON.stringify({ error: '读不到这台电脑上 Codex 桌面端的安装信息', emoji: '😀', path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex' })
    const escaped = escapeLikeTheProbe(raw)
    expect(escaped).toMatch(/^[\x00-\x7F]*$/)
    expect(JSON.parse(escaped)).toEqual(JSON.parse(raw))
  })
})
