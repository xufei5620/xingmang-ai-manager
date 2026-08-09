import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultAppSettings,
  readAppSettings,
  writeAppSettings,
  type AppSettings,
} from './app-settings'

const temporaryDirectories: string[] = []

function temporarySettingsPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-settings-test-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'settings.json')
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...defaultAppSettings('C:\\Users\\test'),
    ...overrides,
    version: 2,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('application settings persistence', () => {
  it('returns v2 defaults when neither primary nor backup exists', () => {
    const filePath = temporarySettingsPath()
    expect(readAppSettings(filePath, 'D:\\Workspace')).toEqual({
      version: 2,
      workspace: 'D:\\Workspace',
      theme: 'dark',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: false,
    })
  })

  it('migrates v1 and the legacy scanOnStartup field to v2', () => {
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      workspace: 'D:\\Legacy',
      theme: 'light',
      scanOnStartup: true,
    }), 'utf8')

    expect(readAppSettings(filePath)).toEqual({
      version: 2,
      workspace: 'D:\\Legacy',
      theme: 'light',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: true,
    })
  })

  it('preserves an explicit sidebarMoreExpanded: true across a read', () => {
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, JSON.stringify({
      version: 2,
      workspace: 'D:\\Workspace',
      theme: 'dark',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: false,
      sidebarMoreExpanded: true,
    }), 'utf8')

    expect(readAppSettings(filePath).sidebarMoreExpanded).toBe(true)
  })

  it('degrades a non-boolean sidebarMoreExpanded to the collapsed default instead of failing the read', () => {
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, JSON.stringify({
      version: 2,
      workspace: 'D:\\Workspace',
      theme: 'dark',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: false,
      sidebarMoreExpanded: 'yes',
    }), 'utf8')

    const result = readAppSettings(filePath)
    expect(result.sidebarMoreExpanded).toBeUndefined()
    expect(result.workspace).toBe('D:\\Workspace')
  })

  it('round-trips an explicit relaySiteId through a write and a read', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings({ relaySiteId: 'solov' }))

    expect(readAppSettings(filePath).relaySiteId).toBe('solov')
  })

  it('leaves relaySiteId absent when never set, matching pre-W2 behavior', () => {
    const filePath = temporarySettingsPath()
    expect(readAppSettings(filePath, 'D:\\Workspace').relaySiteId).toBeUndefined()
  })

  it('degrades an unknown relaySiteId to absent instead of failing the read', () => {
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, JSON.stringify({
      version: 2,
      workspace: 'D:\\Workspace',
      theme: 'dark',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: false,
      relaySiteId: 'sub2api-not-shipped-yet',
    }), 'utf8')

    const result = readAppSettings(filePath)
    expect(result.relaySiteId).toBeUndefined()
    expect(result.workspace).toBe('D:\\Workspace')
  })

  it('degrades a non-string relaySiteId to absent instead of failing the read', () => {
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, JSON.stringify({
      version: 2,
      workspace: 'D:\\Workspace',
      theme: 'dark',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: false,
      relaySiteId: 42,
    }), 'utf8')

    expect(readAppSettings(filePath).relaySiteId).toBeUndefined()
  })

  it('falls back to the last known-good backup when primary settings are damaged', () => {
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, '{not-json', 'utf8')
    fs.writeFileSync(`${filePath}.bak`, JSON.stringify({
      version: 2,
      workspace: 'D:\\Recovered',
      theme: 'light',
      checkUpdatesOnStartup: false,
      runDiagnosticsOnStartup: true,
    }), 'utf8')

    expect(readAppSettings(filePath)).toEqual(settings({
      workspace: 'D:\\Recovered',
      theme: 'light',
      checkUpdatesOnStartup: false,
      runDiagnosticsOnStartup: true,
    }))
  })

  it('keeps the original file readable when replacement is fault-injected', async () => {
    const filePath = temporarySettingsPath()
    const original = settings({ workspace: 'D:\\Original' })
    await writeAppSettings(filePath, original)

    await expect(writeAppSettings(
      filePath,
      settings({ workspace: 'D:\\Replacement', theme: 'light' }),
      { beforeReplace: () => { throw new Error('injected settings failure') } },
    )).rejects.toThrow('injected settings failure')

    expect(readAppSettings(filePath)).toEqual(original)
    expect(readAppSettings(`${filePath}.bak`)).toEqual(original)
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps exactly the previous valid settings in the last backup', async () => {
    const filePath = temporarySettingsPath()
    const first = settings({ workspace: 'D:\\First' })
    const second = settings({ workspace: 'D:\\Second', theme: 'light' })
    const third = settings({ workspace: 'D:\\Third', checkUpdatesOnStartup: false })

    await writeAppSettings(filePath, first)
    await writeAppSettings(filePath, second)
    await writeAppSettings(filePath, third)

    expect(readAppSettings(filePath)).toEqual(third)
    expect(readAppSettings(`${filePath}.bak`)).toEqual(second)
  })

  it('serializes writes to the same settings file', async () => {
    const filePath = temporarySettingsPath()
    const events: string[] = []
    let releaseFirst!: () => void
    let signalFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve })
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = writeAppSettings(filePath, settings({ workspace: 'D:\\First' }), {
      beforeReplace: async () => {
        events.push('first:start')
        signalFirstStarted()
        await firstGate
        events.push('first:end')
      },
    })
    await firstStarted
    const second = writeAppSettings(filePath, settings({ workspace: 'D:\\Second' }), {
      beforeReplace: () => { events.push('second') },
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])

    expect(events).toEqual(['first:start', 'first:end', 'second'])
    expect(readAppSettings(filePath).workspace).toBe('D:\\Second')
  })

  it('does not read or replace a hard-linked settings target', async () => {
    const filePath = temporarySettingsPath()
    const victim = path.join(path.dirname(filePath), 'victim.json')
    const original = `${JSON.stringify(settings({ workspace: 'D:\\Victim' }))}\n`
    fs.writeFileSync(victim, original, 'utf8')
    fs.linkSync(victim, filePath)

    expect(readAppSettings(filePath, 'D:\\SafeDefault').workspace).toBe('D:\\SafeDefault')
    await expect(writeAppSettings(
      filePath,
      settings({ workspace: 'D:\\Replacement' }),
    )).rejects.toThrow('单链接普通文件')
    expect(fs.readFileSync(victim, 'utf8')).toBe(original)
  })
})
