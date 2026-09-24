import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandSpec, RunCommandOptions } from './command-runner'
import { buildClaudeDesktopManifestInspectionScript, inspectClaudeDesktopStoreVirtualization } from './claude-desktop-manifest'
import { scanPowerShell, unbalancedBracket } from './powershell-script-scan.test-support'

const installationPath = 'C:\\Program Files\\WindowsApps\\Claude_2.2553.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'
const allVirtualized = { localProfileVirtualized: true, roamingProfileVirtualized: true, roamingDeveloperVirtualized: true }

function result(spec: CommandSpec, value: unknown): CommandResult {
  const stdout = JSON.stringify(value)
  return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: Buffer.byteLength(stdout), durationMs: 0 }
}

function fixture(value: unknown = { globalMode: 'enabled', excludedDirectories: [] }) {
  const execute = vi.fn(async (spec: CommandSpec, _options?: RunCommandOptions) => result(spec, value))
  return { platform: 'win32' as const, osRelease: '10.0.22621', installationPath, execute, resolvePowerShell: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }
}

function manifest(properties = ''): string {
  return `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:d6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6" xmlns:v="http://schemas.microsoft.com/appx/manifest/virtualization/windows10"><Identity Name="Claude" Version="2.2553.1.0" ProcessorArchitecture="x64"/><Properties>${properties}</Properties></Package>`
}

