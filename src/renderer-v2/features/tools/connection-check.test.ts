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
  'unconfigured', 'config', 'network', 'credential', 'quota', 'group', 'model', 'protocol', 'unknown',
]

describe('connectionCheckView', () => {
  it('shows a success without an endpoint or a follow-up button', () => {
    const view = connectionCheckView(result({
      ok: true,
      layer: 'network',
      summary: '连接正常',
      evidence: '已用 claude-opus-5 发过一次最小请求',
    }))
    expect(view.tone).toBe('ok')
    expect(view.statusLabel).toBe('正常')
    expect(view.target).toBeNull()
    expect(view.endpoint).toBeNull()
    expect(view.body).toContain('claude-opus-5')
  })

  it('repeats what the main process actually did rather than guessing per tool', () => {
    const view = connectionCheckView(result({
      ok: true,
      provider: 'codex',
      layer: 'network',
      summary: '连接正常',
      evidence: '已核对当前账号的可用模型清单，gpt-6-astra 在其中',
    }))
    expect(view.body).toBe('已核对当前账号的可用模型清单，gpt-6-astra 在其中')
  })

  it('sends each failure layer to the page that can fix it', () => {
    expect(connectionCheckView(result({ layer: 'credential' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'quota' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'group' })).target).toBe('account')
    expect(connectionCheckView(result({ layer: 'model' })).target).toBe('home')
    expect(connectionCheckView(result({ layer: 'config' })).target).toBe('home')
    expect(connectionCheckView(result({ layer: 'unconfigured' })).target).toBe('home')
    expect(connectionCheckView(result({ layer: 'network' })).target).toBe('settings')
    expect(connectionCheckView(result({ layer: 'protocol' })).target).toBe('feedback')
    expect(connectionCheckView(result({ layer: 'unknown' })).target).toBe('feedback')
  })

  // 一个只装了 Claude Code 的用户按下「测试连接」，另外三个工具必须读成
  // 「还没配」，不是三条红色失败。
  it('shows a tool that was never set up as unconfigured rather than a failure', () => {
    const view = connectionCheckView(result({
      provider: 'gemini',
      layer: 'unconfigured',
      summary: '还没有给 Gemini CLI 写入星芒配置',
      nextStep: '在首页给这个工具写入星芒 Key，写完再回来自检',
      endpoint: null,
      detail: '不该出现',
    }))
    expect(view.tone).toBe('neutral')
    expect(view.statusLabel).toBe('未配置')
    expect(view.title).toBe('还没有给 Gemini CLI 写入星芒配置')
    expect(view.endpoint).toBeNull()
    expect(view.detail).toBeNull()
  })

  it('treats an incomplete local config as a warning rather than a failure', () => {
    expect(connectionCheckView(result({ layer: 'config' })).tone).toBe('warn')
    expect(connectionCheckView(result({ layer: 'group' })).tone).toBe('bad')
  })

  it('labels every failure with its layer and follows with the next step', () => {
    for (const layer of layers) {
      const view = connectionCheckView(result({ layer }))
      expect(view.statusLabel).toBe(connectionLayerLabels[layer])
      expect(view.title).toBe('密钥被拒绝（HTTP 401）')
      expect(view.body).toBe('到「账号」页重新登录')
    }
  })

  it('never surfaces the site id', () => {
    for (const layer of layers) {
      const view = connectionCheckView(result({ layer, siteId: 'solov-api' }))
      expect(`${view.title} ${view.body} ${view.statusLabel}`).not.toContain('solov')
    }
  })
})
