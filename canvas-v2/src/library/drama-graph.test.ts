import { describe, expect, it } from 'vitest'
import { collectDramaShotAlerts, dramaPreflightBlockReasons, markDownstreamShotsStale } from './drama-graph'

describe('drama graph gate and stale', () => {
  it('blocks image-generate nodes downstream of an unlocked asset', () => {
    const reasons = dramaPreflightBlockReasons([
      { id: 'char', type: 'drama-character', data: { settings: { name: '虞晚', elementId: 'yuwan', appearance: '红衣', assetKind: 'character', locked: false } } },
      { id: 'shot', type: 'drama-shot', data: { settings: { shotId: 's01', action: '旋丹', gate: 'blocked' } } },
      { id: 'image', type: 'image-generate', data: { prompt: 'out' } },
    ], [
      { source: 'char', target: 'shot' },
      { source: 'shot', target: 'image' },
    ])
    expect(reasons.shot).toContain('请先封板角色「虞晚」的定妆图')
    expect(reasons.image).toContain('请先封板角色「虞晚」的定妆图')
  })

  it('marks compiled shots stale after an asset change', () => {
    const next = markDownstreamShotsStale([
      { id: 'char', type: 'drama-character', data: { settings: { name: '虞晚', appearance: '新外貌' } } },
      { id: 'shot', type: 'drama-shot', data: { prompt: 'compiled', settings: { shotId: 's01', action: '旋丹', compiledImagePrompt: 'old', gate: 'ready' } } },
    ], [{ source: 'char', target: 'shot' }], 'char')
    expect(next[1].data.settings?.gate).toBe('stale')
    const alerts = collectDramaShotAlerts(next, [{ source: 'char', target: 'shot' }])
    expect(alerts.some((alert) => alert.gate === 'stale')).toBe(true)
  })
})
