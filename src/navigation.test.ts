import { describe, expect, it } from 'vitest'
import { navigationItems } from './navigation'

describe('navigation grouping', () => {
  it('assigns workbench, extensions, system and utility destinations', () => {
    expect(navigationItems.map(({ id, group }) => [id, group])).toEqual([
      ['overview', 'workbench'],
      ['sessions', 'workbench'],
      ['mcp', 'extensions'],
      ['skills', 'extensions'],
      ['plugins', 'extensions'],
      ['backups', 'system'],
      ['health', 'system'],
      ['maintenance', 'system'],
      ['feedback', 'utility'],
      ['updates', 'utility'],
      ['settings', 'utility'],
    ])
  })
})
