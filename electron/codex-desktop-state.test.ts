import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectCodexDesktopGlobalState,
  normalizeCodexDesktopGlobalStateText,
  repairCodexDesktopGlobalState,
} from './codex-desktop-state'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex Desktop permission selector state', () => {
  it('repairs the legacy boolean without changing unrelated persisted state', () => {
    const input = JSON.stringify({
      version: 1,
      'electron-persisted-atom-state': {
        'composer-permission-mode-visibility': false,
        'unrelated-setting': 'keep',
      },
    })
    const result = normalizeCodexDesktopGlobalStateText(input)
    expect(result.changed).toBe(true)
    expect(result.needsRepair).toBe(true)
    const parsed = JSON.parse(result.content ?? '{}')
    expect(parsed.version).toBe(1)
    expect(parsed['electron-persisted-atom-state']['unrelated-setting']).toBe('keep')
    expect(parsed['electron-persisted-atom-state']['composer-permission-mode-visibility']).toEqual({
      'guardian-approvals': true,
      'full-access': true,
    })
  })

  it('preserves explicit visibility choices when only one legacy field is malformed', () => {
    const result = normalizeCodexDesktopGlobalStateText(JSON.stringify({
      'electron-persisted-atom-state': {
        'composer-permission-mode-visibility': { 'full-access': false },
      },
    }))
    expect(JSON.parse(result.content ?? '{}')['electron-persisted-atom-state']['composer-permission-mode-visibility'])
      .toEqual({ 'guardian-approvals': true, 'full-access': false })
  })

  it('treats an already migrated object and a missing state file as healthy', () => {
    const valid = JSON.stringify({
      'electron-persisted-atom-state': {
        'composer-permission-mode-visibility': { 'guardian-approvals': true, 'full-access': false },
      },
    })
    expect(normalizeCodexDesktopGlobalStateText(valid)).toMatchObject({ changed: false, needsRepair: false })
    expect(normalizeCodexDesktopGlobalStateText(null)).toMatchObject({ changed: false, needsRepair: false })
  })

  it('writes the repaired state atomically through the Codex Home safety boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-state-'))
    temporaryDirectories.push(root)
    const codexHome = path.join(root, '.codex')
    fs.mkdirSync(codexHome)
    const statePath = path.join(codexHome, '.codex-global-state.json')
    fs.writeFileSync(statePath, JSON.stringify({
      'electron-persisted-atom-state': { 'composer-permission-mode-visibility': false },
    }), 'utf8')

    expect(inspectCodexDesktopGlobalState(codexHome)).toMatchObject({ exists: true, needsRepair: true })
    const result = await repairCodexDesktopGlobalState(codexHome)
    expect(result).toMatchObject({ exists: true, needsRepair: false, changed: true, error: null })
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))['electron-persisted-atom-state']['composer-permission-mode-visibility'])
      .toEqual({ 'guardian-approvals': true, 'full-access': true })
    expect(inspectCodexDesktopGlobalState(codexHome)).toMatchObject({ exists: true, needsRepair: false })
  })
})
