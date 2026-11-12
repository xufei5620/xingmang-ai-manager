// Leaf module on purpose, like powershell-module-imports: probe scripts in
// several services are assembled from these lines.
//
// When an application-control policy (WDAC, AppLocker, or anything else that
// sets the system lockdown) is enforced, Windows PowerShell runs every -Command
// string in ConstrainedLanguage mode. Refused there: creating or calling into a
// non-core .NET type (`[System.Text.UTF8Encoding]::new()`,
// `[System.Diagnostics.Stopwatch]::StartNew()`), setting a property on one
// (`[Console]::OutputEncoding = ...`), and `[pscustomobject]@{}`, whose
// hashtable-to-object conversion is not allowed. Hashtable literals, casts to
// [int] or [string] and methods on strings still work.
//
// The exit code of -Command is the last statement's, so a refused line in the
// middle only writes to stderr, while a refused final
// `[pscustomobject]@{...} | ConvertTo-Json` comes back as exit code 1 with
// nothing on stdout. That is how a customer's Codex desktop card read
// 「检测失败」 on every scan although the app was installed (2026-11-10).
// Checked on the Windows runner under the system lockdown debug policy
// (__PSLockdownPolicy=4), which is what an enforced policy looks like to
// PowerShell. Nothing here loosens a policy: the scripts stop asking for what
// it forbids.

/**
 * UTF-8 output where the .NET call is allowed. In FullLanguage this is the
 * same line as before, byte for byte; under ConstrainedLanguage it is skipped
 * instead of being refused, and the output stays in the console code page,
 * which is what {@link buildPowerShellJsonOutputStatements} is for.
 */
export const powerShellUtf8OutputStatement = "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }"

/**
 * Prints the JSON that `expression` produces. Under ConstrainedLanguage the
 * output stays in the console code page (936 on Chinese Windows), which the
 * main process would misread as UTF-8, so every character past ASCII is
 * written as a JSON `\uXXXX` escape there. JSON.parse reads both forms back to
 * the same string, and FullLanguage output is left untouched. The escaping
 * line uses core types alone, so it is not itself refused.
 */
export function buildPowerShellJsonOutputStatements(expression: string): string[] {
  return [
    `$xingmangJson = ${expression}`,
    "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage' -and $xingmangJson -match '[^\\x00-\\x7F]') { $xingmangJson = -join @(foreach ($xingmangChar in $xingmangJson.ToCharArray()) { if ([int]$xingmangChar -gt 127) { '\\u{0:x4}' -f [int]$xingmangChar } else { [string]$xingmangChar } }) }",
    '$xingmangJson',
  ]
}

/**
 * Runs `statements` only where the session is not in FullLanguage, then ends
 * the script. The lines that follow it are left exactly as they were, so a
 * script that used to call into .NET keeps doing so, byte for byte, wherever
 * that is allowed, and only a locked-down machine takes the other way.
 */
export function buildPowerShellConstrainedLanguageBranch(statements: readonly string[]): string[] {
  return [
    "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {",
    ...statements.map((line) => `  ${line}`),
    '  return',
    '}',
  ]
}

/** Where `[Environment]::GetEnvironmentVariable(name, 'User')` reads and writes. */
export const powerShellUserEnvironmentKey = 'HKCU:\\Environment'

/** Where `[Environment]::GetEnvironmentVariable(name, 'Machine')` reads. */
export const powerShellMachineEnvironmentKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

/**
 * `Read-XingmangEnvironmentValue <key> <name>` answers what
 * `[Environment]::GetEnvironmentVariable(name, 'User' | 'Machine')` answers,
 * through the registry provider instead of the refused .NET call: the value
 * when it is a string (REG_EXPAND_SZ expanded the same way, against this
 * process's environment), $null when it is missing or of another kind.
 * Registry value names are case-insensitive, and so is the property lookup.
 * Needs Microsoft.PowerShell.Management.
 */
export const powerShellReadEnvironmentValueFunction: readonly string[] = [
  'function Read-XingmangEnvironmentValue([string]$key, [string]$name) {',
  '  $item = Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue',
  '  if ($null -eq $item) { return $null }',
  '  $value = $item.$name',
  '  if ($value -is [string]) { return $value }',
  '  return $null',
  '}',
]

/**
 * What `[Environment]::SetEnvironmentVariable(..., 'User')` does besides
 * writing the registry: it tells every top-level window, Explorer above all,
 * that the environment changed, so a terminal opened from now on sees the new
 * value without signing out. Under ConstrainedLanguage the .NET call is refused
 * and no cmdlet sends that message, but setx.exe sends it after every write.
 * It is given an empty value, which it stores as an empty string, and the
 * value is taken out again at once, so nothing is left behind, as with the
 * throwaway name the FullLanguage PATH scripts clear for the same reason.
 * `--%` hands setx its arguments verbatim: Windows PowerShell 5.1 drops an
 * empty string argument, PowerShell 7.3 quotes it differently, and the empty
 * pair of quotes has to arrive as is.
 *
 * `$env:XINGMANG_SETX_EXE` is System32's setx.exe, resolved by the main
 * process (I14). Needs Microsoft.PowerShell.Management.
 */
export function buildPowerShellEnvironmentBroadcastStatements(): string[] {
  return [
    '$null = & $env:XINGMANG_SETX_EXE --% XINGMANG_ENVIRONMENT_REFRESH ""',
    "if ($LASTEXITCODE -ne 0) { throw ('setx exited with ' + $LASTEXITCODE) }",
    `Remove-ItemProperty -LiteralPath '${powerShellUserEnvironmentKey}' -Name 'XINGMANG_ENVIRONMENT_REFRESH' -ErrorAction SilentlyContinue`,
  ]
}
