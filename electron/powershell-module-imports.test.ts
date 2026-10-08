import { describe, expect, it } from 'vitest'
import { claudeDesktopPowerShellModules, buildClaudeDesktopManifestInspectionScript } from './claude-desktop-manifest'
import { claudeDesktopPolicyReadScript } from './claude-desktop-policy'
import { buildWindowsCliProcessProbeScript, windowsCliProcessProbeModules } from './cli-process-probe'
import { codexDesktopActivationModules, codexDesktopActivationScript } from './codex-desktop-cdp'
import { buildClearProviderOverridesScript } from './diagnostic-fixes'
import { buildDiagnosticsCodexDesktopProbeScript, diagnosticsCodexDesktopProbeModules } from './diagnostics'
import { windowsExternalClientInventoryModules, windowsExternalClientInventoryModulesFor, windowsExternalClientInventoryScript } from './external-client-runtime'
import {
  appInstallerQueryModules,
  appInstallerQueryScript,
  installedNodeSignatureScript,
  nodeInstallerSignatureScript,
  windowsRestartStatusModules,
  windowsRestartStatusScript,
} from './node-runtime'
import { windowsSystemProxyCompiledScript, windowsSystemProxyModules, windowsSystemProxyScript } from './platform/windows-system-proxy'
import {
  authenticodeSignatureModules,
  buildPowerShellModuleImportStatement,
  buildPowerShellPinnedModuleImportStatement,
} from './powershell-module-imports'
import {
  neededModules,
  unimportedCmdlets,
  withoutImportedModule,
  type PowerShellImportForm,
} from './powershell-module-imports.test-support'
import { installedPythonInspectionScript, pythonInstallerSignatureScript } from './python-runtime'
import { buildClearUserProxyScript, buildReadProxyScopesScript, readProxyScopesModules } from './stale-proxy-environment'
import { nativeCliSignatureScript } from './trusted-native-cli'
import { buildProtectedDirectoryAclScript, protectedDirectoryAclModules } from './trusted-temp'
import { uninstallAccountProbeModules, uninstallAccountProbeScript } from './uninstall-cleanup'
import { buildSetUserCertificateTrustScript } from './user-certificate-trust'
import { buildEnsureUserPathScript, buildRemoveUserPathScript } from './windows-cli-shell-access'
import { buildCliLaunchPlan, cliLaunchBrokerModules, cliTerminalScriptModules } from './windows-elevation'
import {
  buildProgramFilesAclProbe,
  buildWindowsDirectoryTreeAclScript,
  windowsAclProbeModules,
  type WindowsMachinePaths,
} from './windows-machine-paths'
import { workBuddyInstallerSignatureScript } from './workbuddy-installer'

const machinePaths: WindowsMachinePaths = {
  systemRoot: 'C:\\Windows',
  system32: 'C:\\Windows\\System32',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  programData: 'C:\\ProgramData',
}

