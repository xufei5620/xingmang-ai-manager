import { describe, expect, it } from 'vitest'
import { promptExcerpt, searchCanvasNodes, type SearchableNode } from './node-search'

const nodes: SearchableNode[] = [
  { id: 'a', title: '图像生成', kind: 'image-generate', prompt: '一只黑猫坐在窗台上', model: 'gpt-image-2' },
  { id: 'b', title: '输出', kind: 'output' },
  { id: 'c', title: '提示词', kind: 'prompt', prompt: '把猫换成狗' },
  { id: 'd', title: '视频生成', kind: 'video-generate', model: 'grok-imagine-video' },
]

describe('searchCanvasNodes', () => {
  it('returns nothing for an empty query rather than everything', () => {
    expect(searchCanvasNodes(nodes, '')).toEqual([])
    expect(searchCanvasNodes(nodes, '   ')).toEqual([])
  })

  it('ranks a title match above a prompt match', () => {
    const hits = searchCanvasNodes(nodes, '提示词')
    expect(hits[0].id).toBe('c')
  })

  it('finds nodes by prompt content', () => {
    expect(searchCanvasNodes(nodes, '黑猫').map((hit) => hit.id)).toEqual(['a'])
  })

  it('finds nodes by model id, case insensitively', () => {
    expect(searchCanvasNodes(nodes, 'GROK').map((hit) => hit.id)).toEqual(['d'])
  })

  it('prefers a prefix title match over a substring one', () => {
    const hits = searchCanvasNodes([
      { id: 'x', title: '生成视频', kind: 'video-generate' },
      { id: 'y', title: '视频生成', kind: 'video-generate' },
    ], '视频')
    expect(hits[0].id).toBe('y')
  })

  it('reports why a prompt match matched', () => {
    expect(searchCanvasNodes(nodes, '黑猫')[0].detail).toContain('黑猫')
  })

  it('honours the result limit', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `n${index}`, title: '图像生成', kind: 'image-generate' }))
    expect(searchCanvasNodes(many, '图像', 5)).toHaveLength(5)
  })

  it('matches a node only once even when several fields contain the query', () => {
    const hits = searchCanvasNodes([{ id: 'a', title: '猫', kind: 'prompt', prompt: '猫猫猫', model: '猫' }], '猫')
    expect(hits).toHaveLength(1)
  })
})

describe('promptExcerpt', () => {
  it('windows around the match and marks both elisions', () => {
    const excerpt = promptExcerpt('0123456789'.repeat(6), '5', 3)
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).toContain('5')
  })

  it('omits the leading ellipsis when the match is at the start', () => {
    expect(promptExcerpt('猫在窗台上晒太阳打盹儿', '猫', 4).startsWith('…')).toBe(false)
  })

  it('falls back to the head of the prompt when the needle is absent', () => {
    expect(promptExcerpt('abcdef', 'zz', 2)).toBe('abcd')
  })
})
