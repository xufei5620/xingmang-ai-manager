import { describe, expect, it } from 'vitest'
import { insertUpstreamMention, mentionQueryAt } from './PromptEditor'

describe('prompt upstream mentions', () => {
  it('opens only for a standalone @ token at the caret', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(mentionQueryAt('参考 @图片', 6)).toEqual({ start: 3, end: 6, query: '图片' })
    expect(mentionQueryAt('mail@example.com', 16)).toBeNull()
    expect(mentionQueryAt('@图片 后续', 6)).toBeNull()
  })

  it('replaces only the active query and leaves dependency state untouched', () => {
    const query = mentionQueryAt('参考 @图 生成', 5)
    expect(query).not.toBeNull()
    const inserted = insertUpstreamMention('参考 @图 生成', '@图片素材-图片-a1b2c3', query!)
    expect(inserted).toEqual({ value: '参考 @图片素材-图片-a1b2c3 生成', caret: 19 })
  })
})