function decodeEncodedCommand(argv: readonly string[]): string {
  return Buffer.from(argv[argv.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
}

const cliLaunchPlan = buildCliLaunchPlan({
  executable: 'C:\\Program Files\\XingMang\\cli\\codex.exe',
  argv: ['--yolo'],
  workspace: 'C:\\Users\\Tester\\project',
  title: 'Codex · 星芒AI',
}, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
const cliLaunchBroker = decodeEncodedCommand(cliLaunchPlan.argv)
const cliTerminalScript = Buffer.from(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(cliLaunchBroker)?.[1] ?? '', 'base64').toString('utf16le')

// Every script the main process runs with PSModulePath narrowed to System32 (I2) that calls a
// cmdlet outside the engine core. Long-running elevated install brokers (Codex Appx, Node.js UAC)
// and the Add-Type token probe (提速清单 A1) are not here; see the PR that added this file.
const scripts: Array<[string, string, readonly string[], PowerShellImportForm]> = [
  ['running CLI process probe', buildWindowsCliProcessProbeScript(), windowsCliProcessProbeModules, 'by-name'],
  ['check page Codex desktop probe', buildDiagnosticsCodexDesktopProbeScript(), diagnosticsCodexDesktopProbeModules, 'by-name'],
  ['Codex desktop activation', codexDesktopActivationScript, codexDesktopActivationModules, 'by-name'],
  ['external client inventory', windowsExternalClientInventoryScript(), windowsExternalClientInventoryModules, 'by-name'],
  ['external client inventory with remembered signatures', windowsExternalClientInventoryScript([
    { path: 'C:\\Users\\Tester\\AppData\\Local\\WorkBuddy\\WorkBuddy.exe', stamp: '1:2:3', status: 'Valid', subject: 'CN=Tencent', version: '1.2.3' },
  ]), windowsExternalClientInventoryModules, 'by-name'],
  ['external client inventory before opening WorkBuddy', windowsExternalClientInventoryScript([], 'workbuddy'), windowsExternalClientInventoryModulesFor('workbuddy'), 'by-name'],
  ['external client inventory before opening Claude Desktop', windowsExternalClientInventoryScript([], 'claudeDesktop'), windowsExternalClientInventoryModulesFor('claudeDesktop'), 'by-name'],
  ['uninstall desktop account probe', uninstallAccountProbeScript, uninstallAccountProbeModules, 'by-name'],
  ['Claude desktop manifest reader', buildClaudeDesktopManifestInspectionScript(
    'C:\\Program Files\\WindowsApps\\Claude_1.0.0.0_x64__pzs8sxrjxfjjc\\AppxManifest.xml', '1.0.0.0', 'x64',
  ), claudeDesktopPowerShellModules, 'by-name'],
  ['Claude desktop policy reader', claudeDesktopPolicyReadScript, claudeDesktopPowerShellModules, 'by-name'],
  ['proxy settings reader', buildReadProxyScopesScript(), readProxyScopesModules, 'by-name'],
  ['system proxy switch', windowsSystemProxyScript, windowsSystemProxyModules, 'by-name'],
  ['system proxy switch, compiled fallback', windowsSystemProxyCompiledScript, windowsSystemProxyModules, 'by-name'],
  ['pending restart probe', windowsRestartStatusScript, windowsRestartStatusModules, 'by-name'],
  ['App Installer package probe', appInstallerQueryScript, appInstallerQueryModules, 'by-name'],
  ['Node.js installer signature check', nodeInstallerSignatureScript, authenticodeSignatureModules, 'pinned'],
  ['installed Node.js signature check', installedNodeSignatureScript, authenticodeSignatureModules, 'pinned'],
  ['Python installer signature check', pythonInstallerSignatureScript, authenticodeSignatureModules, 'pinned'],
  ['installed Python check', installedPythonInspectionScript, authenticodeSignatureModules, 'pinned'],
  ['WorkBuddy installer signature check', workBuddyInstallerSignatureScript, authenticodeSignatureModules, 'pinned'],
  ['native CLI signature check', nativeCliSignatureScript, authenticodeSignatureModules, 'by-name'],
  ['protected directory ACL read-back', buildProtectedDirectoryAclScript(), protectedDirectoryAclModules, 'by-name'],
  ['Program Files ACL probe', decodeEncodedCommand(buildProgramFilesAclProbe(
    'C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files', machinePaths,
  ).args), windowsAclProbeModules, 'by-name'],
  ['managed directory tree ACL probe', buildWindowsDirectoryTreeAclScript(), windowsAclProbeModules, 'by-name'],
  ['CLI terminal launch broker', cliLaunchBroker, cliLaunchBrokerModules, 'by-name'],
  ['CLI terminal', cliTerminalScript, cliTerminalScriptModules, 'by-name'],
]

describe('PowerShell module import statements', () => {
  it('imports by name, and refuses anything that is not a plain module name', () => {
    expect(buildPowerShellModuleImportStatement(['CimCmdlets', 'Microsoft.PowerShell.Utility']))
      .toBe("Import-Module -Name 'Microsoft.PowerShell.Utility', 'CimCmdlets' -ErrorAction SilentlyContinue")
    expect(() => buildPowerShellModuleImportStatement(["Appx'; calc; '"])).toThrow()
    expect(() => buildPowerShellPinnedModuleImportStatement(['..\\Appx'])).toThrow()
  })

  it('loads Utility before any other module, whether or not the script asked for it', () => {
    expect(buildPowerShellModuleImportStatement(['NetTCPIP']))
      .toBe("Import-Module -Name 'Microsoft.PowerShell.Utility', 'NetTCPIP' -ErrorAction SilentlyContinue")
    expect(buildPowerShellModuleImportStatement(['Appx', 'Microsoft.PowerShell.Utility', 'StartLayout']))
      .toBe("Import-Module -Name 'Microsoft.PowerShell.Utility', 'Appx', 'StartLayout' -ErrorAction SilentlyContinue")
  })

  it('pins a module to $PSHOME without calling Join-Path', () => {
    const statement = buildPowerShellPinnedModuleImportStatement(authenticodeSignatureModules)
    expect(statement).toBe([
      "Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop",
      "Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop",
    ].join('; '))
    expect(statement).not.toContain('Join-Path')
  })
})

describe('PowerShell scripts under the trusted environment import their modules', () => {
  it('finds the terminal script inside the launch broker', () => {
    expect(cliTerminalScript).toContain('Set-Location')
  })

  it.each(scripts)('imports the module of every cmdlet the %s calls before the first one runs', (_name, script, modules, form) => {
    expect(unimportedCmdlets(script, modules, form)).toEqual([])
  })

  it.each(scripts)('notices when the %s loses any one of its imports', (_name, script, modules, form) => {
    // By name, Utility is imported whatever the list says, so it cannot be lost.
    for (const module of modules.filter((name) => form === 'pinned' || name !== 'Microsoft.PowerShell.Utility')) {
      const weakened = withoutImportedModule(script, modules, module, form)
      expect(weakened, `${module} dropped`).not.toBe(script)
      expect(unimportedCmdlets(weakened, modules.filter((name) => name !== module), form), `${module} dropped`).not.toEqual([])
    }
  })

  it.each(scripts)('imports nothing the %s does not call', (_name, script, modules) => {
    expect([...modules].sort()).toEqual(neededModules(script))
  })

  // These call no cmdlet outside the engine core, so they need no import. If one starts to,
  // this fails and it belongs in the list above with its modules.
  it.each([
    ['user proxy clean-up', buildClearUserProxyScript()],
    ['provider override clean-up', buildClearProviderOverridesScript()],
    ['user PATH update', buildEnsureUserPathScript()],
    ['user PATH removal', buildRemoveUserPathScript()],
    ['certificate trust switch', buildSetUserCertificateTrustScript()],
  ])('keeps the %s free of cmdlets that would be autoloaded', (_name, script) => {
    expect(unimportedCmdlets(script, [])).toEqual([])
  })
})
