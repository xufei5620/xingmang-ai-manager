import { describe, expect, it } from 'vitest'
import type { CanvasGroupSummary, CanvasPreparedGroup, CanvasRunGraph } from '../host'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { canvasMediaCatalogSignature, canvasMediaPreparationSignature, isCanvasMediaPreparationCurrent, mediaKeyCreatedNotice, prepareCanvasMediaSources, type CanvasMediaPreparationProgress, type CanvasMediaPreparationScope } from './media-preparation'

function source(name: string, purposes: CanvasGroupSummary['purposes'] = ['image', 'text'], revision = 1): CanvasGroupSummary {
  return { name, description: name, ratio: 1, purposes, revision, connectionStatus: 'ready' }
}

function prepared(group: string, models = ['gpt-image-1', 'gpt-4o-mini'], revision = 1): CanvasPreparedGroup {
  return { group, models, purposes: ['image', 'text'], revision, keyCreated: false }
}

function previousModels() { return { image: ['old-image'], video: ['old-video'], text: ['old-text'] } }

function imagePreflight(models: string[], model = 'gpt-image-1') {
  const graph: CanvasRunGraph = { nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'existing image document', model, group: 'good', size: 'auto' } }], edges: [] }
  return buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: models, videoModels: [] })
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

async function settleProgress() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('progressive media source preparation', () => {
  it('admits an image and text source while an unrelated video source is still pending', async () => {
    const image = deferred<CanvasPreparedGroup>()
    const video = deferred<CanvasPreparedGroup>()
    const progress: CanvasMediaPreparationProgress[] = []
    const calls: string[] = []
    const target = { image: 'shared', text: 'shared', video: 'slow', imageModel: 'gpt-image-1', videoModel: 'grok-imagine-video' }
    let finished = false
    const operation = prepareCanvasMediaSources({
      target, groups: [source('shared'), source('slow', ['video'])], kind: 'all', previousModels: previousModels(), previousErrors: { image: '旧错误' }, isCurrent: () => true,
      prepare: (group) => { calls.push(group); return group === 'shared' ? image.promise : video.promise }, onProgress: (snapshot) => progress.push(snapshot),
    }).then((result) => { finished = true; return result })
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ imageModels: [], videoModels: [], textModels: [], errors: {}, pendingKinds: ['image', 'video', 'text'], mediaGroups: target })
    expect(calls).toEqual(['shared', 'slow'])
    image.resolve(prepared('shared'))
    await settleProgress()
    expect(finished).toBe(false)
    expect(progress).toHaveLength(2)
    expect(progress[1]).toMatchObject({ imageModels: ['gpt-image-1'], textModels: ['gpt-4o-mini'], videoModels: [], pendingKinds: ['video'], mediaGroups: target })
    expect(progress[1].textModels).not.toContain('gpt-image-1')
    expect(imagePreflight(progress[1].imageModels).canStart).toBe(true)
    video.resolve({ ...prepared('slow', ['grok-imagine-video']), purposes: ['video'] })
    const result = await operation
    expect(progress).toHaveLength(3)
    expect(progress[2].pendingKinds).toEqual([])
    expect(result?.videoModels).toEqual(['grok-imagine-video'])
    expect(result?.mediaGroups).toMatchObject(target)
    expect(progress[0].imageModels).toEqual([])
    expect(progress[1].pendingKinds).toEqual(['video'])
  })

  it('fills only an empty model belonging to a source which has already become ready', async () => {
    const image = deferred<CanvasPreparedGroup>()
    const video = deferred<CanvasPreparedGroup>()
    const progress: CanvasMediaPreparationProgress[] = []
    const operation = prepareCanvasMediaSources({
      target: { image: 'image', video: 'video', text: 'image', textModel: 'saved-chat' }, groups: [source('image'), source('video', ['video'])], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: (group) => group === 'image' ? image.promise : video.promise, onProgress: (snapshot) => progress.push(snapshot),
    })
    expect(progress[0].mediaGroups.imageModel).toBeUndefined()
    expect(progress[0].mediaGroups.videoModel).toBeUndefined()
    image.resolve(prepared('image'))
    await settleProgress()
    expect(progress[1].mediaGroups.imageModel).toBe('gpt-image-1')
    expect(progress[1].mediaGroups.textModel).toBe('saved-chat')
    expect(progress[1].mediaGroups.videoModel).toBeUndefined()
    video.reject(new Error('视频来源读取失败'))
    const result = await operation
    expect(progress[2].mediaGroups.imageModel).toBe('gpt-image-1')
    expect(progress[2].mediaGroups.videoModel).toBeUndefined()
    expect(progress[2].pendingKinds).toEqual([])
    expect(result?.errors).toEqual({ video: '视频来源读取失败' })
  })

  it('publishes missing, failed and withdrawn purposes immediately without preparing ineligible sources', async () => {
    const slow = deferred<CanvasPreparedGroup>()
    const progress: CanvasMediaPreparationProgress[] = []
    const calls: string[] = []
    const operation = prepareCanvasMediaSources({
      target: { image: 'shared', text: 'shared', video: 'failed', imageModel: 'saved-image' }, groups: [source('shared', ['text']), { ...source('failed', ['video']), connectionStatus: 'failed' }], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: (group) => { calls.push(group); return slow.promise }, onProgress: (snapshot) => progress.push(snapshot),
    })
    expect(progress[0].pendingKinds).toEqual(['text'])
    expect(progress[0].errors.image).toContain('不提供此用途')
    expect(progress[0].errors.video).toContain('未通过')
    expect(progress[0].mediaGroups.imageModel).toBe('saved-image')
    expect(calls).toEqual(['shared'])
    slow.resolve({ ...prepared('shared', ['custom-chat']), purposes: ['text'] })
    await operation
    expect(progress[1].pendingKinds).toEqual([])
    expect(progress[1].textModels).toEqual(['custom-chat'])
    expect(progress[1].imageModels).toEqual([])
    const missing: CanvasMediaPreparationProgress[] = []
    await prepareCanvasMediaSources({ target: { image: 'missing' }, groups: [], kind: 'image', previousModels: previousModels(), isCurrent: () => true, prepare: async () => { throw new Error('must not prepare') }, onProgress: (snapshot) => missing.push(snapshot) })
    expect(missing).toHaveLength(1)
    expect(missing[0].pendingKinds).toEqual([])
    expect(missing[0].errors.image).toContain('已不存在')
  })

  it('clears a rejected shared source while retaining an already settled unrelated source', async () => {
    const shared = deferred<CanvasPreparedGroup>()
    const video = deferred<CanvasPreparedGroup>()
    const progress: CanvasMediaPreparationProgress[] = []
    const operation = prepareCanvasMediaSources({
      target: { image: 'shared', text: 'shared', video: 'video', imageModel: 'saved-image', textModel: 'saved-chat' }, groups: [source('shared'), source('video', ['video'])], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: (group) => group === 'shared' ? shared.promise : video.promise, onProgress: (snapshot) => progress.push(snapshot),
    })
    video.resolve({ ...prepared('video', ['grok-imagine-video']), purposes: ['video'], storageWarning: '已保留来源配置' })
    await settleProgress()
    expect(progress[1].pendingKinds).toEqual(['image', 'text'])
    shared.reject(new Error('共享来源不可用'))
    const result = await operation
    expect(progress[2].pendingKinds).toEqual([])
    expect(progress[2].videoModels).toEqual(['grok-imagine-video'])
    expect(progress[2].imageModels).toEqual([])
    expect(progress[2].textModels).toEqual([])
    expect(result?.errors).toEqual({ image: '共享来源不可用', text: '共享来源不可用' })
    expect(result?.warnings).toEqual(['已保留来源配置', '生图：共享来源不可用', '文字：共享来源不可用'])
  })

  it('keeps unrelated models and errors through every single-purpose snapshot', async () => {
    const slow = deferred<CanvasPreparedGroup>()
    const progress: CanvasMediaPreparationProgress[] = []
    const target = { image: 'image', video: 'video', text: 'text' }
    const operation = prepareCanvasMediaSources({ target, groups: [source('image')], kind: 'image', previousModels: previousModels(), previousErrors: { image: '旧图片错误', video: '保留视频错误' }, isCurrent: () => true, prepare: () => slow.promise, onProgress: (snapshot) => progress.push(snapshot) })
    expect(progress[0]).toMatchObject({ imageModels: [], videoModels: ['old-video'], textModels: ['old-text'], errors: { video: '保留视频错误' }, pendingKinds: ['image'] })
    slow.resolve(prepared('image'))
    const result = await operation
    expect(progress[1].mediaGroups.videoModel).toBeUndefined()
    expect(progress[1].mediaGroups.textModel).toBeUndefined()
    expect(result?.mediaGroups.imageModel).toBe('gpt-image-1')
    expect(result?.errors).toEqual({ video: '保留视频错误' })
  })

  it('rejects a same-id revision change in progress without admitting the receipt models', async () => {
    const progress: CanvasMediaPreparationProgress[] = []
    const result = await prepareCanvasMediaSources({ target: { image: 'image', imageModel: 'saved-image' }, groups: [source('image', ['image'], 2)], kind: 'image', previousModels: previousModels(), isCurrent: () => true, prepare: async () => prepared('image', ['gpt-image-2'], 1), onProgress: (snapshot) => progress.push(snapshot) })
    expect(progress[1].pendingKinds).toEqual([])
    expect(progress[1].imageModels).toEqual([])
    expect(progress[1].errors.image).toContain('核对期间更新')
    expect(result?.mediaGroups.imageModel).toBe('saved-image')
  })

  it.each([
    Object.assign(new Error('账户已变化'), { code: 'ACCOUNT_CHANGED' }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
    Object.assign(new Error('disposed'), { code: 'HOST_DISPOSED' }),
    Object.assign(new Error('lease expired'), { code: 'HOST_LEASE_EXPIRED' }),
  ])('latches global failure before uncancellable late source results can publish: %s', async (failure) => {
    const shared = deferred<CanvasPreparedGroup>()
    const video = deferred<CanvasPreparedGroup>()
    const progress: CanvasMediaPreparationProgress[] = []
    const operation = prepareCanvasMediaSources({ target: { image: 'shared', text: 'shared', video: 'video' }, groups: [source('shared'), source('video', ['video'])], kind: 'all', previousModels: previousModels(), isCurrent: () => true, prepare: (group) => group === 'shared' ? shared.promise : video.promise, onProgress: (snapshot) => progress.push(snapshot) })
    const rejection = expect(operation).rejects.toBe(failure)
    video.reject(failure)
    await rejection
    shared.resolve(prepared('shared'))
    await settleProgress()
    expect(progress).toHaveLength(1)
    expect(progress[0].imageModels).toEqual([])
  })

  it.each(['revision', 'epoch', 'project', 'catalog', 'account', 'unmount'] as const)('stops progress permanently after %s becomes stale, even if current state later appears restored', async (change) => {
    const shared = deferred<CanvasPreparedGroup>()
    const video = deferred<CanvasPreparedGroup>()
    const expected: CanvasMediaPreparationScope = { requestRevision: 1, projectEpoch: 1, projectId: 'project', catalogSignature: 'v1' }
    let current = { ...expected }
    let active = true
    const progress: CanvasMediaPreparationProgress[] = []
    const operation = prepareCanvasMediaSources({ target: { image: 'shared', text: 'shared', video: 'video' }, groups: [source('shared'), source('video', ['video'])], kind: 'all', previousModels: previousModels(), isCurrent: () => isCanvasMediaPreparationCurrent(expected, current, active), prepare: (group) => group === 'shared' ? shared.promise : video.promise, onProgress: (snapshot) => progress.push(snapshot) })
    if (change === 'revision') current.requestRevision += 1
    if (change === 'epoch') current.projectEpoch += 1
    if (change === 'project') current.projectId = 'other-project'
    if (change === 'catalog') current.catalogSignature = 'v2'
    if (change === 'account' || change === 'unmount') active = false
    shared.resolve(prepared('shared'))
    await settleProgress()
    current = { ...expected }
    active = true
    video.resolve({ ...prepared('video', ['grok-imagine-video']), purposes: ['video'] })
    expect(await operation).toBeNull()
    expect(progress).toHaveLength(1)
  })

  it('does not start source reads if the initial progress callback invalidates the operation', async () => {
    let current = true
    const calls: string[] = []
    const result = await prepareCanvasMediaSources({ target: { image: 'image' }, groups: [source('image')], kind: 'image', previousModels: previousModels(), isCurrent: () => current, prepare: async (group) => { calls.push(group); return prepared(group) }, onProgress: () => { current = false } })
    expect(result).toBeNull()
    expect(calls).toEqual([])
  })

  it('does not expose callbacks or start reads for an initially inactive scope', async () => {
    const progress: CanvasMediaPreparationProgress[] = []
    const calls: string[] = []
    const result = await prepareCanvasMediaSources({ target: { image: 'image' }, groups: [source('image')], kind: 'image', previousModels: previousModels(), isCurrent: () => false, prepare: async (group) => { calls.push(group); return prepared(group) }, onProgress: (snapshot) => progress.push(snapshot) })
    expect(result).toBeNull()
    expect(progress).toEqual([])
    expect(calls).toEqual([])
  })

  it('does not let consumer mutation of a snapshot contaminate later aggregate results', async () => {
    const target = { image: 'image', text: 'image', imageModel: 'saved-image' }
    const previous = previousModels()
    const result = await prepareCanvasMediaSources({ target, groups: [source('image')], kind: 'all', previousModels: previous, isCurrent: () => true, prepare: async () => prepared('image'),
      onProgress: (snapshot) => { snapshot.imageModels.push('consumer-model'); snapshot.errors.video = 'consumer-error'; snapshot.pendingKinds.length = 0; snapshot.mediaGroups.imageModel = 'consumer-choice' },
    })
    expect(result?.imageModels).toEqual(['gpt-image-1'])
    expect(result?.textModels).toEqual(['gpt-4o-mini'])
    expect(result?.errors).toEqual({})
    expect(result?.mediaGroups.imageModel).toBe('saved-image')
    expect(target.imageModel).toBe('saved-image')
    expect(previous.image).toEqual(['old-image'])
  })

  it('latches a consumer progress exception before a late sibling settles', async () => {
    const image = deferred<CanvasPreparedGroup>()
    const video = deferred<CanvasPreparedGroup>()
    const failure = new Error('consumer stopped')
    const progress: CanvasMediaPreparationProgress[] = []
    const operation = prepareCanvasMediaSources({ target: { image: 'image', video: 'video' }, groups: [source('image'), source('video', ['video'])], kind: 'all', previousModels: previousModels(), isCurrent: () => true, prepare: (group) => group === 'image' ? image.promise : video.promise,
      onProgress: (snapshot) => { progress.push(snapshot); if (snapshot.imageModels.length > 0) throw failure },
    })
    const rejection = expect(operation).rejects.toBe(failure)
    image.resolve(prepared('image'))
    await rejection
    video.resolve({ ...prepared('video', ['grok-imagine-video']), purposes: ['video'] })
    await settleProgress()
    expect(progress).toHaveLength(2)
    expect(progress[1].pendingKinds).toEqual(['video'])
  })
})

