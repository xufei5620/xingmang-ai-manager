import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { buildPreflightPresentation, createPreflightConfirmation, preflightItemTitle } from './run-preflight-presentation'

function preflight(kind = 'image-generate') {
  return buildCanvasRunPreflight({
    graph: { nodes: [{ id: 'first', kind, definitionVersion: 1, data: { prompt: 'test', model: 'test-model', group: 'test-group' } }], edges: [] },
    scope: { kind: 'all' }, imageModels: ['test-model'], videoModels: ['test-model'],
  })
}

describe('canvas preflight presentation', () => {
  it('uses understandable names for media operations', () => {
    assert.equal(preflightItemTitle('image-generate'), '生成图片')
    assert.equal(preflightItemTitle('image-edit'), '修改图片')
    assert.equal(preflightItemTitle('drama-parse'), '解析剧本')
  })

  it('does not trust inherited object properties as node labels', () => {
    assert.equal(preflightItemTitle('__proto__'), '其他处理步骤')
    assert.equal(preflightItemTitle('toString'), '其他处理步骤')
    assert.equal(preflightItemTitle('new-plugin-node'), '其他处理步骤')
  })

  it('places actionable problems before advanced configuration details', () => {
    const result = buildPreflightPresentation(preflight('frame-extract'))
    assert.equal(result.headline, '先处理这些问题')
    assert.equal(result.canConfirm, false)
    assert.equal(result.blockedItems[0].title, '视频抽帧')
    assert.equal(result.canConfigure, false)
  })

  it('does not direct missing local media to the model configuration panel', () => {
    const result = buildPreflightPresentation(preflight('image-input'))
    assert.equal(result.canConfigure, false)
    assert.equal(result.blockedItems[0].nodeId, 'first')
  })

  it('offers service configuration only for service configuration failures', () => {
    const result = preflight()
    result.items[0] = { nodeId: 'first', kind: 'image-generate', paid: true, action: 'blocked', reasonCode: 'missing-group' }
    result.blockedCount = 1
    result.canStart = false
    assert.equal(buildPreflightPresentation(result).canConfigure, true)
  })

  it('keeps cache estimates distinct from a guarantee of free generation', () => {
    const result = preflight()
    result.items[0].action = 'cached'
    result.cacheHitCount = 1
    result.paidRequestCount = 0
    result.imageRequestCount = 0
    const view = buildPreflightPresentation(result)
    assert.match(view.summary, /预计复用/)
    assert.match(view.costNotice, /缓存会再次校验/)
    assert.doesNotMatch(view.costNotice, /免费|零费用/)
  })

  it('includes script processing in an older snapshot without the new counter', () => {
    const result = preflight('drama-parse')
    delete result.textRequestCount
    const view = buildPreflightPresentation(result)
    assert.match(view.summary, /剧本解析 1 项/)
    assert.match(view.retryNotice ?? '', /可能再次调用/)
  })

  it('fails closed when flags disagree with blocked items', () => {
    const result = preflight('frame-extract')
    result.canStart = true
    result.blockedCount = 0
    assert.equal(buildPreflightPresentation(result).canConfirm, false)
  })

  it('does not enable an empty plan based on a stale canStart flag', () => {
    const result = preflight()
    result.items = []
    result.selectedNodeIds = []
    assert.equal(buildPreflightPresentation(result).canConfirm, false)
  })

  it('preserves IDs and does not rewrite the execution plan', () => {
    const result = preflight()
    const before = structuredClone(result)
    const view = buildPreflightPresentation(result)
    assert.equal(view.items[0].nodeId, 'first')
    assert.deepEqual(result, before)
  })
})

describe('canvas preflight one-shot confirmation', () => {
  it('does not submit a blocked plan', async () => {
    const gate = createPreflightConfirmation()
    let calls = 0
    assert.equal(await gate.submit(false, () => { calls += 1 }), 'idle')
    assert.equal(calls, 0)
  })

  it('allows a corrected plan if no submission has occurred', async () => {
    const gate = createPreflightConfirmation()
    await gate.submit(false, () => assert.fail('blocked'))
    let calls = 0
    assert.equal(await gate.submit(true, () => { calls += 1 }), 'submitted')
    assert.equal(calls, 1)
  })

  it('blocks two confirmations in the same event turn', async () => {
    const gate = createPreflightConfirmation()
    let calls = 0
    let release!: () => void
    const pending = gate.submit(true, () => { calls += 1; return new Promise<void>((resolve) => { release = resolve }) })
    assert.equal(gate.state(), 'submitting')
    assert.equal(await gate.submit(true, () => { calls += 1 }), 'submitting')
    assert.equal(calls, 1)
    release()
    assert.equal(await pending, 'submitted')
  })

  it('does not resubmit after a successful response', async () => {
    const gate = createPreflightConfirmation()
    let calls = 0
    await gate.submit(true, () => { calls += 1 })
    await gate.submit(true, () => { calls += 1 })
    assert.equal(calls, 1)
  })

  it('retains the lock after synchronous uncertainty', async () => {
    const gate = createPreflightConfirmation()
    assert.equal(await gate.submit(true, () => { throw new Error('unknown') }), 'uncertain')
    await gate.submit(true, () => assert.fail('must not retry'))
    assert.equal(gate.state(), 'uncertain')
  })

  it('retains the lock after an asynchronous rejection', async () => {
    const gate = createPreflightConfirmation()
    assert.equal(await gate.submit(true, () => Promise.reject(new Error('unknown'))), 'uncertain')
    await gate.submit(true, () => assert.fail('must not retry'))
  })

  it('guards reentrant calls made by the confirmation callback', async () => {
    const gate = createPreflightConfirmation()
    let calls = 0
    await gate.submit(true, async () => {
      calls += 1
      await gate.submit(true, () => { calls += 1 })
    })
    assert.equal(calls, 1)
  })

  it('does not share state between different modal instances', async () => {
    const first = createPreflightConfirmation()
    const second = createPreflightConfirmation()
    await first.submit(true, () => undefined)
    assert.equal(second.state(), 'idle')
  })
})
