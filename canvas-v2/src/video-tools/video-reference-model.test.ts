import { describe, expect, it } from 'vitest'
import type { UpstreamMediaReference } from '../components/upstream-references'
import { inspectVideoReferences, moveVideoReference, removeMissingVideoReference, swapVideoReferenceFrames } from './video-reference-model'
import { videoReferenceIdentityKey, type VideoReferenceOrder } from './video-reference-order'

export function videoReferenceFixture(edgeId: string, kind: 'image' | 'audio' | 'video' = 'image', changes: Partial<UpstreamMediaReference> = {}): UpstreamMediaReference {
  return { edgeId, outputIndex: 0, sourceNodeId: `${edgeId}-node`, kind, label: `${edgeId} 素材`, mention: `@${edgeId}`, relationLabel: kind === 'image' ? '图像输入' : kind === 'audio' ? '音频输入' : '视频输入', status: 'ready', asset: { kind, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://${kind}/${'a'.repeat(43)}` }, ...changes }
}
function inspect(references: UpstreamMediaReference[], videoMode = 'auto', order?: VideoReferenceOrder, model = 'minimax-h3-mini') { return inspectVideoReferences({ model, references, videoMode, order }) }
function order(...edges: string[]): VideoReferenceOrder { return { version: 1, slots: edges.map((edgeId) => ({ edgeId, outputIndex: 0 })) } }

describe('video reference presentation and actions', () => {
  it('distinguishes first and last positions without deduplicating the same image', () => {
    const model = inspect([videoReferenceFixture('a'), videoReferenceFixture('b')])
    expect(model.modeLabel).toBe('自动 · 首尾帧生成'); expect(model.items.map((item) => item.role)).toEqual(['首帧', '尾帧'])
    expect(model.items.map((item) => item.reference?.asset?.assetId)).toEqual(['a'.repeat(43), 'a'.repeat(43)])
    const reversed = swapVideoReferenceFrames(model)
    expect(reversed).toEqual(order('b', 'a'))
    const next = inspect([videoReferenceFixture('a'), videoReferenceFixture('b')], 'fl2va', reversed)
    expect(next.items.map((item) => [item.edgeId, item.role])).toEqual([['b', '首帧'], ['a', '尾帧']])
  })
  it('preserves supplied output indices and moves interleaved audio references as whole slots', () => {
    const refs = [videoReferenceFixture('batch', 'image', { batch: true, batchSize: 2, outputIndex: 3 }), videoReferenceFixture('audio', 'audio'), videoReferenceFixture('batch', 'image', { batch: true, batchSize: 2, outputIndex: 7 })]
    const model = inspect(refs)
    expect(model.mode).toBe('ref2va'); expect(model.items.map((item) => item.role)).toEqual(['参考图 1', '参考音频 1', '参考图 2'])
    expect(moveVideoReference(model, model.items[2].key, -1)).toEqual({ version: 1, slots: [{ edgeId: 'batch', outputIndex: 3 }, { edgeId: 'batch', outputIndex: 7 }, { edgeId: 'audio', outputIndex: 0 }] })
    expect(refs.map((item) => item.outputIndex)).toEqual([3, 0, 7])
  })
  it('retains a missing first position instead of promoting the saved tail', () => {
    const model = inspect([videoReferenceFixture('b')], 'fl2va', order('a', 'b'))
    expect(model.items.map((item) => [item.edgeId, item.role, item.missing])).toEqual([['a', '首帧', true], ['b', '尾帧', false]])
    expect(model.canSwap).toBe(false); expect(model.issues.join(' ')).toContain('已保留原位置')
    expect(removeMissingVideoReference(model, model.items[0].key)).toEqual(order('b'))
    expect(removeMissingVideoReference(model, model.items[1].key)).toBeUndefined()
  })
  it('does not resolve auto mode while a saved slot is missing', () => {
    const model = inspect([videoReferenceFixture('b')], 'auto', order('a', 'b'))
    expect(model.mode).toBeUndefined(); expect(model.modeLabel).toContain('待素材就绪')
    expect(model.items[1].role).toBe('参考图 1'); expect(model.canSwap).toBe(false)
  })
  it('keeps unknown batch output placeholders and disables reorder until actual outputs arrive', () => {
    const saved: VideoReferenceOrder = { version: 1, slots: [{ edgeId: 'batch', outputIndex: 1 }, { edgeId: 'batch', outputIndex: 0 }] }
    const waiting = videoReferenceFixture('batch', 'image', { status: 'waiting', asset: undefined, batch: true })
    const model = inspect([waiting], 'auto', saved)
    expect(model.dynamic).toBe(true); expect(model.mode).toBeUndefined(); expect(model.items.map((item) => item.outputIndex)).toEqual([1, 0])
    expect(model.blockingIssues).toEqual([])
    expect(model.items[0].missing).toBe(true); expect(moveVideoReference(model, model.items[0].key, 1)).toBeUndefined()
    const ready = inspect([videoReferenceFixture('batch', 'image', { batch: true, batchSize: 2 }), videoReferenceFixture('batch', 'image', { batch: true, batchSize: 2, outputIndex: 1 })], 'auto', saved)
    expect(ready.dynamic).toBe(false); expect(ready.mode).toBe('fl2va'); expect(ready.items[0].outputIndex).toBe(1)
  })
  it('separates pending upstream work from known media, mode and count violations', () => {
    const pending = videoReferenceFixture('pending', 'image', { status: 'waiting', asset: undefined })
    const dynamic = videoReferenceFixture('batch', 'image', { status: 'waiting', asset: undefined, batch: true })
    expect(inspect([pending], 'i2va').blockingIssues).toEqual([])
    expect(inspect([dynamic], 'fl2va').blockingIssues).toEqual([])
    expect(inspect([dynamic], 'auto').blockingIssues).toEqual([])
    expect(inspect([dynamic], 't2va').blockingIssues.join()).toContain('不接受参考素材')
    expect(inspect([dynamic, videoReferenceFixture('audio', 'audio')], 'fl2va').blockingIssues.join()).toContain('两张图片')
    expect(inspect([dynamic, pending, videoReferenceFixture('third')], 'fl2va').blockingIssues.join()).toContain('两张图片')
    expect(inspect([dynamic, pending], 'i2va').blockingIssues.join()).toContain('一张图片')
    expect(inspect([dynamic, videoReferenceFixture('video', 'video')]).blockingIssues.join()).toContain('不支持参考视频')
    expect(inspect([dynamic, pending], 'auto', undefined, 'grok-imagine-video').blockingIssues.join()).toContain('最多使用一张')
    expect(inspect([dynamic, ...Array.from({ length: 9 }, (_, index) => videoReferenceFixture(`e${index}`))]).blockingIssues.join()).toContain('9 张图片')
  })
  it('blocks confirmed missing positions and unknown models but not unresolved batch indices', () => {
    expect(inspect([videoReferenceFixture('b')], 'fl2va', order('a', 'b')).blockingIssues.join()).toContain('位置缺失')
    expect(inspect([], 'auto', undefined, 'unknown-video').blockingIssues.join()).toContain('尚未验证')
    expect(inspect([videoReferenceFixture('batch', 'image', { batch: true, status: 'waiting', asset: undefined })], 'fl2va', { version: 1, slots: [{ edgeId: 'batch', outputIndex: 1 }, { edgeId: 'batch', outputIndex: 0 }] }).blockingIssues).toEqual([])
  })
  it('preserves missing known batch positions after a batch shrinks', () => {
    const model = inspect([videoReferenceFixture('batch', 'image', { batch: true, batchSize: 1 })], 'fl2va', { version: 1, slots: [{ edgeId: 'batch', outputIndex: 1 }, { edgeId: 'batch', outputIndex: 0 }] })
    expect(model.items.map((item) => [item.role, item.missing])).toEqual([['首帧', true], ['尾帧', false]])
    expect(swapVideoReferenceFrames(model)).toBeUndefined()
  })
  it('shows empty role slots and exact model constraints without silently adding inputs', () => {
    expect(inspect([], 'fl2va').emptyRoles).toEqual(['首帧', '尾帧'])
    expect(inspect([videoReferenceFixture('a')], 'fl2va').emptyRoles).toEqual(['尾帧'])
    expect(inspect([], 'l2va').emptyRoles).toEqual(['尾帧'])
    expect(inspect([videoReferenceFixture('a')], 'l2va').items[0].role).toBe('尾帧')
    expect(inspect([videoReferenceFixture('a')], 't2va').issues.join()).toContain('不接受参考素材')
    expect(inspect([], 'ref2va').issues.join()).toContain('至少')
  })
  it('does not invent capabilities for unknown models and retains invalid saved modes', () => {
    expect(inspect([videoReferenceFixture('a')], 'auto', undefined, 'unverified-video').mode).toBeUndefined()
    expect(inspect([], 'unsupported').modeLabel).toBe('已保存模式：unsupported')
    expect(inspect([], 'unsupported').issues.join()).toContain('原配置已保留')
  })
  it('rejects video or Grok audio inputs even when a stale MiniMax mode is stored', () => {
    expect(inspect([videoReferenceFixture('a', 'video')]).issues.join()).toContain('不支持参考视频')
    expect(inspect([videoReferenceFixture('a', 'audio')], 'unsupported', undefined, 'grok-imagine-video').issues.join()).toContain('不支持参考音频')
    expect(inspect([videoReferenceFixture('a'), videoReferenceFixture('b')], 'auto', undefined, 'grok-imagine-video').canSwap).toBe(false)
    expect(inspect([videoReferenceFixture('batch', 'image', { batch: true, status: 'waiting', asset: undefined }), videoReferenceFixture('v', 'video')]).issues.join()).toContain('不支持参考视频')
  })
  it('blocks invalid ordering and duplicate identities without dropping visible references', () => {
    const invalid = { version: 2, slots: [] } as unknown as VideoReferenceOrder
    expect(inspect([videoReferenceFixture('a')], 'auto', invalid).reorderDisabledReason).toBeTruthy()
    const duplicate = inspect([videoReferenceFixture('a'), videoReferenceFixture('a')])
    expect(duplicate.items).toHaveLength(2); expect(moveVideoReference(duplicate, duplicate.items[0].key, 1)).toBeUndefined()
  })
  it('bounds order changes, appends new references and keeps pure source arrays intact', () => {
    const refs = [videoReferenceFixture('a'), videoReferenceFixture('b'), videoReferenceFixture('c')], source = structuredClone(refs), saved = order('b', 'a')
    const model = inspect(refs, 'auto', saved)
    expect(model.items.map((item) => item.edgeId)).toEqual(['b', 'a', 'c'])
    expect(moveVideoReference(model, videoReferenceIdentityKey({ edgeId: 'b', outputIndex: 0 }), -1)).toBeUndefined()
    expect(moveVideoReference(model, model.items[2].key, 1)).toBeUndefined(); expect(moveVideoReference(model, 'missing', 1)).toBeUndefined()
    expect(refs).toEqual(source); expect(saved).toEqual(order('b', 'a'))
    const excessive = inspect(Array.from({ length: 13 }, (_, index) => videoReferenceFixture(`e${index}`)))
    expect(excessive.reorderDisabledReason).toContain('12'); expect(excessive.items).toHaveLength(13)
  })
})

describe('Ark ordered multimodal references', () => {
  function ark(references: UpstreamMediaReference[], videoMode = 'auto', saved?: VideoReferenceOrder) { return inspectVideoReferences({ model: 'doubao-seedance-2-0-mini-260615', videoProtocol: 'ark-seedance', videoMode, references, order: saved }) }
  it('keeps image, video and audio interleaved and reorders their stable identities together', () => {
    const refs = [videoReferenceFixture('image'), videoReferenceFixture('video', 'video'), videoReferenceFixture('sound', 'audio')]
    const model = ark(refs, 'auto', order('sound', 'image', 'video'))
    expect(model.blockingIssues).toEqual([])
    expect(model.modeLabel).toBe('自动 · 多模态参考')
    expect(model.items.map((item) => [item.edgeId, item.role])).toEqual([['sound', '参考音频 1'], ['image', '参考图 1'], ['video', '参考视频 1']])
    expect(moveVideoReference(model, model.items[2].key, -1)).toEqual(order('sound', 'video', 'image'))
    expect(refs.map((r) => r.edgeId)).toEqual(['image', 'video', 'sound'])
  })
  it('resolves zero, one and two image auto modes but rejects audio-only and unsupported tail mode', () => {
    expect(ark([]).mode).toBe('t2va')
    expect(ark([videoReferenceFixture('a')]).mode).toBe('i2va')
    const two = ark([videoReferenceFixture('a'), videoReferenceFixture('b')])
    expect(two.mode).toBe('fl2va'); expect(two.canSwap).toBe(true)
    expect(ark([videoReferenceFixture('sound', 'audio')]).blockingIssues.join()).toContain('不能仅传音频')
    expect(ark([videoReferenceFixture('a')], 'l2va').blockingIssues.join()).toContain('尾帧')
  })
  it('enforces per-type and combined limits without truncating slots', () => {
    const valid = [...Array.from({ length: 6 }, (_, i) => videoReferenceFixture(`i${i}`)), ...Array.from({ length: 3 }, (_, i) => videoReferenceFixture(`v${i}`, 'video')), ...Array.from({ length: 3 }, (_, i) => videoReferenceFixture(`a${i}`, 'audio'))]
    expect(ark(valid).blockingIssues).toEqual([])
    const overflow = ark([...valid, videoReferenceFixture('extra')])
    expect(overflow.items).toHaveLength(13)
    expect(overflow.blockingIssues.join()).toContain('12')
    expect(ark([...valid.slice(0, 2), ...Array.from({ length: 4 }, (_, i) => videoReferenceFixture(`v${i}`, 'video'))]).blockingIssues.join()).toContain('3 个视频')
  })
  it('preserves missing video identity instead of substituting another ready input', () => {
    const model = ark([videoReferenceFixture('image')], 'ref2va', order('lost-video', 'image'))
    expect(model.items[0]).toMatchObject({ edgeId: 'lost-video', missing: true })
    expect(model.blockingIssues.join()).toContain('位置缺失')
    expect(model.items[1].reference?.edgeId).toBe('image')
  })
})