describe('inspectClaudeDesktopStoreVirtualization', () => {
  it('does not read manifests for ordinary Windows or other platforms', async () => {
    const options = fixture()
    expect(await inspectClaudeDesktopStoreVirtualization({ ...options, installationPath: 'C:\\Apps\\Claude.exe' })).toBeUndefined()
    expect(await inspectClaudeDesktopStoreVirtualization({ ...options, platform: 'darwin' })).toBeUndefined()
    expect(await inspectClaudeDesktopStoreVirtualization({ ...options, installationPath: null })).toBeUndefined()
    expect(options.execute).not.toHaveBeenCalled()
  })

  it('recognizes older manifests with ordinary filesystem virtualization', async () => {
    expect(await inspectClaudeDesktopStoreVirtualization(fixture())).toEqual(allVirtualized)
  })

  it('recognizes the current manifest exclusion for the Local third-party profile', async () => {
    expect(await inspectClaudeDesktopStoreVirtualization(fixture({ globalMode: 'enabled', excludedDirectories: ['$(KnownFolder:LocalAppData)\\Claude-3p', '$(KnownFolder:LocalAppData)\\Claude\\logs'] }))).toEqual({ ...allVirtualized, localProfileVirtualized: false })
  })

  it('honors global disabled independently of individual directory exclusions', async () => {
    expect(await inspectClaudeDesktopStoreVirtualization(fixture({ globalMode: 'disabled', excludedDirectories: [] }))).toEqual({ localProfileVirtualized: false, roamingProfileVirtualized: false, roamingDeveloperVirtualized: false })
  })

  it.each(['10.0.19045', '10.0.20347'])('ignores unsupported namespace exclusions on Windows %s', async (osRelease) => {
    const options = fixture({ globalMode: 'enabled', excludedDirectories: ['$(KnownFolder:LocalAppData)\\Claude-3p'] })
    expect(await inspectClaudeDesktopStoreVirtualization({ ...options, osRelease })).toEqual(allVirtualized)
  })

  it('supports namespace exclusions starting with build 20348', async () => {
    const options = fixture({ globalMode: 'enabled', excludedDirectories: ['$(KnownFolder:LocalAppData)\\Claude-3p'] })
    expect(await inspectClaudeDesktopStoreVirtualization({ ...options, osRelease: '10.0.20348' })).toEqual({ ...allVirtualized, localProfileVirtualized: false })
  })

  it('still honors desktop6 global disabling on Windows 10', async () => {
    const options = fixture({ globalMode: 'disabled', excludedDirectories: [] })
    expect(await inspectClaudeDesktopStoreVirtualization({ ...options, osRelease: '10.0.19045' })).toEqual({
      localProfileVirtualized: false, roamingProfileVirtualized: false, roamingDeveloperVirtualized: false,
    })
  })

  it.each(['unknown', '6.3.9600', '10.0.17763'])('does not guess paths for unsupported release %s', async (osRelease) => {
    const options = fixture()
    await expect(inspectClaudeDesktopStoreVirtualization({ ...options, osRelease })).rejects.toThrow('不支持此 Windows 版本')
    expect(options.execute).not.toHaveBeenCalled()
  })

  it('compares exclusions case-insensitively with directory boundaries', async () => {
    expect(await inspectClaudeDesktopStoreVirtualization(fixture({ globalMode: 'enabled', excludedDirectories: ['$(knownfolder:LOCALAPPDATA)/Claude-3p/', '$(KnownFolder:RoamingAppData)\\Claude'] }))).toEqual({ localProfileVirtualized: false, roamingProfileVirtualized: true, roamingDeveloperVirtualized: false })
  })

  it('honors ancestor exclusions but does not mistake children or prefixes for whole-directory exclusions', async () => {
    expect(await inspectClaudeDesktopStoreVirtualization(fixture({ globalMode: 'enabled', excludedDirectories: ['$(KnownFolder:LocalAppData)', '$(KnownFolder:RoamingAppData)\\Claude-3p\\logs', '$(KnownFolder:RoamingAppData)\\Clau'] }))).toEqual({ ...allVirtualized, localProfileVirtualized: false })
  })

  it('runs bounded XML parsing with DTD and external resolution prohibited', async () => {
    const options = fixture()
    await inspectClaudeDesktopStoreVirtualization(options)
    const [spec, execution] = options.execute.mock.calls[0]
    const script = Buffer.from(spec.argv.at(-1)!, 'base64').toString('utf16le')
    expect(script).toContain('DtdProcessing=[Xml.DtdProcessing]::Prohibit')
    expect(script).toContain('$settings.XmlResolver=$null')
    expect(script).toContain('$manifest.XmlResolver=$null')
    expect(script).toContain('$stream.Length -gt 1048576')
    expect(script).toContain('$settings.MaxCharactersInDocument=1048576')
    expect(script).toContain('[IO.FileAccess]::Read')
    expect(script).toContain('manifest-identity-mismatch')
    expect(script).not.toMatch(/Invoke-WebRequest|Set-Content|WriteAllText|Remove-Item/)
    expect(execution).toMatchObject({ timeoutMs: 15000, maxOutputBytes: 512 * 1024, trustedOnly: true, windowsHide: true })
  })

  it('encodes rather than interpolating special characters in package paths', async () => {
    const options = fixture()
    const executable = installationPath.replace('Program Files', "Program Files';$(throw 'injected')")
    await inspectClaudeDesktopStoreVirtualization({ ...options, installationPath: executable })
    const script = Buffer.from(options.execute.mock.calls[0][0].argv.at(-1)!, 'base64').toString('utf16le')
    expect(script).not.toContain("throw 'injected'")
    expect(script).toContain(Buffer.from(path.win32.join(path.win32.dirname(path.win32.dirname(executable)), 'AppxManifest.xml'), 'utf16le').toString('base64'))
  })

  it.each([
    null,
    { globalMode: 'unknown', excludedDirectories: [] },
    { globalMode: 'enabled', excludedDirectories: 'not-an-array' },
    { globalMode: 'enabled', excludedDirectories: [''] },
    { globalMode: 'enabled', excludedDirectories: [17] },
    { globalMode: 'enabled', excludedDirectories: ['$(KnownFolder:LocalAppData)\\*'] },
  ])('rejects invalid or unsupported manifest output without guessing a directory', async (value) => {
    await expect(inspectClaudeDesktopStoreVirtualization(fixture(value))).rejects.toThrow('清单无法安全读取')
  })

  it('does not echo process error content', async () => {
    const options = fixture()
    options.execute.mockRejectedValue(new Error('private-path-and-sk-secret'))
    const error = await inspectClaudeDesktopStoreVirtualization(options).catch((failure: unknown) => failure)
    expect(String(error)).toContain('清单无法安全读取')
    expect(String(error)).not.toContain('sk-secret')
  })

  // These used to be proven by writing manifests to disk and cold-starting Windows PowerShell 5.1
  // against each one, and that start kept outlasting even a 90s budget on a busy runner (#244, run
  // 36042396731) - with the production code swallowing the reason (I13), all CI ever showed was
  // 「清单无法安全读取」. What the case really pinned is a property of the text PowerShell is
  // handed, so the text is checked directly, on every platform, without starting a process.
  it('keeps every manifest guard ahead of the step it guards', () => {
    const script = buildClaudeDesktopManifestInspectionScript('C:\\WindowsApps\\Claude\\AppxManifest.xml', '2.2553.1.0', 'x64')
    const at = (fragment: string) => {
      const index = script.indexOf(fragment)
      expect(index, fragment).toBeGreaterThanOrEqual(0)
      return index
    }
    const open = at('[IO.File]::Open($manifestPath')
    const create = at('[Xml.XmlReader]::Create($stream,$settings)')
    const load = at('$manifest.Load($reader)')
    // A junction planted over the manifest is refused before the file is opened at all.
    expect(at('[IO.FileAttributes]::ReparsePoint')).toBeLessThan(open)
    // An oversized or empty file is refused before a single byte reaches the XML parser.
    expect(at("$stream.Length -gt 1048576){throw 'manifest-size-limit'}")).toBeLessThan(create)
    for (const setting of ['$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit', '$settings.XmlResolver=$null', '$settings.MaxCharactersInDocument=1048576']) {
      expect(at(setting), setting).toBeLessThan(create)
    }
    expect(at('$manifest.XmlResolver=$null')).toBeLessThan(load)
    expect(at('$ErrorActionPreference=\'Stop\'')).toBeLessThan(open)
  })

  it('keeps the package path and identity inside closed single-quoted literals, even for a hostile path', () => {
    const manifestPath = "C:\\Program Files';$(throw 'injected')\"&calc\\WindowsApps\\AppxManifest.xml"
    const scan = scanPowerShell(buildClaudeDesktopManifestInspectionScript(manifestPath, '2.2553.1.0', 'arm64'))
    expect(scan.unterminated).toBe(false)
    expect(unbalancedBracket(scan.code)).toBeNull()
    expect(scan.expandable).toEqual([])
    expect(scan.code).not.toContain('injected')
    expect(scan.code).not.toContain('calc')
    const encoded = scan.literals.filter((literal) => /^[A-Za-z0-9+/]+=*$/.test(literal) && literal.length > 40)
    expect(encoded.map((literal) => Buffer.from(literal, 'base64').toString('utf16le'))).toEqual([manifestPath])
    expect(scan.literals).toContain('2.2553.1.0')
    expect(scan.literals).toContain('arm64')
  })

  it('queries the manifest through the namespaces a Store package declares', () => {
    const script = buildClaudeDesktopManifestInspectionScript('C:\\WindowsApps\\Claude\\AppxManifest.xml', '2.2553.1.0', 'x64')
    const declared = new Map([...manifest().matchAll(/xmlns(?::(\w+))?="([^"]+)"/g)].map(([, prefix, uri]) => [prefix ?? 'p', uri]))
    const registered = new Map([...script.matchAll(/AddNamespace\('(\w+)','([^']+)'\)/g)].map(([, prefix, uri]) => [prefix, uri]))
    expect(registered).toEqual(declared)
    const queries = [...script.matchAll(/Select(?:Single)?Nodes?\('([^']+)',\$namespaces\)/g)].map(([, query]) => query)
    expect(queries).toEqual([
      '/p:Package/p:Identity',
      '/p:Package/p:Properties/d6:FileSystemWriteVirtualization',
      '/p:Package/p:Properties/v:FileSystemWriteVirtualization/v:ExcludedDirectories/v:ExcludedDirectory',
    ])
    for (const query of queries) {
      for (const [, prefix] of query.matchAll(/(\w+):/g)) expect(registered.has(prefix), `${query} uses ${prefix}`).toBe(true)
    }
  })

  it('hands inspection the script the builder produces for the package it resolved', async () => {
    const options = fixture()
    await inspectClaudeDesktopStoreVirtualization(options)
    const script = Buffer.from(options.execute.mock.calls[0][0].argv.at(-1)!, 'base64').toString('utf16le')
    expect(script).toBe(buildClaudeDesktopManifestInspectionScript(
      'C:\\Program Files\\WindowsApps\\Claude_2.2553.1.0_x64__pzs8sxrjxfjjc\\AppxManifest.xml', '2.2553.1.0', 'x64'))
  })
})
