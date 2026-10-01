// Leaf module on purpose: windows-machine-paths, which windows-elevation itself
// depends on, builds probe scripts with these too.

/**
 * The names here are fixed module names written in this repository, never
 * data; anything else is refused rather than quoted.
 */
function moduleNameLiteral(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(name)) throw new Error(`PowerShell 模块名无效：${name}`)
  return `'${name}'`
}

/**
 * Loads the named modules up front so the script never relies on command
 * autoloading.
 *
 * trustedCommandEnvironment() narrows PSModulePath to System32 and drops
 * PSModuleAnalysisCachePath. In that environment the first cmdlet that has to
 * be autoloaded (even Write-Output) made Windows PowerShell rebuild its module
 * analysis over every System32 module: 22 s per process on the CI runner,
 * against 0.3 s once the modules are imported by name (#714). Importing by
 * name still resolves only through the narrowed PSModulePath, so nothing is
 * trusted that was not before. A module that fails to load falls back to
 * autoloading, which is the old behaviour.
 */
export function buildPowerShellModuleImportStatement(modules: readonly string[]): string {
  return `Import-Module -Name ${modules.map(moduleNameLiteral).join(', ')} -ErrorAction SilentlyContinue`
}

/**
 * The same, for scripts that must load a module from $PSHOME itself and stop
 * if it is not there (signature checks). The path is built by concatenation
 * rather than with Join-Path: Join-Path lives in Microsoft.PowerShell.Management,
 * so calling it to import a module set off the very scan the import is for.
 */
export function buildPowerShellPinnedModuleImportStatement(modules: readonly string[]): string {
  return modules
    .map((name) => {
      moduleNameLiteral(name)
      return `Import-Module -Name ($PSHOME + '\\Modules\\${name}\\${name}.psd1') -Force -ErrorAction Stop`
    })
    .join('; ')
}

/**
 * What every Authenticode check (Node.js, Python, WorkBuddy, native CLIs)
 * calls into: Get-AuthenticodeSignature and the ConvertTo-Json that reports it.
 */
export const authenticodeSignatureModules = ['Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Utility'] as const
