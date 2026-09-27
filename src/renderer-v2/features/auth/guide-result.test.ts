import { describe, expect, it } from 'vitest'
import type { AccountSourceSwitchResult } from '../../../../electron/ipc-contract'
import type { GuideToolState } from './StartGuide'
import { buildGuideSetupResult } from './guide-result'

const codex: GuideToolState = { id: 'codexDesktop', installed: true, configured: true, source: 'account', version: '1.2.3' }
const ready = { prepared: true, connected: true }
const switched: AccountSourceSwitchResult = {
  provider: 'codex', target: 'account', backupId: 'backup-123', verified: true,
  loginRequired: false, message: '已改用当前账号，连接自检通过。',
}

describe('guide setup result', () => {
  it('uses the detected installed version and keeps a recommended update separate from readiness', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, update: { version: '1.2.4', target: '1.2.4', newer: true, knownIssue: false, manualHint: null } }, signedIn: true, readiness: ready, officialName: 'ChatGPT' })
    expect(result.install.value).toContain('v1.2.3')
    expect(result.install.detail).toContain('1.2.4')
    expect(result.next.value).toContain('可以尝试打开')
  })

  it('does not call a resolved install callback proof that the tool was detected', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, installed: false }, signedIn: true, readiness: { prepared: false, connected: true }, officialName: 'ChatGPT' })
    expect(result.install.value).toContain('尚未检测到安装')
    expect(result.next.value).toContain('返回准备工具')
  })

  it('distinguishes an unread detection from a missing install', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, detectionError: true }, signedIn: true, readiness: { prepared: false, connected: false }, officialName: 'ChatGPT' })
    expect(result.install.value).toContain('暂未读到')
    expect(result.install.value).not.toContain('未安装')
  })

  it('limits a verified account switch to its basic check and names only a real backup', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, officialName: 'ChatGPT', switched })
    expect(result.connection.detail).toContain('基础检查通过')
    expect(result.connection.detail).toBe('切换时的连接基础检查通过。')
    expect(result.backupId).toBe('backup-123')
    expect(result.connection.detail).not.toMatch(/全部功能|原生功能都可用/)
    const noBackup = buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, officialName: 'ChatGPT', switched: { ...switched, backupId: '' } })
    expect(noBackup.backupId).toBeNull()
  })

  it('keeps an unverified switch and an official account pending actual use', () => {
    const unverified = buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, officialName: 'ChatGPT', switched: { ...switched, verified: false } })
    expect(unverified.connection.detail).toContain('基础检查尚未完成')
    expect(unverified.next.value).toContain('可以尝试打开')
    const official = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, source: 'official', officialLoginRequired: true }, signedIn: true, readiness: { prepared: true, connected: false }, officialName: 'ChatGPT' })
    expect(official.connection.value).toContain('待在客户端登录')
    expect(official.billing).toContain('官方账号')
    expect(official.next.value).toContain('核对连接')
  })

  it('does not assign an unknown or manual key to the current account', () => {
    for (const source of ['manual', 'unknown'] as const) {
      const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, source }, signedIn: true, readiness: ready, officialName: 'ChatGPT' })
      expect(result.billing).not.toContain('当前星芒账号')
      expect(result.billing).toContain('归属')
    }
  })

  it('does not claim a relay key or billing route before account configuration is confirmed', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, configured: false }, signedIn: true, readiness: { prepared: true, connected: false }, officialName: 'ChatGPT' })
    expect(result.connection.value).toBe('星芒账号来源待配置')
    expect(result.billing).toContain('密钥尚未确认写入')
    expect(result.next.value).toContain('核对连接')
  })

  it('offers a first prompt while making clear opening is not a completed task', () => {
    const desktop = buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, officialName: 'ChatGPT' })
    expect(desktop.prompt).toContain('用中文')
    expect(desktop.next.detail).toContain('打开后发送下面的示例')
    const chat = buildGuideSetupResult({ route: 'chat', signedIn: true, readiness: ready, officialName: 'ChatGPT' })
    expect(chat.prompt).toContain('请')
    expect(chat.install.value).toBe('无需另装工具')
  })
})
