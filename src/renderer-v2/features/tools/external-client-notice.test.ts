import { describe, expect, it } from 'vitest'
import type { ConnectionCheckLayer, ConnectionProbeReport } from '../../../../electron/ipc-contract'
import { connectionCheckView } from './connection-check'
import { accountKeyListFailureText, externalClientSavedTone } from './external-client-notice'

function report(overrides: Partial<ConnectionProbeReport> = {}): ConnectionProbeReport {
  return {
    ok: false,
    layer: 'credential',
    summary: '密钥被拒绝（HTTP 401）',
    nextStep: '到「账号」页重新登录',
    endpoint: 'https://xm.solov.cc/v1/models',
    model: 'gpt-fixture',
    detail: null,
    status: 401,
    durationMs: 12,
    checkedAt: '2026-10-03T12:00:00.000Z',
    ...overrides,
  }
}

const failingLayers: ConnectionCheckLayer[] = ['config', 'network', 'credential', 'quota', 'group', 'model', 'protocol', 'service', 'unknown']

describe('external client saved notice', () => {
  it('stays green when the connection check passed, had nothing configured or did not run', () => {
    expect(externalClientSavedTone(connectionCheckView(report({ ok: true, layer: 'network', summary: '连接正常', status: 200 })))).toBe('ok')
    expect(externalClientSavedTone(connectionCheckView(report({ layer: 'unconfigured', summary: '还没配置' })))).toBe('ok')
    expect(externalClientSavedTone(null)).toBe('ok')
  })

  it('turns to the warning color whichever layer the connection check failed at', () => {
    // 配置确实写进去了，可连不上：以前仍是一整块绿色的「配置已保存」（第三十批 D）。
    for (const layer of failingLayers) {
      expect(externalClientSavedTone(connectionCheckView(report({ layer })))).toBe('warn')
    }
  })

  it('says the key list failed to load without a doubled full stop', () => {
    expect(accountKeyListFailureText('操作没有成功，请重试；还不行，到「反馈」页把报告发给客服。'))
      .toBe('账号密钥列表读取失败：操作没有成功，请重试；还不行，到「反馈」页把报告发给客服。可以使用已有工具密钥或自行填写。')
    expect(accountKeyListFailureText('连不上星芒服务器，请检查网络后重试'))
      .toBe('账号密钥列表读取失败：连不上星芒服务器，请检查网络后重试。可以使用已有工具密钥或自行填写。')
  })
})
