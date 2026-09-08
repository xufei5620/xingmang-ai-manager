import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlatformSettingsStore } from './settings-store'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
const target = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-platform-test-'))
  roots.push(root)
  return path.join(root, 'platform-settings.json')
}

describe('isolated platform-settings.json', () => {
  it('serializes independent fields and writes valid UTF-8 without touching legacy settings', async () => {
    const file = target()
    const legacy = path.join(path.dirname(file), 'settings.json')
    fs.writeFileSync(legacy, 'legacy sentinel', 'utf8')
    const store = new PlatformSettingsStore(file, 'dark')
    expect(store.read()).toEqual({
      version: 1,
      themePreference: 'dark',
      highContrast: false,
    })
    await Promise.all([
      store.update({ themePreference: 'system' }),
      store.update({ highContrast: true }),
    ])
    expect(store.read()).toEqual({
      version: 1,
      themePreference: 'system',
      highContrast: true,
    })
    expect(fs.readFileSync(legacy, 'utf8')).toBe('legacy sentinel')
    expect(fs.readFileSync(file).subarray(0, 3)).not.toEqual(
      Buffer.from([239, 187, 191]),
    )
  })
  it('preserves malformed and future-version files instead of overwriting them', async () => {
    for (const content of [
      '{not json',
      '{"version":2,"themePreference":"system","highContrast":false}',
    ]) {
      const file = target()
      fs.writeFileSync(file, content, 'utf8')
      const store = new PlatformSettingsStore(file)
      await expect(store.update({ highContrast: true })).rejects.toThrow()
      expect(fs.readFileSync(file, 'utf8')).toBe(content)
    }
  })
})
