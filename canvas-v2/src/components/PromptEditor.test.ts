import { describe, expect, it } from 'vitest'
import { insertUpstreamMention, mentionQueryAt } from './PromptEditor'
import { clipPromptEditorValue, dataTransferHasPromptMention, deleteAtomicMention, ensureMentionThumbSlots, insertMentionAt, mentionDisplayName, mentionRenderParts, mentionThumbSlot, promptEditorMaxLength, promptMentionMime, splitPromptSegments } from './prompt-mentions'
import type { UpstreamMediaReference } from './upstream-references'

describe('prompt upstream mentions', () => {
  it('opens only for a standalone @ token at the caret', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(mentionQueryAt('参考 @图片', 6)).toEqual({ start: 3, end: 6, query: '图片' })
    expect(mentionQueryAt('mail@example.com', 16)).toBeNull()
    expect(mentionQueryAt('@图片 后续', 6)).toBeNull()
    expect(mentionQueryAt('@图像节点-图片-6o35d6', 15)).toBeNull()
    expect(mentionQueryAt('参考 @图像节点-图片-6o35d6', 18)).toBeNull()
  })

  it('replaces only the active query and leaves dependency state untouched', () => {
    const query = mentionQueryAt('参考 @图 生成', 5)
    expect(query).not.toBeNull()
    const inserted = insertUpstreamMention('参考 @图 生成', '@图片素材-图片-a1b2c3', query!)
    expect(inserted).toEqual({ value: `参考 @图片素材-图片-a1b2c3${mentionThumbSlot} 生成`, caret: 20 })
  })

  it('splits mention tokens and attaches the matching upstream reference', () => {
    const reference: UpstreamMediaReference = {
      edgeId: 'e1',
      sourceNodeId: 'n1',
      kind: 'image',
      label: '角色设定',
      mention: '@图像节点-图片-6o35d6',
      relationLabel: '图像输入',
      status: 'ready',
    }
    expect(splitPromptSegments('用 @图像节点-图片-6o35d6 生成侧面', [reference])).toEqual([
      { type: 'text', text: '用 ' },
      { type: 'mention', text: '@图像节点-图片-6o35d6', kind: 'image', reference },
      { type: 'text', text: ' 生成侧面' },
    ])
    expect(splitPromptSegments(`用 @图像节点-图片-6o35d6${mentionThumbSlot}哒`, [reference])).toEqual([
      { type: 'text', text: '用 ' },
      { type: 'mention', text: '@图像节点-图片-6o35d6', kind: 'image', reference },
      { type: 'text', text: '哒' },
    ])
    expect(mentionDisplayName({ type: 'mention', text: '@图像节点-图片-6o35d6', kind: 'image', reference })).toBe('角色设定')
    expect(mentionRenderParts('@图像节点-图片-6o35d6')).toEqual({ marker: '@', rest: '图像节点-图片-6o35d6' })
    expect(splitPromptSegments('台词，@图像节点-图片-6o35d6神态松弛', [reference])).toEqual([
      { type: 'text', text: '台词，' },
      { type: 'mention', text: '@图像节点-图片-6o35d6', kind: 'image', reference },
      { type: 'text', text: '神态松弛' },
    ])
    expect(splitPromptSegments('裸 @未知引用 留下', [])).toEqual([
      { type: 'text', text: '裸 ' },
      { type: 'mention', text: '@未知引用' },
      { type: 'text', text: ' 留下' },
    ])
  })

  it('inserts a dragged mention at the drop index and pads it with spaces', () => {
    expect(insertMentionAt('你好世界', '@图像节点-图片-6o35d6', 2)).toEqual({
      value: `你好 @图像节点-图片-6o35d6${mentionThumbSlot} 世界`,
      caret: 21,
    })
    expect(insertMentionAt('你好 ', '@图像节点-图片-6o35d6', 3)).toEqual({
      value: `你好 @图像节点-图片-6o35d6${mentionThumbSlot} `,
      caret: 21,
    })
    expect(insertMentionAt('', '@图像节点-图片-6o35d6', 0)).toEqual({
      value: `@图像节点-图片-6o35d6${mentionThumbSlot} `,
      caret: 18,
    })
    expect(dataTransferHasPromptMention([promptMentionMime, 'text/plain'])).toBe(true)
    expect(dataTransferHasPromptMention(['text/plain'])).toBe(false)
    expect(promptEditorMaxLength).toBe(10_000)
    expect(clipPromptEditorValue('a'.repeat(10_001), 10_001)).toEqual({ value: 'a'.repeat(10_000), caret: 10_000 })
  })

  it('deletes a known mention as one token from either side or the middle', () => {
    const reference: UpstreamMediaReference = {
      edgeId: 'e1',
      sourceNodeId: 'n1',
      kind: 'image',
      label: '角色设定',
      mention: '@图像节点-图片-6o35d6',
      relationLabel: '图像输入',
      status: 'ready',
    }
    const value = '台词，@图像节点-图片-6o35d6神态松弛'
    expect(deleteAtomicMention(value, 18, 18, 'backward', [reference])).toEqual({
      value: '台词，神态松弛',
      caret: 3,
    })
    expect(deleteAtomicMention(value, 3, 3, 'forward', [reference])).toEqual({
      value: '台词，神态松弛',
      caret: 3,
    })
    expect(deleteAtomicMention(value, 10, 10, 'backward', [reference])).toEqual({
      value: '台词，神态松弛',
      caret: 3,
    })
    expect(deleteAtomicMention(value, 19, 19, 'backward', [])).toBeNull()
    expect(deleteAtomicMention('参考 @图', 4, 4, 'backward', [reference])).toBeNull()
    expect(deleteAtomicMention(`台词，@图像节点-图片-6o35d6${mentionThumbSlot}哒`, 20, 20, 'backward', [reference])).toEqual({
      value: '台词，哒',
      caret: 3,
    })
  })

  it('reserves a same-line thumb slot after each completed mention', () => {
    const reference: UpstreamMediaReference = {
      edgeId: 'e1',
      sourceNodeId: 'n1',
      kind: 'image',
      label: '角色设定',
      mention: '@图像节点-图片-6o35d6',
      relationLabel: '图像输入',
      status: 'ready',
    }
    expect(ensureMentionThumbSlots('@图像节点-图片-6o35d6哒', 16, [reference])).toEqual({
      value: `@图像节点-图片-6o35d6${mentionThumbSlot}哒`,
      caret: 18,
    })
    expect(ensureMentionThumbSlots(`@图像节点-图片-6o35d6${mentionThumbSlot}哒`, 18, [reference])).toEqual({
      value: `@图像节点-图片-6o35d6${mentionThumbSlot}哒`,
      caret: 18,
    })
  })
})
