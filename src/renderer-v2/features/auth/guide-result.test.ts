import { describe, expect, it } from 'vitest'
import type { AccountSourceSwitchResult } from '../../../../electron/ipc-contract'
import type { GuideToolState } from './StartGuide'
import { lowBalanceText } from '../tools/Home'
import { buildGuideSetupResult, walletEmptyLead } from './guide-result'

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
    expect(result.usesAccountBalance).toBe(true)
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
    expect(toOfficial.usesAccountBalance).toBe(false)
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
    expect(desktop.prompt).toBe('帮我看看这个文件夹里都有什么，每个文件用一句话说明它是做什么的。')
    expect(desktop.next.detail).toBe('打开后在左侧栏最上面把模式切到「Codex」，再把下面这句话发给它试试。')
    const cli = buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude' }, signedIn: true, readiness: ready, name: 'Claude Code', officialName: 'Claude 账号' })
    expect(cli.prompt).toBeNull()
    expect(cli.next.detail).not.toContain('下面')
    const chat = buildGuideSetupResult({ route: 'chat', signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(chat.prompt).toContain('请')
    expect(chat.install.value).toBe('不用另装')
  })
})

describe('guide setup result desktop mode hint', () => {
  // ChatGPT 桌面端的「聊天」「工作」要 ChatGPT 账号登录，用密钥只能在「Codex」里发。
  it('points key users at the Codex mode of the desktop app', () => {
    for (const source of ['account', 'manual', 'unknown'] as const) {
      const result = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, source }, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
      expect(result.next.detail).toContain('切到「Codex」')
    }
  })

  it('leaves official account users and the chat route alone', () => {
    const official = buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, source: 'official' }, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(official.next.detail).toBe('打开后把下面这句话发给它试试。')
    const switchedToOfficial = buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号', switched: { ...switched, target: 'official' } })
    expect(switchedToOfficial.next.detail).not.toContain('Codex')
    const chat = buildGuideSetupResult({ route: 'chat', signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' })
    expect(chat.next.detail).not.toContain('Codex')
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

// 主路卡点 F3：新账号 $0 走完引导被告知「可以开始了」，发第一句话就失败。
describe('guide setup result empty wallet', () => {
  it('flags an empty wallet only when the tool spends the current account', () => {
    expect(buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude' }, signedIn: true, readiness: ready, name: 'Claude Code', officialName: 'Claude 账号', walletEmpty: true }).walletEmpty).toBe(true)
    expect(buildGuideSetupResult({ route: 'chat', signedIn: true, readiness: ready, name: '聊天', officialName: 'ChatGPT 账号', walletEmpty: true }).walletEmpty).toBe(true)
    for (const source of ['official', 'manual', 'unknown'] as const) {
      expect(buildGuideSetupResult({ route: 'codexDesktop', tool: { ...codex, source }, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号', walletEmpty: true }).walletEmpty).toBe(false)
    }
    expect(buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: { prepared: true, connected: false }, name: 'Codex 桌面端', officialName: 'ChatGPT 账号', walletEmpty: true }).walletEmpty).toBe(false)
    expect(buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: false, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号', walletEmpty: true }).walletEmpty).toBe(false)
    expect(buildGuideSetupResult({ route: 'codexDesktop', tool: codex, signedIn: true, readiness: ready, name: 'Codex 桌面端', officialName: 'ChatGPT 账号' }).walletEmpty).toBe(false)
  })

  it('says the empty wallet in the same words as the home page', () => {
    expect(walletEmptyLead).toBe(lowBalanceText(0))
  })

  // D47（新手流程 N6）：顶上说先充值，结果卡不能再两句叫人去打开。
  it('tells an empty wallet to top up first instead of opening the tool', () => {
    for (const [route, name] of [['claude', 'Claude Code'], ['codexDesktop', 'Codex 桌面端']] as const) {
      const result = buildGuideSetupResult({ route, tool: { ...codex, id: route }, signedIn: true, readiness: ready, name, officialName: 'ChatGPT 账号', walletEmpty: true })
      expect(result.connection.detail).toBe('设置已读到。')
      expect(result.next).toEqual({ value: '先充值', detail: '充值后回来点「打开」就能用。', tone: 'warn' })
    }
    const verified = buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude' }, signedIn: true, readiness: ready, name: 'Claude Code', officialName: 'Claude 账号', switched, walletEmpty: true })
    expect(verified.next.value).toBe('先充值')
  })

  it('keeps the open-the-tool wording when the wallet is funded or the empty wallet is not what the tool spends', () => {
    const funded = buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude' }, signedIn: true, readiness: ready, name: 'Claude Code', officialName: 'Claude 账号' })
    expect(funded.connection.detail).toBe('设置已读到，打开工具试一次。')
    expect(funded.next).toEqual({ value: '打开工具试一次', detail: '打开后随便问它一个问题试试。', tone: 'neutral' })
    for (const source of ['official', 'manual'] as const) {
      const other = buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude', source }, signedIn: true, readiness: ready, name: 'Claude Code', officialName: 'Claude 账号', walletEmpty: true })
      expect(other.next.value).toBe('打开工具试一次')
    }
    // 没试通的改用自己带着出口（和最后一步顶上那句一样），不叠「先充值」。
    const unverified = buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude' }, signedIn: true, readiness: ready, name: 'Claude Code', officialName: 'Claude 账号', switched: { ...switched, verified: false }, walletEmpty: true })
    expect(unverified.next.value).toBe('打开工具试一次')
    // 聊天没有「打开」，不在这次改的范围里。
    const chat = buildGuideSetupResult({ route: 'chat', signedIn: true, readiness: ready, name: '聊天', officialName: 'ChatGPT 账号', walletEmpty: true })
    expect(chat.next.value).toBe('可以开始聊天')
  })
})

describe('guide setup result names', () => {
  // W4 W5：自称一律「星芒」，不说「本软件」。
  it('calls the app 星芒 rather than 本软件', () => {
    const chat = buildGuideSetupResult({ route: 'chat', signedIn: true, readiness: ready, name: '聊天', officialName: 'ChatGPT 账号' })
    expect(chat.install.detail).toBe('聊天就在星芒里，直接提问就行。')
    const changed = buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude', source: 'unknown', keyState: 'changed' }, signedIn: true, readiness: ready, name: 'Claude Code', officialName: 'Claude 账号' })
    expect(changed.connection.detail).toBe('在星芒之外被改过，现在还能用。')
  })

  // W82：第 3 步那颗按钮改名「去连好」，结果卡里点名它的那句跟着叫这个名字。
  it('names the configure button by its current label', () => {
    const result = buildGuideSetupResult({ route: 'claude', tool: { ...codex, id: 'claude', configured: false }, signedIn: true, readiness: { prepared: true, connected: false }, name: 'Claude Code', officialName: 'Claude 账号' })
    expect(result.connection.detail).toBe('还没设好，点「去连好」保存一次。')
  })
})
