import { describe, expect, it } from 'vitest'
import { buildWindowsCliProcessProbeScript } from './cli-process-probe'
import { appInstallerQueryScript, installedNodeSignatureScript, nodeInstallerSignatureScript, windowsRestartStatusScript } from './node-runtime'
import { buildPowerShellJsonOutputStatements, powerShellUtf8OutputStatement } from './powershell-constrained-language'
import { installedPythonInspectionScript, pythonInstallerSignatureScript } from './python-runtime'
import { buildWindowsExecutableProductVersionScript } from './system-scan-service'
import { nativeCliSignatureScript } from './trusted-native-cli'
import { buildUpdateSignatureScript } from './update-signature'

const escapeStatement = buildPowerShellJsonOutputStatements('$value')[1]

// The scripts on the update and install paths that were refused as a whole
// where an application-control policy runs PowerShell in ConstrainedLanguage
// (Windows runner under the system lockdown, 2026-11-10). What they may still
// use is checked here without a process; the Windows smoke runs them there.
const jsonScripts: Array<[string, string]> = [
  ['update installer signature check', buildUpdateSignatureScript()],
  ['native CLI signature check', nativeCliSignatureScript],
  ['Node.js installer signature check', nodeInstallerSignatureScript],
  ['installed Node.js signature check', installedNodeSignatureScript],
  ['pending restart probe', windowsRestartStatusScript],
  ['App Installer package probe', appInstallerQueryScript],
  ['Python installer signature check', pythonInstallerSignatureScript],
  ['installed Python check', installedPythonInspectionScript],
  ['running CLI process probe', buildWindowsCliProcessProbeScript()],
]
const scripts: Array<[string, string]> = [
  ...jsonScripts,
  ['executable product version read', buildWindowsExecutableProductVersionScript()],
]

// Reading an enum value off StringComparison and passing it to a string
// method is allowed there (checked on the runner); calling into the type is not.
const allowedStaticReads = ['[System.StringComparison]::OrdinalIgnoreCase']

/** The script with the two lines that only touch .NET in FullLanguage taken out. */
function outsideFullLanguageOnlyLines(script: string): string {
  return script.split(powerShellUtf8OutputStatement).join('').split(escapeStatement).join('')
}

function withoutAllowedStaticReads(script: string): string {
  return allowedStaticReads.reduce((rest, read) => rest.split(read).join(''), script)
}

describe('install and update scripts that have to run in ConstrainedLanguage', () => {
  it.each(scripts)('asks for UTF-8 output only through the guarded line in the %s', (_name, script) => {
    expect(script.split(powerShellUtf8OutputStatement)).toHaveLength(2)
    expect(outsideFullLanguageOnlyLines(script)).not.toContain('UTF8Encoding')
  })

  it.each(scripts)('builds no object that ConstrainedLanguage refuses in the %s', (_name, script) => {
    const rest = withoutAllowedStaticReads(outsideFullLanguageOnlyLines(script))
    expect(rest).not.toMatch(/\[pscustomobject\]/i)
    expect(rest).not.toContain('::')
    expect(rest).not.toMatch(/\bNew-Object\b|\bAdd-Type\b|\]::new|List\[/i)
  })

  it.each(jsonScripts)('prints its JSON through the escaping lines in the %s', (_name, script) => {
    expect(script).toContain(escapeStatement)
    // The App Installer probe prints only inside its if block.
    expect(script).toMatch(/\$xingmangJson\s*(?:\}\s*)?$/)
  })
})
