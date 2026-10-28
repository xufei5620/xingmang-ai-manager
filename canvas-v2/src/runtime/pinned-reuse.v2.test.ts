import { describe, expect, it } from 'vitest'
import { cachedNodeIdsForPreflight } from './pinned-reuse'

function node(id: string, overrides: { status?: string; dirty?: boolean; assetId?: string } = {}) {
  return {
    id,
    data: {
      status: overrides.status ?? 'succeeded',
      dirty: overrides.dirty,
      ...(overrides.assetId ? { result: { assetId: overrides.assetId } } : {}),
    },
  }
}

describe('cachedNodeIdsForPreflight', () => {
  const image = node('image', { assetId: 'i'.repeat(43) })
  const video = node('video', { dirty: true, assetId: 'v'.repeat(43) })
  const prompt = node('prompt', { status: 'succeeded' })

  it('reuses a finished upstream image when the user runs the video node', () => {
    expect(cachedNodeIdsForPreflight([prompt, image, video], { kind: 'to-node', nodeId: 'video' }))
      .toEqual(['image'])
  })

  it('does not treat the explicit target as cached, so 运行此节点 still regenerates it', () => {
    expect(cachedNodeIdsForPreflight([image], { kind: 'to-node', nodeId: 'image' })).toEqual([])
  })

  it('keeps dirty or empty nodes out of the reuse set', () => {
    expect(cachedNodeIdsForPreflight(
      [image, video, prompt, node('fresh', { status: 'idle' })],
      { kind: 'all' },
    )).toEqual(['image'])
  })
})