describe('independent media source preparation', () => {
  it.each(['failed', 'untested', 'missing', 'rejected'] as const)('opens an editable image document when an unrelated video source is %s', async (failure) => {
    const bad = source('bad', ['video'])
    if (failure === 'failed' || failure === 'untested') bad.connectionStatus = failure
    const calls: string[] = []
    const target = { image: 'good', text: 'good', video: 'bad', imageModel: 'gpt-image-1', videoModel: 'grok-imagine-video' }
    const result = await prepareCanvasMediaSources({
      target, groups: failure === 'missing' ? [source('good')] : [source('good'), bad], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: async (group) => { calls.push(group); if (group === 'bad') throw new Error('视频来源暂不可读取'); return prepared(group) },
    })
    expect(result?.mediaGroups).toMatchObject(target)
    expect(result?.imageModels).toEqual(['gpt-image-1'])
    expect(result?.textModels).toEqual(['gpt-4o-mini'])
    expect(result?.textModels).not.toContain('gpt-image-1')
    expect(result?.videoModels).toEqual([])
    expect(result?.errors.video).toBeTruthy()
    expect(result?.errors.image).toBeUndefined()
    expect(imagePreflight(result?.imageModels ?? []).canStart).toBe(true)
    expect(calls.filter((group) => group === 'good')).toHaveLength(1)
    expect(target.videoModel).toBe('grok-imagine-video')
  })

  it('fails closed for every capability using a rejected shared source without erasing another source', async () => {
    const result = await prepareCanvasMediaSources({
      target: { image: 'broken', text: 'broken', video: 'video', imageModel: 'saved-image' }, groups: [source('broken'), source('video', ['video'])], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: async (group) => { if (group === 'broken') throw new Error('来源读取失败'); return { ...prepared(group, ['grok-imagine-video']), purposes: ['video'] } },
    })
    expect(result?.imageModels).toEqual([])
    expect(result?.textModels).toEqual([])
    expect(result?.videoModels).toEqual(['grok-imagine-video'])
    expect(result?.errors).toEqual({ image: '来源读取失败', text: '来源读取失败' })
    expect(result?.mediaGroups.imageModel).toBe('saved-image')
    expect(imagePreflight(result?.imageModels ?? []).canStart).toBe(false)
  })

  it('withdraws only the purpose removed from a shared source and keeps saved selections', async () => {
    const result = await prepareCanvasMediaSources({
      target: { image: 'shared', text: 'shared', imageModel: 'saved-image', textModel: 'custom-chat' }, groups: [source('shared', ['text'], 2)], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: async () => ({ ...prepared('shared', ['custom-chat'], 2), purposes: ['text'] }),
    })
    expect(result?.imageModels).toEqual([])
    expect(result?.textModels).toEqual(['custom-chat'])
    expect(result?.errors.image).toContain('不提供此用途')
    expect(result?.errors.text).toBeUndefined()
    expect(result?.mediaGroups.image).toBe('shared')
    expect(result?.mediaGroups.imageModel).toBe('saved-image')
  })

  it('retains a withdrawn explicit model and lets preflight block it instead of silently switching', async () => {
    const result = await prepareCanvasMediaSources({
      target: { image: 'good', imageModel: 'gpt-image-1' }, groups: [source('good', ['image'], 2)], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: async () => ({ ...prepared('good', ['gpt-image-2'], 2), purposes: ['image'] }),
    })
    expect(result?.mediaGroups.imageModel).toBe('gpt-image-1')
    expect(result?.imageModels).toEqual(['gpt-image-2'])
    expect(imagePreflight(result?.imageModels ?? []).canStart).toBe(false)
  })

  it('leaves unrelated successful models and errors intact while preparing a single source', async () => {
    const calls: string[] = []
    const result = await prepareCanvasMediaSources({
      target: { image: 'good', video: 'bad', text: 'chat' }, groups: [source('good')], kind: 'image', previousModels: previousModels(), previousErrors: { video: '未检测', image: '旧错误' }, isCurrent: () => true,
      prepare: async (group) => { calls.push(group); return prepared(group) },
    })
    expect(calls).toEqual(['good'])
    expect(result?.videoModels).toEqual(['old-video'])
    expect(result?.textModels).toEqual(['old-text'])
    expect(result?.errors).toEqual({ video: '未检测' })
    expect(result?.mediaGroups.textModel).toBeUndefined()
  })

  it.each([
    Object.assign(new Error('账户已变化'), { code: 'ACCOUNT_CHANGED' }),
    new Error('画布页面已关闭，请重新进入工作区。'),
    new Error('画布账号已变化'),
    Object.assign(new Error('stopped'), { name: 'AbortError' }),
    Object.assign(new Error('lease stopped'), { code: 'HOST_LEASE_EXPIRED' }),
  ])('propagates global account and host lifetime failures instead of treating them as one source failure: %s', async (failure) => {
    await expect(prepareCanvasMediaSources({
      target: { image: 'good', video: 'bad' }, groups: [source('good'), source('bad', ['video'])], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: async (group) => { if (group === 'bad') throw failure; return prepared(group) },
    })).rejects.toBe(failure)
  })

  it('rejects mismatched source and revision receipts without admitting their models', async () => {
    for (const receipt of [prepared('foreign', ['gpt-image-2'], 2), prepared('good', ['gpt-image-2'], 1)]) {
      const result = await prepareCanvasMediaSources({ target: { image: 'good' }, groups: [source('good', ['image'], 2)], kind: 'all', previousModels: previousModels(), isCurrent: () => true, prepare: async () => receipt })
      expect(result?.imageModels).toEqual([])
      expect(result?.errors.image).toContain('核对期间更新')
    }
  })

  it('accepts the legacy desktop shape without inventing web revision or purpose requirements', async () => {
    const result = await prepareCanvasMediaSources({ target: { image: 'desktop' }, groups: [{ name: 'desktop', description: '', ratio: 1 }], kind: 'all', previousModels: previousModels(), isCurrent: () => true,
      prepare: async () => ({ group: 'desktop', models: ['gpt-image-1', 'gpt-4o-mini'], keyCreated: true, storageWarning: '本地配置需要核对' }),
    })
    expect(result?.imageModels).toEqual(['gpt-image-1'])
    expect(result?.keyCreatedGroups).toEqual(['desktop'])
    expect(result?.warnings).toEqual(['本地配置需要核对'])
  })
})

