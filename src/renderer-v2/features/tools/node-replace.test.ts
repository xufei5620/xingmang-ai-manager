import { describe, expect, it } from 'vitest'
import type { NodeRuntimeInstallResult } from '../../../../electron/ipc-contract'
import { canReplaceNode, describeNodeReplaceOutcome, nodeReplaceOffered, nodeReplaceReason } from './node-replace'

function result(overrides: Partial<NodeRuntimeInstallResult> = {}): NodeRuntimeInstallResult {
  return {
    installed: true,
    action: 'installed',
    method: 'msi',
    source: 'official',
    version: 'v24.19.0',
    architecture: 'x64',
    pathRefreshRequired: true,
    systemRestartRequired: false,
    ...overrides,
  }
}

describe('node replacement for company certificates', () => {
  it('is only offered where the copy the app installs is the one its tools then use', () => {
    expect(canReplaceNode({ platform: 'windows', nodeRuntimeInstall: 'managed' })).toBe(true)
    expect(canReplaceNode({ platform: 'linux', nodeRuntimeInstall: 'managed' })).toBe(true)
    expect(canReplaceNode({ platform: 'linux', nodeRuntimeInstall: 'external' })).toBe(false)
    expect(canReplaceNode({ platform: 'macos', nodeRuntimeInstall: 'managed' })).toBe(false)
    expect(canReplaceNode({ platform: 'windows', nodeRuntimeInstall: 'external' })).toBe(false)
    expect(canReplaceNode({ platform: null, nodeRuntimeInstall: null })).toBe(false)
  })

  it('turns the maintenance row button into 换成新版 only for a Node.js that cannot read the certificates', () => {
    const windows = { platform: 'windows', nodeRuntimeInstall: 'managed' } as const
    for (const version of ['v20.11.1', 'v22.10.0', 'v22.18.0', 'v24.5.0']) {
      expect([version, nodeReplaceOffered({ ...windows, node: { installed: true, version } })]).toEqual([version, true])
    }
    for (const version of ['v22.19.0', 'v24.6.0', 'v26.0.0']) {
      expect([version, nodeReplaceOffered({ ...windows, node: { installed: true, version } })]).toEqual([version, false])
    }
    // 版本读不出、或者根本没装：不知道该怪 Node 旧，照旧是「安装」。
    expect(nodeReplaceOffered({ ...windows, node: { installed: true, version: null } })).toBe(false)
    expect(nodeReplaceOffered({ ...windows, node: { installed: false, version: null } })).toBe(false)
    expect(nodeReplaceOffered({ platform: 'macos', nodeRuntimeInstall: 'managed', node: { installed: true, version: 'v20.11.1' } })).toBe(false)
  })

  it('names the current version when it knows it', () => {
    expect(nodeReplaceReason('v20.11.1')).toMatch(/^这台电脑上的 Node\.js 是 v20\.11\.1。/)
    expect(nodeReplaceReason('20.11.1')).toContain('是 v20.11.1。')
    expect(nodeReplaceReason(null)).toMatch(/^这台电脑上的 Node\.js 版本较旧。/)
    expect(nodeReplaceReason(null)).toContain('v22.19 以上')
  })

  it('says what happened after the replacement and what to do next', () => {
    expect(describeNodeReplaceOutcome(result())).toEqual({ message: 'Node.js 已换成 v24.19.0，再点一次工具的「安装」就行。', tone: 'ok', restartRequired: false })
    expect(describeNodeReplaceOutcome(result(), true).message).toBe('Node.js 已换成 v24.19.0，正在接着重试。')
    expect(describeNodeReplaceOutcome(result({ action: 'unchanged' })).message).toBe('Node.js 已经是新版了，再点一次工具的「安装」就行。')
    expect(describeNodeReplaceOutcome(result({ systemRestartRequired: true }), true)).toMatchObject({ restartRequired: true, tone: 'warn' })
  })
})
