import { describe, expect, it } from 'vitest'
import { navigationItems } from './navigation'

describe('navigation grouping', () => {
  it('keeps help and settings reachable outside the more menu', () => {
    expect(navigationItems.map(({ id, group }) => [id, group])).toEqual([
      ['overview', 'use'],
      ['chat', 'use'],
      ['sessions', 'use'],
      ['canvas', 'use'],
      ['mcp', 'extensions'],
      ['skills', 'extensions'],
      ['plugins', 'extensions'],
      ['backups', 'more'],
      ['health', 'support'],
      ['maintenance', 'more'],
      ['feedback', 'more'],
      ['tutorial', 'support'],
      ['updates', 'more'],
      ['settings', 'support'],
    ])
  })

  it('gives canvas a hint but no longer marks it as a placeholder (阶段 C: opens a real isolated window)', () => {
    const canvas = navigationItems.find((item) => item.id === 'canvas')
    expect(canvas?.placeholder).toBeUndefined()
    expect(canvas?.hint).toBeTruthy()
  })

  it('gives the MCP, Skills and plugin marketplace items a one-line hint', () => {
    const hinted = navigationItems.filter((item) => ['mcp', 'skills', 'plugins'].includes(item.id))
    expect(hinted).toHaveLength(3)
    for (const item of hinted) {
      expect(item.hint).toBeTruthy()
      expect(item.placeholder).toBeUndefined()
    }
  })

  it('labels the plugin item in beginner language', () => {
    expect(navigationItems.find((item) => item.id === 'plugins')?.label).toBe('插件')
  })

  it('does not mark any item as a placeholder', () => {
    const placeholders = navigationItems.filter((item) => item.placeholder)
    expect(placeholders).toEqual([])
  })
})
