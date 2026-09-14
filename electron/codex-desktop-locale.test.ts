import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as asar from '@electron/asar'
import * as TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import {
  codexDesktopLocaleNeedsChange,
  inspectCodexDesktopLocale,
  shouldAutoConfigureCodexDesktopChineseLocale,
  readCodexDesktopLocale,
  updateCodexDesktopLocaleContent,
  writeCodexDesktopLocale,
} from './codex-desktop-locale'

function makeInstall(root: string, resources: { frontend?: boolean; menu?: boolean; pak?: boolean } = {}): string {
  const install = path.join(root, 'OpenAI.Codex_26.810.7004.0_x64__test')
  const asar = path.join(install, 'app', 'resources', 'app.asar')
  if (resources.frontend !== false) {
    fs.mkdirSync(path.join(asar, 'webview', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(asar, 'webview', 'assets', 'zh-CN-jSttwbeY.js'), 'export default {}', 'utf8')
  }
  if (resources.menu !== false) {
    fs.mkdirSync(path.join(asar, 'native-menu-locales'), { recursive: true })
    fs.writeFileSync(path.join(asar, 'native-menu-locales', 'zh-CN.json'), '{}', 'utf8')
  }
  if (resources.pak !== false) {
    fs.mkdirSync(path.join(install, 'app', 'locales'), { recursive: true })
    fs.writeFileSync(path.join(install, 'app', 'locales', 'zh-CN.pak'), 'pak', 'utf8')
  }
  return install
}

describe('Codex Desktop locale content', () => {
  it('only auto-configures an existing healthy install with bundled Chinese resources', () => {
    const resources = { available: true, frontendChunk: true, menuLocale: true, pakLocale: true, resourceRoot: 'C:\\Codex' }
    expect(shouldAutoConfigureCodexDesktopChineseLocale({
      installed: true,
      configuredLocale: null,
      error: null,
      chineseResources: resources,
    })).toBe(true)
    expect(shouldAutoConfigureCodexDesktopChineseLocale({
      installed: true,
      configuredLocale: 'system',
      error: null,
      chineseResources: resources,
    })).toBe(false)
    expect(shouldAutoConfigureCodexDesktopChineseLocale({
      installed: true,
      configuredLocale: null,
      error: '配置不可读',
      chineseResources: resources,
    })).toBe(false)
    expect(shouldAutoConfigureCodexDesktopChineseLocale({
      installed: true,
      configuredLocale: null,
      error: null,
      chineseResources: { ...resources, available: false },
    })).toBe(false)
  })

  it('treats selecting the active locale as an idempotent no-op', () => {
    expect(codexDesktopLocaleNeedsChange('zh-CN', 'zh-CN')).toBe(false)
    expect(codexDesktopLocaleNeedsChange('system', 'system')).toBe(false)
    expect(codexDesktopLocaleNeedsChange(null, 'system')).toBe(true)
    expect(codexDesktopLocaleNeedsChange(null, 'zh-CN')).toBe(true)
    expect(codexDesktopLocaleNeedsChange('zh-CN', 'system')).toBe(true)
  })

  it('changes only the desktop locale override and persists an explicit system preference', () => {
    const original = '# keep\nmodel = "gpt-5"\n\n[desktop]\n# note\ntelemetry = false\n\n[other]\nvalue = 1\n'
    const chinese = updateCodexDesktopLocaleContent(original, 'zh-CN')
    expect(chinese).toContain('localeOverride = "zh-CN"')
    expect(chinese).toContain('# note')
    expect(chinese).toContain('[other]')
    expect(readCodexDesktopLocale(chinese)).toBe('zh-CN')

    const system = updateCodexDesktopLocaleContent(chinese, 'system')
    expect(system).toContain('localeOverride = "system"')
    expect(system).toContain('telemetry = false')
    expect(readCodexDesktopLocale(system)).toBe('system')
  })

  it('records system language even when the desktop table does not exist', () => {
    const result = updateCodexDesktopLocaleContent('model = "gpt-5"\n', 'system')
    expect(TOML.parse(result)).toEqual({ model: 'gpt-5', desktop: { localeOverride: 'system' } })
  })

  it.each(['"', "'"])('updates quoted TOML tables and keys without changing comments (%s)', (quote) => {
    const original = `# user settings\r\nmodel = "gpt-5"\r\n[${quote}desktop${quote}] # desktop preferences\r\n  ${quote}localeOverride${quote} = "en-US#old" # language\r\ntelemetry = false\r\n`
    const result = updateCodexDesktopLocaleContent(original, 'zh-CN')
    expect(result).toBe(original.replace('en-US#old', 'zh-CN'))
    expect(readCodexDesktopLocale(result)).toBe('zh-CN')
  })

  it.each([
    'desktop = { localeOverride = "en-US", telemetry = false }\nmodel = "gpt-5"\n',
    'desktop.localeOverride = "en-US"\ndesktop.telemetry = false\nmodel = "gpt-5"\n',
    'model = "gpt-5"\n[desktop]\ntelemetry = false\nlocaleOverride = """en-US"""\n',
  ])('preserves all values while updating a nonstandard valid TOML representation', (original) => {
    const expected = TOML.parse(original)
    ;(expected.desktop as Record<string, unknown>).localeOverride = 'zh-CN'
    expect(TOML.parse(updateCodexDesktopLocaleContent(original, 'zh-CN'))).toEqual(expected)
  })

  it('does not change table-like lines inside a multiline user string', () => {
    const original = 'instructions = """\n[desktop]\nlocaleOverride = "en-US"\n"""\n\n[desktop]\ntelemetry = false\n'
    const expected = TOML.parse(original)
    ;(expected.desktop as Record<string, unknown>).localeOverride = 'zh-CN'
    expect(TOML.parse(updateCodexDesktopLocaleContent(original, 'zh-CN'))).toEqual(expected)
  })

  it('keeps a following array table separate from desktop language settings', () => {
    const original = '[desktop]\ntelemetry = false\n[[profiles]]\nlocaleOverride = "unrelated"\n'
    const result = updateCodexDesktopLocaleContent(original, 'zh-CN')
    expect(result).toContain('[[profiles]]\nlocaleOverride = "unrelated"')
    expect(TOML.parse(result)).toEqual({ desktop: { telemetry: false, localeOverride: 'zh-CN' }, profiles: [{ localeOverride: 'unrelated' }] })
  })

  it('rejects malformed TOML and scalar desktop settings before changing anything', () => {
    expect(() => updateCodexDesktopLocaleContent('[desktop\n', 'zh-CN')).toThrow('无法解析')
    expect(() => updateCodexDesktopLocaleContent('desktop = true\n', 'zh-CN')).toThrow('不是配置表')
  })

  it('detects the local official resource set without a network request', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-'))
    const install = makeInstall(root)
    const codexHome = path.join(root, '.codex')
    fs.mkdirSync(codexHome)
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[desktop]\nlocaleOverride = "zh-CN"\n', 'utf8')

    const status = inspectCodexDesktopLocale({
      codexHome,
      installed: true,
      version: '26.810.7004.0',
      installDirectory: install,
      running: true,
      platform: 'win32',
    })

    expect(status).toMatchObject({
      configuredLocale: 'zh-CN',
      effectiveLocale: 'zh-CN',
      needsRestart: true,
      error: null,
      chineseResources: {
        available: true,
        frontendChunk: true,
        menuLocale: true,
        pakLocale: true,
      },
    })
  })

  it('detects Chinese resources stored inside a real app.asar archive', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-asar-'))
    const install = path.join(root, 'OpenAI.Codex_26.818.3698.0_x64__test')
    const source = path.join(root, 'asar-source')
    const archive = path.join(install, 'app', 'resources', 'app.asar')
    fs.mkdirSync(path.join(source, 'webview', 'assets'), { recursive: true })
    fs.mkdirSync(path.join(source, 'native-menu-locales'), { recursive: true })
    fs.mkdirSync(path.dirname(archive), { recursive: true })
    fs.mkdirSync(path.join(install, 'app', 'locales'), { recursive: true })
    fs.writeFileSync(path.join(source, 'webview', 'assets', 'zh-CN-hash.js'), 'export default {}', 'utf8')
    fs.writeFileSync(path.join(source, 'native-menu-locales', 'zh-CN.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(install, 'app', 'locales', 'zh-CN.pak'), 'pak', 'utf8')
    await asar.createPackage(source, archive)

    const codexHome = path.join(root, '.codex')
    fs.mkdirSync(codexHome)
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[desktop]\nlocaleOverride = "zh-CN"\n', 'utf8')
    const status = inspectCodexDesktopLocale({
      codexHome,
      installed: true,
      version: '26.818.3698.0',
      installDirectory: install,
      running: false,
      platform: 'win32',
    })

    expect(status.chineseResources).toMatchObject({
      available: true,
      frontendChunk: true,
      menuLocale: true,
      pakLocale: true,
    })
  })

  it('reports missing local chunks separately from a saved language setting', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-missing-'))
    const install = makeInstall(root, { frontend: false })
    const codexHome = path.join(root, '.codex')
    fs.mkdirSync(codexHome)
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[desktop]\nlocaleOverride = "zh-CN"\n', 'utf8')

    const status = inspectCodexDesktopLocale({
      codexHome,
      installed: true,
      version: '26.500.0.0',
      installDirectory: install,
      running: false,
      platform: 'win32',
    })

    expect(status.configuredLocale).toBe('zh-CN')
    expect(status.chineseResources.available).toBe(false)
    expect(status.chineseResources.frontendChunk).toBe(false)
  })

  it.each(['app-root', 'unpacked'])('detects a supported alternative application layout (%s)', (layout) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-layout-'))
    const install = makeInstall(root)
    const appDirectory = path.join(install, 'app')
    const asarDirectory = path.join(appDirectory, 'resources', 'app.asar')
    const resourceRoot = layout === 'unpacked' ? path.join(appDirectory, 'resources', 'app') : asarDirectory
    if (layout === 'unpacked') fs.renameSync(asarDirectory, resourceRoot)
    fs.renameSync(path.join(resourceRoot, 'webview', 'assets', 'zh-CN-jSttwbeY.js'), path.join(resourceRoot, 'webview', 'assets', 'zh_CN.hash.js'))
    fs.renameSync(path.join(resourceRoot, 'native-menu-locales', 'zh-CN.json'), path.join(resourceRoot, 'native-menu-locales', 'zh_CN.json'))
    const status = inspectCodexDesktopLocale({
      codexHome: path.join(root, '.codex'), installed: true, version: '26.818.3698.0',
      installDirectory: appDirectory, running: false, platform: 'win32',
    })
    expect(status.chineseResources).toEqual({ available: true, frontendChunk: true, menuLocale: true, pakLocale: true, resourceRoot })
  })

  it('does not combine incomplete resources from different layouts into a complete installation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-mixed-'))
    const install = makeInstall(root, { menu: false })
    const menuDirectory = path.join(install, 'resources', 'app.asar', 'native-menu-locales')
    fs.mkdirSync(menuDirectory, { recursive: true })
    fs.writeFileSync(path.join(menuDirectory, 'zh-CN.json'), '{}', 'utf8')
    const status = inspectCodexDesktopLocale({
      codexHome: path.join(root, '.codex'), installed: true, version: null,
      installDirectory: install, running: false, platform: 'win32',
    })
    expect(status.chineseResources.available).toBe(false)
  })

  it('detects the locale resources in a macOS application bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-macos-'))
    const install = path.join(root, 'Codex.app')
    const resourceRoot = path.join(install, 'Contents', 'Resources', 'app.asar')
    const localeDirectory = path.join(install, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'zh_CN.lproj')
    fs.mkdirSync(path.join(resourceRoot, 'webview', 'assets'), { recursive: true })
    fs.mkdirSync(path.join(resourceRoot, 'native-menu-locales'), { recursive: true })
    fs.mkdirSync(localeDirectory, { recursive: true })
    fs.writeFileSync(path.join(resourceRoot, 'webview', 'assets', 'zh-CN-hash.js'), 'export default {}', 'utf8')
    fs.writeFileSync(path.join(resourceRoot, 'native-menu-locales', 'zh-CN.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(localeDirectory, 'locale.pak'), 'pak', 'utf8')
    const status = inspectCodexDesktopLocale({
      codexHome: path.join(root, '.codex'), installed: true, version: null,
      installDirectory: install, running: false, platform: 'darwin',
    })
    expect(status.chineseResources).toEqual({ available: true, frontendChunk: true, menuLocale: true, pakLocale: true, resourceRoot })
  })

  it('writes safely under the selected CODEX_HOME and validates the result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-write-'))
    const codexHome = path.join(root, '.codex')
    const configPath = await writeCodexDesktopLocale({ codexHome }, 'zh-CN')
    expect(configPath).toBe(path.join(codexHome, 'config.toml'))
    expect(readCodexDesktopLocale(fs.readFileSync(configPath, 'utf8'))).toBe('zh-CN')
    await writeCodexDesktopLocale({ codexHome }, 'system')
    expect(readCodexDesktopLocale(fs.readFileSync(configPath, 'utf8'))).toBe('system')
    expect(shouldAutoConfigureCodexDesktopChineseLocale({
      installed: true,
      configuredLocale: readCodexDesktopLocale(fs.readFileSync(configPath, 'utf8')),
      error: null,
      chineseResources: { available: true, frontendChunk: true, menuLocale: true, pakLocale: true, resourceRoot: null },
    })).toBe(false)
  })

  it('keeps the original file untouched if an existing configuration is malformed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-invalid-'))
    const configPath = path.join(root, 'config.toml')
    const original = '[desktop]\nlocaleOverride = "unfinished\n'
    fs.writeFileSync(configPath, original, 'utf8')
    await expect(writeCodexDesktopLocale({ codexHome: root }, 'zh-CN')).rejects.toThrow('未修改')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original)
  })
})
