import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultAppSettings,
  mergeAppSettings,
  readAppSettings,
  setOfficialProvider,
  updateAppSettings,
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

  it('round-trips official provider markers and clears one without touching others', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings({ officialProviders: ['codex', 'gemini'] }))

    await setOfficialProvider(filePath, 'codex', false)

    expect(readAppSettings(filePath).officialProviders).toEqual(['gemini'])
  })

  it('serializes concurrent official provider updates against the latest settings', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings())

    await Promise.all([
      setOfficialProvider(filePath, 'codex', true),
      setOfficialProvider(filePath, 'gemini', true),
    ])

    expect(readAppSettings(filePath).officialProviders).toEqual(['codex', 'gemini'])
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

  it('round-trips a pinned mirrorPolicy through a write and a read', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings({ mirrorPolicy: 'official-first' }))

    expect(readAppSettings(filePath).mirrorPolicy).toBe('official-first')
  })

  it('degrades an unknown mirrorPolicy -- including a literal auto -- to absent', () => {
    // 'auto' is the UI's spelling for "no pin"; persisting it would freeze
    // today's default into the file. Only the two pinned values are stored.
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, JSON.stringify({
      version: 2,
      workspace: 'D:\\Workspace',
      theme: 'dark',
      checkUpdatesOnStartup: true,
      runDiagnosticsOnStartup: false,
      mirrorPolicy: 'auto',
    }), 'utf8')

    const result = readAppSettings(filePath)
    expect(result.mirrorPolicy).toBeUndefined()
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

describe('field-wise settings updates (①栏11)', () => {
  it('merges an update over the persisted record, leaving unmentioned fields alone', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings({
      relaySiteId: 'sub2api',
      mirrorPolicy: 'official-first',
      sidebarMoreExpanded: true,
    }))

    const merged = await updateAppSettings(filePath, { version: 2, theme: 'light' })

    expect(merged).toEqual(settings({
      theme: 'light',
      relaySiteId: 'sub2api',
      mirrorPolicy: 'official-first',
      sidebarMoreExpanded: true,
    }))
    expect(readAppSettings(filePath)).toEqual(merged)
  })

  it('merges into the defaults when no settings file exists yet', async () => {
    const filePath = temporarySettingsPath()

    const merged = await updateAppSettings(filePath, { version: 2, theme: 'light' }, {}, 'D:\\Home')

    expect(merged).toEqual({ ...defaultAppSettings('D:\\Home'), theme: 'light' })
    expect(readAppSettings(filePath, 'D:\\Home')).toEqual(merged)
  })

  it('clears the pinned mirrorPolicy via the explicit auto marker, and only via it', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings({ mirrorPolicy: 'mirror-first' }))

    // An unrelated update must keep the pinned policy...
    await updateAppSettings(filePath, { version: 2, theme: 'light' })
    expect(readAppSettings(filePath).mirrorPolicy).toBe('mirror-first')

    // ...and 'auto' must clear it back to the absent/probe default.
    const merged = await updateAppSettings(filePath, { version: 2, mirrorPolicy: 'auto' })
    expect(merged.mirrorPolicy).toBeUndefined()
    expect(readAppSettings(filePath)).not.toHaveProperty('mirrorPolicy')
  })

  it('clears sidebarMoreExpanded with an explicit false, back to the omitted default', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings({ sidebarMoreExpanded: true }))

    const merged = await updateAppSettings(filePath, { version: 2, sidebarMoreExpanded: false })

    expect(merged).not.toHaveProperty('sidebarMoreExpanded')
    expect(readAppSettings(filePath)).not.toHaveProperty('sidebarMoreExpanded')
  })

  it('lets two concurrent single-intent updates both survive, regardless of order', async () => {
    // The regression this whole feature exists for: update B is enqueued
    // while update A is still in flight, and B's merge base must be the
    // record A actually produced -- not the one both saw at call time.
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings())

    const first = updateAppSettings(filePath, { version: 2, relaySiteId: 'sub2api' })
    const second = updateAppSettings(filePath, { version: 2, sidebarMoreExpanded: true })
    await Promise.all([first, second])

    expect(readAppSettings(filePath)).toEqual(settings({
      relaySiteId: 'sub2api',
      sidebarMoreExpanded: true,
    }))
  })

  it('exposes the same merge as a pure function for the IPC layer to reuse', () => {
    const base = settings({ relaySiteId: 'solov', mirrorPolicy: 'mirror-first' })

    expect(mergeAppSettings(base, { version: 2 })).toEqual(base)
    expect(mergeAppSettings(base, { version: 2, relaySiteId: 'sub2api' }).relaySiteId).toBe('sub2api')
    expect(mergeAppSettings(base, { version: 2, mirrorPolicy: 'auto' })).not.toHaveProperty('mirrorPolicy')
    expect(mergeAppSettings(base, { version: 2, workspace: 'D:\\Elsewhere' }).workspace).toBe('D:\\Elsewhere')
  })
})

