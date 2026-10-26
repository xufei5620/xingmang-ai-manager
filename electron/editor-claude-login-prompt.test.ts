import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'jsonc-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildEditorSettingsWithLoginPromptDisabled,
  editorClaudeLoginPromptSetting,
  ensureEditorClaudeLoginPromptDisabled,
  resolveEditorSettingsLocations,
} from './editor-claude-login-prompt'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function added(existing: string | null): string {
  const edit = buildEditorSettingsWithLoginPromptDisabled(existing)
  if (edit.kind !== 'add') throw new Error(`expected an added setting, got ${edit.kind}`)
  return edit.content
}

describe('buildEditorSettingsWithLoginPromptDisabled', () => {
  it('writes a settings file holding only the setting when there is none yet', () => {
    expect(added(null)).toBe('{\n    "claudeCode.disableLoginPrompt": true\n}\n')
    expect(added('  \n')).toBe('{\n    "claudeCode.disableLoginPrompt": true\n}\n')
  })

  it('adds the setting next to the customer\'s own and keeps every comment and trailing comma', () => {
    const existing = [
      '{',
      '    // 字体大一点',
      '    "editor.fontSize": 16,',
      '    /* 主题 */',
      '    "workbench.colorTheme": "Default Dark Modern",',
      '}',
      '',
    ].join('\n')

    const content = added(existing)

    expect(content).toContain('// 字体大一点')
    expect(content).toContain('/* 主题 */')
    expect(content).toContain('    "claudeCode.disableLoginPrompt": true')
    expect(parse(content, [], { allowTrailingComma: true })).toEqual({
      'editor.fontSize': 16,
      'workbench.colorTheme': 'Default Dark Modern',
      'claudeCode.disableLoginPrompt': true,
    })
  })

  it('follows the file\'s tabs, Windows line endings and byte order mark', () => {
    const content = added('﻿{\r\n\t"files.autoSave": "afterDelay"\r\n}\r\n')

    expect(content).toBe('﻿{\r\n\t"files.autoSave": "afterDelay",\r\n\t"claudeCode.disableLoginPrompt": true\r\n}\r\n')
  })

  it.each([
    ['turned off by the customer', '{ "claudeCode.disableLoginPrompt": false }'],
    ['already on', '{ "claudeCode.disableLoginPrompt": true }'],
    ['written as a nested object', '{ "claudeCode": { "disableLoginPrompt": false } }'],
  ])('leaves a setting that is %s alone', (_label, existing) => {
    expect(buildEditorSettingsWithLoginPromptDisabled(existing)).toEqual({ kind: 'present' })
  })

  it('still adds the setting when other Claude Code extension settings are nested', () => {
    const content = added('{ "claudeCode": { "useTerminal": true } }')

    expect(parse(content)).toEqual({ claudeCode: { useTerminal: true }, 'claudeCode.disableLoginPrompt': true })
  })

  it.each([
    ['cannot be parsed', '{ "editor.fontSize": 16 "oops": 1 }'],
    ['is cut off', '{ "editor.fontSize": '],
    ['is a list', '[]'],
    ['is a plain value', 'true'],
  ])('does not touch a settings file that %s', (_label, existing) => {
    expect(buildEditorSettingsWithLoginPromptDisabled(existing)).toEqual({ kind: 'unreadable' })
  })
})

describe('resolveEditorSettingsLocations', () => {
  const home = path.resolve('fixture-home')

  it.each([
    ['win32', path.join(home, 'AppData', 'Roaming')],
    ['darwin', path.join(home, 'Library', 'Application Support')],
    ['linux', path.join(home, '.config')],
  ] as const)('puts VS Code and Cursor user settings where each editor keeps them on %s', (platform, base) => {
    expect(resolveEditorSettingsLocations({ platform, userHome: home, env: {} })).toEqual([
      { editor: 'vscode', userDirectory: path.join(base, 'Code', 'User'), settingsPath: path.join(base, 'Code', 'User', 'settings.json') },
      { editor: 'cursor', userDirectory: path.join(base, 'Cursor', 'User'), settingsPath: path.join(base, 'Cursor', 'User', 'settings.json') },
    ])
  })

  it('follows APPDATA and XDG_CONFIG_HOME when they are absolute directories and ignores them otherwise', () => {
    const elsewhere = path.resolve('elsewhere')

    expect(resolveEditorSettingsLocations({ platform: 'win32', userHome: home, env: { APPDATA: elsewhere } })[0].userDirectory)
      .toBe(path.join(elsewhere, 'Code', 'User'))
    expect(resolveEditorSettingsLocations({ platform: 'linux', userHome: home, env: { XDG_CONFIG_HOME: elsewhere } })[1].userDirectory)
      .toBe(path.join(elsewhere, 'Cursor', 'User'))
    expect(resolveEditorSettingsLocations({ platform: 'linux', userHome: home, env: { XDG_CONFIG_HOME: 'relative' } })[0].userDirectory)
      .toBe(path.join(home, '.config', 'Code', 'User'))
  })

  it('never reads the operator\'s own environment for a home that is not the real one', () => {
    vi.stubEnv('APPDATA', path.resolve('operator-appdata'))
    vi.stubEnv('XDG_CONFIG_HOME', path.resolve('operator-config'))

    expect(resolveEditorSettingsLocations({ platform: 'win32', userHome: home })[0].userDirectory)
      .toBe(path.join(home, 'AppData', 'Roaming', 'Code', 'User'))
    expect(resolveEditorSettingsLocations({ platform: 'linux', userHome: home })[0].userDirectory)
      .toBe(path.join(home, '.config', 'Code', 'User'))
  })
})

