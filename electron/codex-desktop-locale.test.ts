import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  codexDesktopLocaleNeedsChange,
  inspectCodexDesktopLocale,
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
  it('treats selecting the active locale as an idempotent no-op', () => {
    expect(codexDesktopLocaleNeedsChange('zh-CN', 'zh-CN')).toBe(false)
    expect(codexDesktopLocaleNeedsChange(null, 'system')).toBe(false)
    expect(codexDesktopLocaleNeedsChange(null, 'zh-CN')).toBe(true)
    expect(codexDesktopLocaleNeedsChange('zh-CN', 'system')).toBe(true)
  })

  it('adds and removes only the desktop locale override', () => {
    const original = '# keep\nmodel = "gpt-5"\n\n[desktop]\n# note\ntelemetry = false\n\n[other]\nvalue = 1\n'
    const chinese = updateCodexDesktopLocaleContent(original, 'zh-CN')
    expect(chinese).toContain('localeOverride = "zh-CN"')
    expect(chinese).toContain('# note')
    expect(chinese).toContain('[other]')
    expect(readCodexDesktopLocale(chinese)).toBe('zh-CN')

    const system = updateCodexDesktopLocaleContent(chinese, 'system')
    expect(system).not.toContain('localeOverride')
    expect(system).toContain('telemetry = false')
    expect(readCodexDesktopLocale(system)).toBeNull()
  })

  it('does not create a locale override when restoring system language without a desktop table', () => {
    expect(updateCodexDesktopLocaleContent('model = "gpt-5"\n', 'system')).toBe('model = "gpt-5"\n')
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

  it('writes safely under the selected CODEX_HOME and validates the result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-locale-write-'))
    const codexHome = path.join(root, '.codex')
    const configPath = await writeCodexDesktopLocale({ codexHome }, 'zh-CN')
    expect(configPath).toBe(path.join(codexHome, 'config.toml'))
    expect(readCodexDesktopLocale(fs.readFileSync(configPath, 'utf8'))).toBe('zh-CN')
    await writeCodexDesktopLocale({ codexHome }, 'system')
    expect(readCodexDesktopLocale(fs.readFileSync(configPath, 'utf8'))).toBeNull()
  })
})