describe('UI and window preferences', () => {
  const windowState = { bounds: { x: -1500, y: 40, width: 1280, height: 820 }, maximized: true }

  it('keeps desktop notifications opt-in and clears a saved opt-in with an explicit false', async () => {
    const filePath = temporarySettingsPath()
    expect(readAppSettings(filePath)).not.toHaveProperty('desktopNotifications')
    await writeAppSettings(filePath, settings({ desktopNotifications: true, windowState }))
    expect(readAppSettings(filePath).desktopNotifications).toBe(true)
    await updateAppSettings(filePath, { version: 2, theme: 'light' })
    expect(readAppSettings(filePath).desktopNotifications).toBe(true)
    await updateAppSettings(filePath, { version: 2, desktopNotifications: false })
    expect(readAppSettings(filePath)).not.toHaveProperty('desktopNotifications')
    expect(readAppSettings(filePath).windowState).toEqual(windowState)
  })

  it('rejects malformed persisted notification preferences without discarding other settings', () => {
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, JSON.stringify({ ...settings({ uiSkin: 'mist' }), desktopNotifications: 'enabled' }), 'utf8')
    expect(readAppSettings(filePath)).toEqual(settings({ uiSkin: 'mist' }))
  })

  it('round-trips appearance, relative scale, closing preference and normal window bounds', async () => {
    const filePath = temporarySettingsPath()
    const next = settings({
      uiSkin: 'mist', reducedMotion: true, uiScale: '110', closeBehavior: 'tray', windowState,
    })
    await writeAppSettings(filePath, next)
    expect(readAppSettings(filePath)).toEqual(next)
  })

  it('keeps old v2 records valid without pinning new defaults', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings())
    const result = readAppSettings(filePath)
    expect(result).not.toHaveProperty('uiSkin')
    expect(result).not.toHaveProperty('uiScale')
    expect(result).not.toHaveProperty('closeBehavior')
    expect(result).not.toHaveProperty('windowState')
  })

  it('drops malformed optional UI fields without losing workspace or legacy preferences', () => {
    const filePath = temporarySettingsPath()
    fs.writeFileSync(filePath, JSON.stringify({
      ...settings({ workspace: 'D:\\Keep', officialProviders: ['claude'] }),
      uiSkin: 'unknown-skin', reducedMotion: 'true', uiScale: 110, closeBehavior: 'hide',
      windowState: { bounds: { x: 0, y: 0, width: -1, height: 820 }, maximized: true },
    }), 'utf8')
    expect(readAppSettings(filePath)).toEqual(settings({ workspace: 'D:\\Keep', officialProviders: ['claude'] }))
  })

  it('preserves preferences during unrelated writes and clears them only through explicit reset markers', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings({
      uiSkin: 'aurora', reducedMotion: true, uiScale: '100', closeBehavior: 'quit', windowState,
    }))
    await updateAppSettings(filePath, { version: 2, theme: 'light' })
    expect(readAppSettings(filePath)).toMatchObject({ uiSkin: 'aurora', reducedMotion: true, uiScale: '100', closeBehavior: 'quit', windowState })

    const reset = await updateAppSettings(filePath, {
      version: 2, uiSkin: 'auto', reducedMotion: false, uiScale: 'auto', closeBehavior: 'ask', windowState: null,
    })
    expect(reset).toEqual(settings({ theme: 'light' }))
    expect(readAppSettings(filePath)).toEqual(reset)
  })

  it('serializes window movement and appearance changes without reverting either writer', async () => {
    const filePath = temporarySettingsPath()
    await writeAppSettings(filePath, settings({ uiSkin: 'dawn' }))
    await Promise.all([
      updateAppSettings(filePath, { version: 2, windowState }),
      updateAppSettings(filePath, { version: 2, uiSkin: 'obsidian', reducedMotion: true }),
      updateAppSettings(filePath, { version: 2, uiScale: '90' }),
    ])
    expect(readAppSettings(filePath)).toEqual(settings({ uiSkin: 'obsidian', reducedMotion: true, uiScale: '90', windowState }))
  })

  it('retains confirmed preferences and the valid backup if an appearance update cannot be replaced', async () => {
    const filePath = temporarySettingsPath()
    const previous = settings({ uiSkin: 'mist', windowState })
    await writeAppSettings(filePath, previous)
    await expect(updateAppSettings(filePath, { version: 2, uiSkin: 'aurora' }, {
      beforeReplace: () => { throw new Error('appearance write failed') },
    })).rejects.toThrow('appearance write failed')
    expect(readAppSettings(filePath)).toEqual(previous)
    expect(readAppSettings(`${filePath}.bak`)).toEqual(previous)
  })
})