describe('ensureEditorClaudeLoginPromptDisabled', () => {
  function fixture() {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-editor-login-'))
    temporaryDirectories.push(userHome)
    const options = { platform: 'linux' as const, userHome, env: {} }
    const [vscode, cursor] = resolveEditorSettingsLocations(options)
    return { userHome, options, vscode, cursor }
  }

  function setting(settingsPath: string): unknown {
    return parse(fs.readFileSync(settingsPath, 'utf8'), [], { allowTrailingComma: true })[editorClaudeLoginPromptSetting]
  }

  it('does nothing for an editor that has never been opened on this computer', () => {
    const f = fixture()

    expect(ensureEditorClaudeLoginPromptDisabled(f.options)).toEqual([
      { editor: 'vscode', outcome: 'absent' },
      { editor: 'cursor', outcome: 'absent' },
    ])
    expect(fs.readdirSync(f.userHome)).toEqual([])
  })

  it('adds the setting to an opened editor, keeps a backup and leaves the other editor alone', () => {
    const f = fixture()
    fs.mkdirSync(f.vscode.userDirectory, { recursive: true })
    const original = '{\n    // 客户自己的设置\n    "editor.fontSize": 16\n}\n'
    fs.writeFileSync(f.vscode.settingsPath, original)

    const [vscode, cursor] = ensureEditorClaudeLoginPromptDisabled(f.options)

    expect(vscode).toMatchObject({ editor: 'vscode', outcome: 'added' })
    expect(cursor).toEqual({ editor: 'cursor', outcome: 'absent' })
    expect(setting(f.vscode.settingsPath)).toBe(true)
    expect(fs.readFileSync(f.vscode.settingsPath, 'utf8')).toContain('// 客户自己的设置')
    const backups = vscode.outcome === 'added' ? vscode.backups : []
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(backups[0], 'utf8')).toBe(original)
    expect(fs.existsSync(path.dirname(f.cursor.userDirectory))).toBe(false)
  })

  it('creates the settings file in an opened editor that has none yet', () => {
    const f = fixture()
    fs.mkdirSync(f.cursor.userDirectory, { recursive: true })

    expect(ensureEditorClaudeLoginPromptDisabled(f.options)[1]).toEqual({ editor: 'cursor', outcome: 'added', backups: [] })
    expect(setting(f.cursor.settingsPath)).toBe(true)
  })

  it('leaves a customer\'s choice and an unreadable file exactly as they were', () => {
    const f = fixture()
    fs.mkdirSync(f.vscode.userDirectory, { recursive: true })
    fs.mkdirSync(f.cursor.userDirectory, { recursive: true })
    fs.writeFileSync(f.vscode.settingsPath, '{ "claudeCode.disableLoginPrompt": false }')
    fs.writeFileSync(f.cursor.settingsPath, '{ "editor.fontSize": ')

    expect(ensureEditorClaudeLoginPromptDisabled(f.options)).toEqual([
      { editor: 'vscode', outcome: 'present' },
      { editor: 'cursor', outcome: 'unreadable' },
    ])
    expect(fs.readFileSync(f.vscode.settingsPath, 'utf8')).toBe('{ "claudeCode.disableLoginPrompt": false }')
    expect(fs.readFileSync(f.cursor.settingsPath, 'utf8')).toBe('{ "editor.fontSize": ')
    expect(fs.readdirSync(f.cursor.userDirectory)).toEqual(['settings.json'])
  })

  it('refuses a linked settings file and still fixes the other editor', () => {
    const f = fixture()
    fs.mkdirSync(f.vscode.userDirectory, { recursive: true })
    fs.mkdirSync(f.cursor.userDirectory, { recursive: true })
    const elsewhere = path.join(f.userHome, 'elsewhere.json')
    fs.writeFileSync(elsewhere, '{}')
    fs.linkSync(elsewhere, f.vscode.settingsPath)

    const [vscode, cursor] = ensureEditorClaudeLoginPromptDisabled(f.options)

    expect(vscode).toMatchObject({ editor: 'vscode', outcome: 'failed' })
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('{}')
    expect(cursor).toMatchObject({ editor: 'cursor', outcome: 'added' })
    expect(setting(f.cursor.settingsPath)).toBe(true)
  })

  it('backs off when the editor saves its own change just before the write lands', () => {
    const f = fixture()
    fs.mkdirSync(f.vscode.userDirectory, { recursive: true })
    fs.writeFileSync(f.vscode.settingsPath, '{}')
    const customer = '{ "editor.fontSize": 18 }'

    const [vscode] = ensureEditorClaudeLoginPromptDisabled(f.options, {
      beforeReplace() { fs.writeFileSync(f.vscode.settingsPath, customer) },
    })

    expect(vscode).toMatchObject({ editor: 'vscode', outcome: 'failed' })
    expect(fs.readFileSync(f.vscode.settingsPath, 'utf8')).toBe(customer)
  })
})