describe('media preparation freshness and scope', () => {
  it('refreshes a same-id source after revision, connection status or purpose changes', () => {
    const selected = { image: 'good', imageModel: 'gpt-image-1' }
    const original = canvasMediaPreparationSignature(selected, [source('good')])
    expect(canvasMediaPreparationSignature(selected, [source('good', ['image', 'text'], 2)])).not.toBe(original)
    expect(canvasMediaPreparationSignature(selected, [{ ...source('good'), connectionStatus: 'failed' }])).not.toBe(original)
    expect(canvasMediaPreparationSignature(selected, [source('good', ['text'])])).not.toBe(original)
    expect(canvasMediaPreparationSignature(selected, [source('good'), source('unrelated', ['video'], 10)])).toBe(original)
    expect(canvasMediaPreparationSignature(selected, [source('good')], 100)).toBe(original)
    expect(canvasMediaPreparationSignature(selected, [source('good')], 100, 1)).not.toBe(original)
  })

  it('refreshes legacy catalogs on a completed read but ignores order-only purpose changes', () => {
    const selected = { image: 'legacy' }
    const legacy = [{ name: 'legacy', description: '', ratio: 1 }]
    expect(canvasMediaCatalogSignature(selected, legacy, 1)).not.toBe(canvasMediaCatalogSignature(selected, legacy, 2))
    expect(canvasMediaCatalogSignature({ image: 'good' }, [source('good', ['image', 'text'])])).toBe(canvasMediaCatalogSignature({ image: 'good' }, [source('good', ['text', 'image'])]))
  })

  it.each(['revision', 'epoch', 'project', 'catalog', 'locked'] as const)('does not return a slow success after %s changes', async (change) => {
    const slow = deferred<CanvasPreparedGroup>()
    const expected: CanvasMediaPreparationScope = { requestRevision: 1, projectEpoch: 1, projectId: 'project', catalogSignature: 'v1' }
    let current = { ...expected }
    let active = true
    const operation = prepareCanvasMediaSources({ target: { image: 'good' }, groups: [source('good')], kind: 'all', previousModels: previousModels(),
      isCurrent: () => isCanvasMediaPreparationCurrent(expected, current, active), prepare: () => slow.promise,
    })
    if (change === 'revision') current.requestRevision += 1
    if (change === 'epoch') current.projectEpoch += 1
    if (change === 'project') current.projectId = 'other-project'
    if (change === 'catalog') current.catalogSignature = 'v2'
    if (change === 'locked') active = false
    slow.resolve(prepared('good'))
    expect(await operation).toBeNull()
  })

  it('drops a slow ordinary rejection after a newer preparation has succeeded', async () => {
    const old = deferred<CanvasPreparedGroup>()
    let revision = 1
    const stale = prepareCanvasMediaSources({ target: { image: 'good' }, groups: [source('good')], kind: 'all', previousModels: previousModels(), isCurrent: () => revision === 1, prepare: () => old.promise })
    revision = 2
    const latest = await prepareCanvasMediaSources({ target: { image: 'good' }, groups: [source('good', ['image'], 2)], kind: 'all', previousModels: previousModels(), isCurrent: () => revision === 2, prepare: async () => ({ ...prepared('good', ['gpt-image-2'], 2), purposes: ['image'] }) })
    old.reject(new Error('旧来源读取失败'))
    expect(await stale).toBeNull()
    expect(latest?.imageModels).toEqual(['gpt-image-2'])
    expect(latest?.errors).toEqual({})
  })
})

describe('key created notice', () => {
  it('names every source whose key the host just created, and says nothing otherwise', () => {
    expect(mediaKeyCreatedNotice([])).toBeUndefined()
    expect(mediaKeyCreatedNotice(['默认'])).toBe('已自动创建「默认」分组的密钥')
    expect(mediaKeyCreatedNotice(['默认', '视频'])).toBe('已自动创建「默认、视频」分组的密钥')
  })
})
