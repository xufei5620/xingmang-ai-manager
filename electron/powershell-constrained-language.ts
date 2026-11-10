// Leaf module on purpose, like powershell-module-imports: probe scripts in
// several services are assembled from these lines.

/**
 * When an application-control policy (WDAC, AppLocker, or anything that sets
 * the system lockdown) is enforced, Windows PowerShell runs every -Command
 * string in ConstrainedLanguage mode. There, `[System.Text.UTF8Encoding]::new()`
 * and setting `[Console]::OutputEncoding` are refused, and that one refused
 * line made the whole probe come back as `exit code 1` with its JSON thrown
 * away: a customer's Codex desktop card read 「检测失败」 on every scan
 * although the app was installed (2026-11-10).
 *
 * The guard keeps FullLanguage byte-for-byte as before, UTF-8 output included,
 * and skips the line where it would be refused. Nothing here loosens the
 * policy: the script simply stops asking for something the policy forbids.
 */
export const powerShellUtf8OutputStatement = "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }"

/**
 * Prints the JSON that `expression` produces. Under ConstrainedLanguage the
 * output encoding above stays at the console code page (936 on Chinese
 * Windows), which the main process would misread as UTF-8, so every character
 * past ASCII is written as a JSON `\uXXXX` escape there. JSON.parse reads both
 * forms back to the same string, and FullLanguage output is left untouched.
 * Only core-type operations are used, all of them allowed in that mode.
 */
export function buildPowerShellJsonOutputStatements(expression: string): string[] {
  return [
    `$xingmangJson = ${expression}`,
    "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage' -and $xingmangJson -match '[^\\x00-\\x7F]') { $xingmangJson = -join @(foreach ($xingmangChar in $xingmangJson.ToCharArray()) { if ([int]$xingmangChar -gt 127) { '\\u{0:x4}' -f [int]$xingmangChar } else { [string]$xingmangChar } }) }",
    '$xingmangJson',
  ]
}
