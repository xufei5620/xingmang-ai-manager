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
