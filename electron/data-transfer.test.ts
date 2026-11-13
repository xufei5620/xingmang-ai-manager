import { describe, expect, it } from 'vitest'
import type { AppSettings } from './app-settings'
import {
  buildDataTransferFile,
  buildPortableSettings,
  conversationFileName,
  dataTransferBusyMessage,
  dataTransferFileName,
  dataTransferInvalidMessage,
  dataTransferReadFailureMessage,
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
      JSON.stringify({ ...valid, conversations: Array.from({ length: 201 }, () => ({})) }),
    ]
    for (const raw of cases) expect(() => parseDataTransferFile(raw)).toThrow(dataTransferInvalidMessage)
  })

  it('asks for an update when the file comes from a newer format', () => {
    const valid = JSON.parse(buildDataTransferFile(settings(), { conversations: [] }, new Date()))
    expect(() => parseDataTransferFile(JSON.stringify({ ...valid, version: 2 }))).toThrow('更新到最新版')
  })

  it('reads a file that Notepad saved with a byte order mark', () => {
    // X-7：老记事本「另存为 UTF-8」会在开头加 BOM，以前整份被当成坏文件。
    const raw = buildDataTransferFile(settings({ theme: 'dark' }), { conversations: [{ id: 'c1' }] }, new Date())
    const parsed = parseDataTransferFile(`\uFEFF${raw}`)
    expect(parsed.settings.theme).toBe('dark')
    expect(parsed.conversations).toEqual([{ id: 'c1' }])
    // 只去开头那一个：中间冒出来的照旧是坏文件。
    expect(() => parseDataTransferFile(`\uFEFF\uFEFF${raw}`)).toThrow(dataTransferInvalidMessage)
  })

  it('tells a file another program holds apart from one that cannot be imported', () => {
    // X-7：被杀毒软件扫着、没权限读，以前也说「不是星芒导出的，或者已经损坏」。
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      expect(dataTransferReadFailureMessage(Object.assign(new Error(`${code}: open`), { code }))).toBe(dataTransferBusyMessage)
    }
    for (const error of [
      new Error('聊天记录与设置文件超过 65536 KB 安全上限'),
      new Error('聊天记录与设置文件必须是单链接普通文件'),
      new Error('聊天记录与设置文件不能经过符号链接或目录联接'),
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
      Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' }),
      'EBUSY',
      null,
    ]) {
      expect(dataTransferReadFailureMessage(error)).toBe(dataTransferInvalidMessage)
    }
  })

  it('ignores unknown settings and accepts missing ones', () => {
    const valid = JSON.parse(buildDataTransferFile(settings(), { conversations: [] }, new Date()))
    const parsed = parseDataTransferFile(JSON.stringify({ ...valid, settings: { theme: 'dark', apiKey: 'sk-should-not-matter' } }))
    expect(parsed.settings).toEqual({ theme: 'dark' })
  })

  it('validates the export request from the renderer', () => {
    expect(parseDataTransferExportInput({ conversations: [{ id: 'a' }] })).toEqual({ conversations: [{ id: 'a' }], phrases: [] })
    expect(() => parseDataTransferExportInput(null)).toThrow()
    expect(() => parseDataTransferExportInput({ conversations: [1] })).toThrow()
    expect(parseDataTransferExportInput({ conversations: Array.from({ length: 200 }, () => ({})) }).conversations).toHaveLength(200)
    expect(() => parseDataTransferExportInput({ conversations: Array.from({ length: 201 }, () => ({})) })).toThrow()
  })

  it('carries saved chat phrases and leaves them out when there are none', () => {
    const raw = buildDataTransferFile(settings(), { conversations: [], phrases: ['回答尽量简短', '翻译成英文'] }, new Date())
    expect(parseDataTransferFile(raw).phrases).toEqual(['回答尽量简短', '翻译成英文'])
    expect(JSON.parse(buildDataTransferFile(settings(), { conversations: [], phrases: [] }, new Date()))).not.toHaveProperty('phrases')
  })

  it('reads a file from before saved phrases existed as having none', () => {
    const valid = JSON.parse(buildDataTransferFile(settings(), { conversations: [] }, new Date()))
    expect(valid).not.toHaveProperty('phrases')
    expect(parseDataTransferFile(JSON.stringify(valid)).phrases).toEqual([])
  })

  it('rejects a file whose phrases are not a short list of short strings', () => {
    const valid = JSON.parse(buildDataTransferFile(settings(), { conversations: [] }, new Date()))
    for (const phrases of ['回答尽量简短', [42], [{ text: 'x' }], ['x'.repeat(2_001)], Array.from({ length: 31 }, () => 'x')]) {
      expect(() => parseDataTransferFile(JSON.stringify({ ...valid, phrases }))).toThrow(dataTransferInvalidMessage)
    }
    expect(parseDataTransferFile(JSON.stringify({ ...valid, phrases: Array.from({ length: 30 }, () => 'x'.repeat(2_000)) })).phrases).toHaveLength(30)
  })

  it('carries the usage-stats switch only when this computer could read it', () => {
    // X-3：「匿名使用统计」在系统界面设置那份文件里，以前不跟着走。
    for (const anonymousUsage of [true, false]) {
      const raw = buildDataTransferFile(settings(), { conversations: [] }, new Date(), anonymousUsage)
      expect(JSON.parse(raw).settings.anonymousUsage).toBe(anonymousUsage)
      expect(parseDataTransferFile(raw).anonymousUsage).toBe(anonymousUsage)
    }
    for (const unreadable of [null, undefined]) {
      const raw = buildDataTransferFile(settings(), { conversations: [] }, new Date(), unreadable)
      expect(JSON.parse(raw).settings).not.toHaveProperty('anonymousUsage')
      expect(parseDataTransferFile(raw)).not.toHaveProperty('anonymousUsage')
    }
  })

  it('rejects the whole file when the usage-stats switch is not a plain on or off', () => {
    const valid = JSON.parse(buildDataTransferFile(settings(), { conversations: [] }, new Date(), false))
    for (const anonymousUsage of ['false', 0, 1, null, {}, []]) {
      expect(() => parseDataTransferFile(JSON.stringify({ ...valid, settings: { ...valid.settings, anonymousUsage } }))).toThrow(dataTransferInvalidMessage)
    }
  })

  it('validates the phrases in the export request from the renderer', () => {
    expect(parseDataTransferExportInput({ conversations: [], phrases: ['回答尽量简短'] }).phrases).toEqual(['回答尽量简短'])
    expect(() => parseDataTransferExportInput({ conversations: [], phrases: 'x' })).toThrow('导出的常用的话格式无效')
    expect(() => parseDataTransferExportInput({ conversations: [], phrases: [1] })).toThrow('导出的常用的话格式无效')
    expect(() => parseDataTransferExportInput({ conversations: [], phrases: Array.from({ length: 31 }, () => 'x') })).toThrow('导出的常用的话格式无效')
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

  it('never asks about the skin, which the settings page no longer shows, and keeps one chosen here', () => {
    const plan = planPortableSettingsImport(settings({ uiSkin: 'obsidian' }), { uiSkin: 'aurora', theme: 'dark' })
    expect(plan.settings).toEqual({ version: 2, theme: 'dark' })
    expect(plan.conflictingSettings).toEqual({ version: 2 })
    expect(plan.conflictLabels).toEqual([])
  })

  it('treats a skin that follows the theme as untouched', () => {
    const plan = planPortableSettingsImport(settings({ uiSkin: undefined }), { uiSkin: 'obsidian' })
    expect(plan.settings).toEqual({ version: 2, uiSkin: 'obsidian' })
    expect(plan.conflictLabels).toEqual([])
  })

  it('switches usage stats off silently only while this computer still has the fresh-install on', () => {
    const plan = planPortableSettingsImport(settings(), { crashReporting: false }, { here: true, incoming: false })
    expect(plan).toEqual({
      settings: { version: 2, crashReporting: false },
      conflictingSettings: { version: 2 },
      conflictLabels: [],
      anonymousUsage: false,
    })
  })

  it('asks before an import switches usage stats back on here', () => {
    const plan = planPortableSettingsImport(settings({ theme: 'dark' }), { theme: 'light' }, { here: false, incoming: true })
    expect(plan).toEqual({
      settings: { version: 2 },
      conflictingSettings: { version: 2, theme: 'light' },
      conflictLabels: ['主题', '匿名使用统计'],
      conflictingAnonymousUsage: true,
    })
  })

  it('leaves usage stats alone for old files, matching values and an unreadable switch here', () => {
    const cases: Array<{ here: boolean | null; incoming?: boolean }> = [
      { here: false },
      { here: true },
      { here: false, incoming: false },
      { here: true, incoming: true },
      { here: null, incoming: false },
      { here: null, incoming: true },
    ]
    for (const anonymousUsage of cases) {
      expect(planPortableSettingsImport(settings(), {}, anonymousUsage)).toEqual({ settings: { version: 2 }, conflictingSettings: { version: 2 }, conflictLabels: [] })
    }
    expect(planPortableSettingsImport(settings(), {})).toEqual({ settings: { version: 2 }, conflictingSettings: { version: 2 }, conflictLabels: [] })
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
