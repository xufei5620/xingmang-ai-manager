import { describe, expect, it } from 'vitest'
import { applyPromptPresetOrder, buildPromptPresetMove, parseCanvasPromptPreset, parsePromptPresetOrder, promptPresetGroups, sortPromptPresets, type CanvasPromptPreset } from './prompt-preset-contract'

function preset(index: number, group = ''): CanvasPromptPreset { return { id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, name: `P${index}`, prompt: '正文', tags: [], provenance: 'user-created', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', group, version: 1, sortOrder: index } }
describe('personal prompt metadata contract', () => {
  it('retains supported metadata while accepting unchanged legacy records', () => {
    const item = preset(1), { group, version, sortOrder, ...legacy } = item
    expect(parseCanvasPromptPreset(legacy)).toEqual(legacy)
    expect(parseCanvasPromptPreset({ ...item, description: '完整简介', secret: 'ignored' })).toEqual({ ...item, description: '完整简介' })
    for (const patch of [{ group: 'x'.repeat(65) }, { description: 'x'.repeat(1001) }, { version: 0 }, { version: 1.2 }, { sortOrder: Infinity }, { group: 'a\nb' }]) expect(() => parseCanvasPromptPreset({ ...item, ...patch })).toThrow()
  })

  it('moves inside a group without moving intervening entries from other groups', () => {
    const items = [preset(1, 'A'), preset(2, 'B'), preset(3, 'A')]
    const move = buildPromptPresetMove(items, items[2].id, 'up', 'A')!
    expect(move.entries.map((item) => item.id)).toEqual([items[2].id, items[1].id, items[0].id])
    expect(move.entries.every((item) => item.expectedVersion === 1)).toBe(true)
    expect(buildPromptPresetMove(items, items[0].id, 'up', 'A')).toBeNull()
    expect(buildPromptPresetMove(items, items[2].id, 'down', 'A')).toBeNull()
    expect(items.map((item) => item.name)).toEqual(['P1', 'P2', 'P3'])
  })

  it('supports ungrouped entries and arbitrary literal group names without reserved collisions', () => {
    const items = [preset(1), preset(2, 'all'), preset(3, '__all__'), preset(4)]
    expect(promptPresetGroups(items)).toEqual(['__all__', 'all'])
    const move = buildPromptPresetMove(items, items[0].id, 'down', '')!
    expect(move.entries.map((item) => item.id)).toEqual([items[3].id, items[1].id, items[2].id, items[0].id])
  })

  it('applies compact receipts without changing full text and rejects a changed catalog', () => {
    const items = [preset(1), { ...preset(2), prompt: '长'.repeat(24000) }]
    const receipt = parsePromptPresetOrder([{ id: items[1].id, version: 2, sortOrder: 0 }, { id: items[0].id, version: 2, sortOrder: 1 }])
    const updated = applyPromptPresetOrder(items, receipt)
    expect(updated.map((item) => item.id)).toEqual([items[1].id, items[0].id])
    expect(updated[0].prompt).toBe(items[1].prompt)
    expect(items[1].version).toBe(1)
    expect(() => applyPromptPresetOrder(items.slice(0, 1), receipt)).toThrow('已变化')
    expect(() => parsePromptPresetOrder([...receipt, receipt[0]])).toThrow('重复')
    expect(() => parsePromptPresetOrder([{ ...receipt[0], sortOrder: 500 }])).toThrow('不完整')
    expect(() => applyPromptPresetOrder(updated.map((item) => ({ ...item, version: 3 })), receipt)).toThrow('过期')
    expect(applyPromptPresetOrder(updated, receipt)).toEqual(updated)
  })

  it('uses manual order independently from later edit timestamps', () => {
    const items = [preset(1), { ...preset(2), updatedAt: '2026-10-15T00:00:00Z' }]
    expect(sortPromptPresets(items).map((item) => item.name)).toEqual(['P1', 'P2'])
    expect(sortPromptPresets([{ ...items[0], sortOrder: undefined }, { ...items[1], sortOrder: undefined }]).map((item) => item.name)).toEqual(['P2', 'P1'])
  })
})
