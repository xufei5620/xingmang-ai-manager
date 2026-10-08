import { describe, expect, it } from 'vitest'
import type { AppSettings } from './app-settings'
import {
  buildDataTransferFile,
  buildPortableSettings,
  conversationFileName,
  dataTransferFileName,
  dataTransferInvalidMessage,
  MAX_DATA_TRANSFER_BYTES,
  parseChatConversationExport,
  parseDataTransferExportInput,
  parseDataTransferFile,
  planPortableSettingsImport,
} from './data-transfer'

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { version: 2, workspace: 'C:\\Users\\peaker', theme: 'light', uiSkin: 'mist', checkUpdatesOnStartup: true, runDiagnosticsOnStartup: false, ...overrides }
}

describe('data transfer file', () => {
  it('round-trips the portable settings and conversations', () => {
    const source = settings({ theme: 'dark', uiSkin: 'aurora', closeBehavior: 'tray', desktopNotifications: false, mirrorPolicy: 'mirror-first' })
    const raw = buildDataTransferFile(source, { conversations: [{ id: 'c1', messages: [] }] }, new Date('2026-09-25T00:00:00Z'))
    const parsed = parseDataTransferFile(raw)
    expect(parsed.settings).toEqual(buildPortableSettings(source))
    expect(parsed.conversations).toEqual([{ id: 'c1', messages: [] }])
  })

  it('never carries machine-bound or account-bound settings', () => {
    const raw = buildDataTransferFile(settings({
      workspace: 'D:\\secret-project',
      relaySiteId: 'solov',
      officialProviders: ['codex'],
      codexDesktopChineseRuntimePatch: 'enabled',
      codexDesktopInstallDisabled: true,
      hardwareAcceleration: false,
      windowState: { bounds: { x: 0, y: 0, width: 1200, height: 800 }, maximized: false },
    }), { conversations: [] }, new Date())
    for (const leaked of ['secret-project', 'relaySiteId', 'officialProviders', 'codexDesktop', 'hardwareAcceleration', 'windowState', 'workspace']) {
      expect(raw).not.toContain(leaked)
    }
  })

  it('refuses to write a file larger than the import limit', () => {
    const conversations = [{ text: 'x'.repeat(MAX_DATA_TRANSFER_BYTES) }]
    expect(() => buildDataTransferFile(settings(), { conversations }, new Date())).toThrow('64 MB')
  })

  it('rejects the whole file on any malformed part', () => {
    const valid = JSON.parse(buildDataTransferFile(settings(), { conversations: [] }, new Date()))
    const cases = [
      'not json',
      JSON.stringify([]),
      JSON.stringify({ ...valid, format: 'other' }),
      JSON.stringify({ ...valid, version: 0 }),
      JSON.stringify({ ...valid, settings: null }),
      JSON.stringify({ ...valid, settings: { ...valid.settings, theme: 'neon' } }),
      JSON.stringify({ ...valid, settings: { ...valid.settings, crashReporting: 'yes' } }),
      JSON.stringify({ ...valid, conversations: {} }),
      JSON.stringify({ ...valid, conversations: ['text'] }),
      JSON.stringify({ ...valid, conversations: Array.from({ length: 51 }, () => ({})) }),
    ]
    for (const raw of cases) expect(() => parseDataTransferFile(raw)).toThrow(dataTransferInvalidMessage)
  })

  it('asks for an update when the file comes from a newer format', () => {
    const valid = JSON.parse(buildDataTransferFile(settings(), { conversations: [] }, new Date()))
    expect(() => parseDataTransferFile(JSON.stringify({ ...valid, version: 2 }))).toThrow('更新到最新版')
  })

  it('ignores unknown settings and accepts missing ones', () => {
    const valid = JSON.parse(buildDataTransferFile(settings(), { conversations: [] }, new Date()))
    const parsed = parseDataTransferFile(JSON.stringify({ ...valid, settings: { theme: 'dark', apiKey: 'sk-should-not-matter' } }))
    expect(parsed.settings).toEqual({ theme: 'dark' })
  })

  it('validates the export request from the renderer', () => {
    expect(parseDataTransferExportInput({ conversations: [{ id: 'a' }] })).toEqual({ conversations: [{ id: 'a' }] })
    expect(() => parseDataTransferExportInput(null)).toThrow()
    expect(() => parseDataTransferExportInput({ conversations: [1] })).toThrow()
    expect(() => parseDataTransferExportInput({ conversations: Array.from({ length: 51 }, () => ({})) })).toThrow()
  })
})

describe('planPortableSettingsImport', () => {
  it('applies settings this computer never changed and asks about the ones it did', () => {
    const current = settings({ theme: 'dark', closeBehavior: 'quit' })
    const plan = planPortableSettingsImport(current, {
      theme: 'light',
      closeBehavior: 'tray',
      desktopNotifications: false,
      uiSkin: 'aurora',
      largeText: false,
    })
    expect(plan.settings).toEqual({ version: 2, desktopNotifications: false, uiSkin: 'aurora' })
    expect(plan.conflictingSettings).toEqual({ version: 2, theme: 'light', closeBehavior: 'tray' })
    expect(plan.conflictLabels).toEqual(['主题', '点关闭按钮时'])
  })

  it('treats a skin that follows the theme as untouched', () => {
    const plan = planPortableSettingsImport(settings({ uiSkin: undefined }), { uiSkin: 'obsidian' })
    expect(plan.settings).toEqual({ version: 2, uiSkin: 'obsidian' })
    expect(plan.conflictLabels).toEqual([])
  })

  it('has nothing to do when the file matches this computer', () => {
    const current = settings({ reducedMotion: true })
    const plan = planPortableSettingsImport(current, buildPortableSettings(current))
    expect(plan).toEqual({ settings: { version: 2 }, conflictingSettings: { version: 2 }, conflictLabels: [] })
  })
})

describe('export file names', () => {
  it('dates the transfer file', () => {
    expect(dataTransferFileName(new Date(2026, 8, 5))).toBe('星芒聊天记录与设置-2026-09-05.json')
  })

  it('keeps conversation titles from naming another directory', () => {
    expect(conversationFileName('..\\..\\Windows\\system32')).toBe('.. .. Windows system32.txt')
    expect(conversationFileName('a/b:c*?"<>|')).toBe('a b c.txt')
    expect(conversationFileName('   ')).toBe('星芒聊天记录.txt')
    expect(conversationFileName('...')).toBe('星芒聊天记录.txt')
    expect(conversationFileName('长'.repeat(100))).toBe(`${'长'.repeat(60)}.txt`)
  })

  it('validates the conversation text export', () => {
    expect(parseChatConversationExport({ title: 't', text: 'body' })).toEqual({ title: 't', text: 'body' })
    expect(() => parseChatConversationExport({ title: 1, text: 'body' })).toThrow()
    expect(() => parseChatConversationExport({ title: 't', text: 'x'.repeat(16 * 1024 * 1024 + 1) })).toThrow('16 MB')
  })
})
