import { describe, expect, it } from 'vitest'
import {
  shouldUseManualUninstallVisualFixture,
  withManualUninstallVisualFixture,
} from './manual-uninstall-visual-fixture'
import type { SystemSnapshot } from './system-service'

const unavailableUninstall = () => ({
  available: false,
  reason: null,
  manualCommand: null,
})

const missingTool = () => ({
  installed: false,
  version: null,
  path: null,
  installDirectory: null,
})

const missingCli = () => ({
  ...missingTool(),
  latestVersion: null,
  updateAvailable: false,
  uninstall: unavailableUninstall(),
})

const snapshot = {
  checkedAt: '2026-08-04T00:00:00.000Z',
  network: {
    publicIp: null,
    countryCode: null,
    region: 'unknown',
    checkedAt: '2026-08-04T00:00:00.000Z',
    error: null,
  },
  runtime: {
    node: missingTool(),
    npm: missingTool(),
    python: missingTool(),
  },
  clis: {
    codex: missingCli(),
    claude: missingCli(),
    gemini: missingCli(),
    grok: missingCli(),
  },
  desktopApps: {
    codex: {
      ...missingTool(),
      appVersion: null,
      mirrorVersion: null,
      mirrorUpdateAvailable: null,
      mirrorError: null,
      running: false,
    },
  },
} satisfies SystemSnapshot

describe('main-process manual uninstall visual fixture', () => {
  it('cannot be enabled for a packaged application', () => {
    expect(shouldUseManualUninstallVisualFixture({
      environmentValue: '1',
      isPackaged: true,
    })).toBe(false)
    expect(shouldUseManualUninstallVisualFixture({
      environmentValue: undefined,
      isPackaged: false,
    })).toBe(false)
    for (const environmentValue of ['', '0', 'true', ' 1', '1 ']) {
      expect(shouldUseManualUninstallVisualFixture({
        environmentValue,
        isPackaged: false,
      })).toBe(false)
    }
  })

  it('projects only safe display states for an explicit unpackaged visual run', () => {
    expect(shouldUseManualUninstallVisualFixture({
      environmentValue: '1',
      isPackaged: false,
    })).toBe(true)

    const original = structuredClone(snapshot)
    const fixture = withManualUninstallVisualFixture(snapshot, '/tmp/xingmang-visual-home')
    const command = fixture.clis.codex.uninstall.manualCommand ?? ''
    expect(fixture.clis.codex).toMatchObject({
      installed: true,
      path: '/tmp/xingmang-visual-home/.local/bin/codex',
      installDirectory: '/tmp/xingmang-visual-home/Applications/Codex-standalone',
      uninstall: {
        available: false,
        reason: '已识别 OpenAI 官方 Codex standalone 安装；为保留配置和会话，请按教程将 CLI 程序移动到废纸篓',
      },
    })
    expect(command).toContain('trash_root=')
    expect(command).toContain('/usr/bin/mktemp -d')
    expect(command).toContain('/bin/mv "$visible_link"')
    expect(command).toContain('/bin/mv "$standalone_root"')
    expect(command).not.toMatch(/\b(?:rm|sudo|spctl)\b/)
    expect(fixture.clis.grok).toMatchObject({
      installed: true,
      path: '/tmp/xingmang-visual-home/Library/Application Support/unknown-grok-installation/bin/grok',
      installDirectory: '/tmp/xingmang-visual-home/Library/Application Support/unknown-grok-installation',
      uninstall: {
        available: false,
        reason: '当前安装来源或目录不支持安全自动卸载，请使用该发行版自带的卸载方式',
        manualCommand: null,
      },
    })
    expect(fixture.clis.claude).toBe(snapshot.clis.claude)
    expect(fixture.clis.gemini).toBe(snapshot.clis.gemini)
    expect(snapshot).toEqual(original)
  })

  it('shell-quotes unusual absolute home paths and rejects unsafe roots', () => {
    const fixture = withManualUninstallVisualFixture(snapshot, "/Users/O'Brien Test")
    expect(fixture.clis.codex.uninstall.manualCommand).toContain(`O'"'"'Brien Test`)

    expect(() => withManualUninstallVisualFixture(snapshot, 'relative/home')).toThrow('必须是绝对路径')
    expect(() => withManualUninstallVisualFixture(snapshot, '/')).toThrow('用户目录')
    expect(() => withManualUninstallVisualFixture(snapshot, '/tmp/unsafe\0home')).toThrow('NUL')
  })
})
