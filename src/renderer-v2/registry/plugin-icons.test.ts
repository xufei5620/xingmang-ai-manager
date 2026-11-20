import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { curatedExtensions } from './curated-extensions'
import { claudePluginBrands, codexPluginIcons, curatedPluginIcon, officialPluginIcon } from './plugin-icons'

const iconRoot = resolve('bundled-catalog/plugin-icons')
const index = JSON.parse(readFileSync(resolve(iconRoot, 'index.json'), 'utf8')) as {
  size: number
  icons: Record<string, { light: { file: string; sha256: string }; dark?: { file: string; sha256: string } }>
}

describe('plugin icons', () => {
  it('bundles every Codex icon the index lists, byte for byte', () => {
    expect(Object.keys(codexPluginIcons).sort()).toEqual(Object.keys(index.icons).sort())
    for (const [name, entry] of Object.entries(index.icons)) {
      for (const variant of [entry.light, entry.dark]) {
        if (!variant) continue
        const bytes = readFileSync(resolve(iconRoot, variant.file))
        expect(createHash('sha256').update(bytes).digest('hex'), variant.file).toBe(variant.sha256)
        // PNG 文件头：CSP 只放行本地图片，打包进去的只能是位图，不是 SVG。
        expect(bytes.subarray(0, 8).toString('hex'), variant.file).toBe('89504e470d0a1a0a')
      }
      expect(Boolean(codexPluginIcons[name]?.dark), name).toBe(Boolean(entry.dark))
    }
  })

  it('gives every curated entry its own icon', () => {
    for (const entry of curatedExtensions) expect(curatedPluginIcon(entry.id), entry.id).not.toBeNull()
  })

  it('maps official plugins by name and falls back to nothing for names it does not know', () => {
    expect(officialPluginIcon('codex', 'sentry')).toMatchObject({ type: 'image' })
    expect(officialPluginIcon('claude', 'supabase')).toMatchObject({ type: 'brand' })
    expect(officialPluginIcon('claude', 'security-guidance')).toMatchObject({ type: 'glyph' })
    expect(officialPluginIcon('codex', 'no-such-plugin')).toBeNull()
    expect(officialPluginIcon('claude', 'no-such-plugin')).toBeNull()
    for (const [name, icon] of Object.entries(claudePluginBrands)) expect(icon.path.length, name).toBeGreaterThan(0)
  })
})
