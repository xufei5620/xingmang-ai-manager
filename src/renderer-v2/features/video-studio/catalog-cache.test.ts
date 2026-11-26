import { describe, expect, it } from 'vitest'
import type { AiChatGroupSummary } from '../../../../electron/ipc-contract'
import { createVideoStudioCatalogCache, videoStudioCatalogMaxAgeMs, type VideoStudioCatalog } from './catalog-cache'

const groups: AiChatGroupSummary[] = [{ name: 'default', description: '', ratio: 1 }, { name: '图片模型', description: '', ratio: 2 }]
const complete: VideoStudioCatalog = { groups, preparations: { default: { phase: 'ready', models: ['gpt-test'] }, 图片模型: { phase: 'ready', models: ['grok-imagine-video-1.5'] } } }

describe('video studio catalog cache', () => {
  it('hands a fully read catalog to the next film within the max age, and nothing after it', () => {
    let now = 1_000
    const cache = createVideoStudioCatalogCache(() => now)
    expect(cache.fresh()).toBeNull()
    cache.save(complete)
    now += videoStudioCatalogMaxAgeMs - 1
    expect(cache.fresh()).toBe(complete)
    now += 1
    expect(cache.fresh()).toBeNull()
  })

  it('keeps nothing when a group failed or is still loading, so the next film reads again', () => {
    const cache = createVideoStudioCatalogCache(() => 0)
    cache.save(complete)
    cache.save({ groups, preparations: { ...complete.preparations, 图片模型: { phase: 'error', models: [] } } })
    expect(cache.fresh()).toBeNull()
    cache.save({ groups, preparations: { default: complete.preparations.default } })
    expect(cache.fresh()).toBeNull()
    cache.save({ groups: [], preparations: {} })
    expect(cache.fresh()).toBeNull()
  })

  it('does not trust a catalog saved in the future of a clock that went back', () => {
    let now = 50_000
    const cache = createVideoStudioCatalogCache(() => now)
    cache.save(complete)
    now = 10_000
    expect(cache.fresh()).toBeNull()
  })
})
