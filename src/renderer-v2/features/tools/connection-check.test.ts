import { describe, expect, it } from 'vitest'
import { connectionCheckView, connectionLayerLabels } from './connection-check'
import type { ConnectionCheckLayer, ConnectionCheckResult } from '../../../../electron/ipc-contract'

function result(overrides: Partial<ConnectionCheckResult> = {}): ConnectionCheckResult {
  return {
    provider: 'claude',
    siteId: 'solov',
    ok: false,
    layer: 'credential',
    summary: '密钥被拒绝（HTTP 401）',
    nextStep: '到「账号」页重新登录',
    endpoint: 'https://xm.solov.cc/v1/messages',
    model: 'claude-opus-5',
    detail: null,
    status: 401,
    durationMs: 12,
    checkedAt: '2026-09-18T12:00:00.000Z',
    ...overrides,
  }
}

const layers: ConnectionCheckLayer[] = [
  'config', 'network', 'credential', 'quota', 'group', 'model', 'protocol', 'unknown',
]

describe('connectionCheckView', () => {
  it('shows a success without an endpoint or a follow-up button', () => {
    const view = connectionCheckView(result({ ok: true, layer: 'network', summary: '连接正常' }))
    expect(view.tone).toBe('ok')
    expect(view.target).toBeNull()
    expect(view.endpoint).toBeNull()
    expect(view.body).toContain('claude-opus-5')
  })

  it('sends each failure layer to the page that can fix it', () => {
    expect(connectionCheckView(result({ layer: 'credential' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'quota' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'group' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'model' })).target).toBe('home')
    expect(connectionCheckView(result({ layer: 'config' })).target).toBe('home')
    expect(connectionCheckView(result({ layer: 'network' })).target).toBe('settings')
    expect(connectionCheckView(result({ layer: 'protocol' })).target).toBe('feedback')
    expect(connectionCheckView(result({ layer: 'unknown' })).target).toBe('feedback')
  })

  it('treats an incomplete local config as a warning rather than a failure', () => {
    expect(connectionCheckView(result({ layer: 'config' })).tone).toBe('warn')
    expect(connectionCheckView(result({ layer: 'group' })).tone).toBe('bad')
  })

  it('leads every failure with the layer name and follows with the next step', () => {
    for (const layer of layers) {
      const view = connectionCheckView(result({ layer }))
      expect(view.title.startsWith(connectionLayerLabels[layer])).toBe(true)
      expect(view.body).toBe('到「账号」页重新登录')
      expect(view.layerLabel).toBe(connectionLayerLabels[layer])
    }
  })

  it('never surfaces the site id', () => {
    for (const layer of layers) {
      const view = connectionCheckView(result({ layer, siteId: 'solov-api' }))
      expect(`${view.title} ${view.body} ${view.layerLabel}`).not.toContain('solov')
    }
  })
})
