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
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, update: { version: '1.2.4', target: '1.2.4', newer: true, knownIssue: false, manualHint: null } }, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(result.install.value).toBe('已装好（版本 1.2.3）')
    expect(result.install.detail).toContain('1.2.4')
    expect(result.next.value).toBe('打开工具试一次')
  })

  it('does not call a resolved install callback proof that the tool was detected', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, installed: false }, signedIn: true, readiness: { prepared: false, connected: true }, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(result.install.value).toBe('还没装好')
    expect(result.next.value).toBe('先回上一步')
  })

  it('distinguishes an unread detection from a missing install', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, detectionError: true }, signedIn: true, readiness: { prepared: false, connected: false }, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(result.install.value).toBe('暂时没读到')
    expect(result.install.value).not.toContain('没装')
  })

  it('names the current account and reports a verified switch without overclaiming', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号', accountName: 'peaker', switched })
    expect(result.connection.value).toBe('当前账号 peaker')
    expect(result.connection.detail).toBe('刚才改用时试连过，能连上。')
    expect(result.connection.tone).toBe('ok')
    expect(result.billing).toBe('花的是当前账号的余额。')
  })

  it('uses the switch result when the detected source has not caught up yet', () => {
    const lagging = { ...codex, source: 'unknown' as const, keyState: 'otherSite' as const }
    const toAccount = buildGuideSetupResult({ route: 'codexDesktop', tool: lagging, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号', switched: { ...switched, verified: false } })
    expect(toAccount.connection.value).toBe('当前账号')
    expect(toAccount.connection.tone).toBe('warn')
    expect(toAccount.connection.detail).toContain('没试通')
    const toOfficial = buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号', switched: { ...switched, target: 'official', verified: false, loginRequired: true } })
    expect(toOfficial.connection.value).toBe('ChatGPT 账号，还没登录')
    expect(toOfficial.billing).toContain('不扣当前账号的余额')
  })

  it('keeps an official account pending its own login', () => {
    const official = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, source: 'official', officialLoginRequired: true }, signedIn: true, readiness: { prepared: true, connected: false }, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(official.connection.value).toContain('还没登录')
    expect(official.connection.detail).toBe('打开 Codex 桌面端，用 ChatGPT 账号登录一次。')
    expect(official.next.value).toBe('先把账号设好')
  })

  it('does not assign an unknown or manual key to the current account', () => {
    for (const source of ['manual', 'unknown'] as const) {
      const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, source }, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
      expect(result.billing).not.toMatch(/^花的是当前账号/)
      expect(result.billing).toMatch(/不一定是当前账号|可能不扣当前账号/)
    }
  })

  it('does not claim a relay key or billing route before account configuration is confirmed', () => {
    const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, configured: false }, signedIn: true, readiness: { prepared: true, connected: false }, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(result.connection.detail).toContain('还没设好')
    expect(result.billing).toBe('设好之后才开始花当前账号的余额。')
    expect(result.next.value).toBe('先把账号设好')
  })

  it('offers a first prompt while making clear opening is not a completed task', () => {
    const desktop = buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(desktop.prompt).toContain('用中文')
    expect(desktop.next.detail).toBe('打开后把下面这句话发给它试试。')
    const cli = buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude' }, signedIn: true, readiness: ready, name: 'Claude Code', officialName: 'Claude 账号' })
    expect(cli.prompt).toBeNull()
    expect(cli.next.detail).not.toContain('下面')
    const chat = buildGuideSetupResult({ route: 'chat', signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(chat.prompt).toContain('请')
    expect(chat.install.value).toBe('不用另装')
  })
})

describe('guide setup result wording', () => {
  it('keeps technical words out of every row', () => {
    const cases = [
      buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, source: 'unknown', keyState: 'otherAccount' }, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' }),
      buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: false, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号', switched }),
      buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: { prepared: false, connected: false }, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' }),
    ]
    for (const result of cases) {
      const text = [result.install, result.connection, result.next].flatMap((row) => [row.value, row.detail]).concat(result.billing).join('\n')
      expect(text).not.toMatch(/Key|同站|基础检查|运行环境|平台支持|v\d|中转|星芒/)
    }
  })
})
