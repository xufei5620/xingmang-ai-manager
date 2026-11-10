import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import { CodexRemoteCard, CodexRemotePanel, codexRemoteConfirmText } from './CodexRemoteCard'

function channel(patch: Partial<CodexRemoteChannelSnapshot> = {}): CodexRemoteChannelSnapshot {
  return { channel: 'feishu', hasCredential: false, accountLabel: null, enabled: false, status: { state: 'stopped' }, boundPeer: null, pairing: null, ...patch }
}

function snapshot(patch: Partial<CodexRemoteSnapshot> = {}, feishu: Partial<CodexRemoteChannelSnapshot> = {}, weixin: Partial<CodexRemoteChannelSnapshot> = {}): CodexRemoteSnapshot {
  return {
    revision: 1,
    available: true,
    credentialPersistence: 'durable',
    workspaceDirectory: null,
    task: 'idle',
    pendingApprovals: 0,
    channels: { feishu: channel(feishu), weixin: channel({ channel: 'weixin', ...weixin }) },
    ...patch,
  }
}

function render(state: CodexRemoteSnapshot, busy = '') {
  return renderToStaticMarkup(<CodexRemotePanel snapshot={state} api={{} as V2Bridge} busy={busy} run={async () => true} error={null} />)
}

function switchMarkup(markup: string) {
  return markup.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? ''
}

describe('codex remote card', () => {
  it('reads the state before drawing anything else', () => {
    const markup = renderToStaticMarkup(<CodexRemoteCard api={{} as V2Bridge} />)
    expect(markup).toContain('<h2>手机遥控 Codex</h2>')
    expect(markup).toContain('正在读取…')
  })

  it('ends the intro by warning that whoever holds the bound chat account controls this computer', () => {
    const markup = render(snapshot())
    expect(markup).toContain('<p class="v2-remote-intro">在手机上私聊你自己的机器人，')
    expect(markup).toContain('只是看文件不问。谁能用你绑定的飞书或微信发消息，谁就能指挥这台电脑，账号别借给别人。</p>')
  })

  it('starts with the folder and the Feishu app form, and keeps the switch off until both are there', () => {
    const markup = render(snapshot())
    expect(markup).toContain('选择文件夹')
    expect(markup).toContain('data-testid="settings-remote-feishu-form"')
    expect(markup).toContain('怎么建飞书机器人')
    expect(markup).toContain('先在上面填好飞书应用。')
    expect(switchMarkup(markup)).toContain('disabled=""')
    // 还没填应用时不摆配对那一行。
    expect(markup).not.toContain('data-testid="settings-remote-feishu-peer"')
  })

  it('shows the saved app by its App ID only and lets the switch on once the folder is chosen', () => {
    const markup = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(markup).toContain('App ID：cli_a1b2c3d4')
    expect(markup).not.toContain('data-testid="settings-remote-feishu-form"')
    expect(markup).toContain('换一个')
    expect(switchMarkup(markup)).not.toContain('disabled=""')
    expect(markup).toContain('还没配对。打开遥控后才能配对。')
  })

  // YF-1：飞书后两步要在保存、打开遥控以后才做，保存以后不能把说明一起收走。
  it('keeps the remaining Feishu steps after saving until someone is paired, then folds the guide into one line', () => {
    const saved = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' } }))
    expect(saved).toContain('data-testid="settings-remote-feishu-next"')
    expect(saved).toContain('保存好了。再做下面几步，手机上才收得到')
    expect(saved).toContain('<li>先打开下面的「打开遥控」，等它显示「已连上」。</li>')
    expect(saved).toContain('<li>在「版本管理与发布」里发布一个版本。</li>')
    expect(saved).toContain('<li>在飞书里搜这个机器人的名字，私聊它。回这里点「开始配对」，把 6 位数字发给它。</li>')
    expect(saved).toContain('第 2 步要先把遥控打开，飞书后台才存得上。')
    expect(saved).not.toContain('data-testid="settings-remote-feishu-guide"')
    // 摆在「打开遥控」上面，第 1 步说的「下面」才对得上。
    expect(saved.indexOf('settings-remote-feishu-next')).toBeLessThan(saved.indexOf('settings-remote-feishu-enable'))

    const paired = render(snapshot(
      { workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' }, boundPeer: { userIdTail: 'a1b2', boundAt: 0 } },
    ))
    expect(paired).not.toContain('settings-remote-feishu-next')
    expect(paired).toMatch(/data-testid="settings-remote-feishu-guide"><details class="v2-remote-guide"><summary>怎么建飞书机器人<\/summary>/)
  })

  it('shows the pairing code with where to send it', () => {
    const markup = render(snapshot(
      { workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' }, pairing: { code: '482915', expiresAt: 1 } },
    ))
    expect(markup).toMatch(/data-testid="settings-remote-feishu-code"[^>]*>482915</)
    expect(markup).toContain('在飞书里打开你建的机器人，私聊发这 6 位数字。10 分钟内有效。')
    expect(markup).toContain('已连上')
  })

  // D66 / YKS-21：配对码发错了只在电脑卡片上说。
  it('says how many wrong codes came in and that a voided code needs a new pairing', () => {
    const connected = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' as const } }
    const clean = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: { code: '482915', expiresAt: 1 } }))
    expect(clean).not.toContain('settings-remote-feishu-pairing-note')
    const wrong = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: { code: '482915', expiresAt: 1, failures: 3 } }))
    expect(wrong).toMatch(/data-testid="settings-remote-feishu-pairing-note"[^>]*>配对码错了 3 次</)
    const voided = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: null, pairingLocked: true }))
    expect(voided).toMatch(/data-testid="settings-remote-feishu-pairing-note"[^>]*>这个码已经作废，请重新开始配对。</)
    expect(voided).toContain('开始配对')
  })

  it('says why the channel stopped and does not repeat it once connected', () => {
    const stopped = render(snapshot({}, { hasCredential: true, status: { state: 'needs-login', message: 'App ID 或 App Secret 不对' } }))
    expect(stopped).toContain('要重新登录')
    expect(stopped).toContain('data-testid="settings-remote-feishu-status"')
    const connected = render(snapshot({}, { hasCredential: true, enabled: true, status: { state: 'connected', message: '旧原因' } }))
    expect(connected).not.toContain('旧原因')
  })

  it('locks every action when the manager runs elevated and says why', () => {
    const markup = render(snapshot(
      { available: false, unavailableReason: '星芒正以管理员身份运行。', workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4' },
    ))
    expect(markup).toContain('这台电脑现在不能打开手机遥控')
    expect(markup).toContain('星芒正以管理员身份运行。')
    expect(switchMarkup(markup)).toContain('disabled=""')
    expect(markup).toMatch(/data-testid="settings-remote-workspace" disabled=""/)
  })

  it('puts the WeChat block after Feishu, marked experimental, with its own scan and logout', () => {
    const before = render(snapshot())
    expect(before.indexOf('data-testid="settings-remote-weixin"')).toBeGreaterThan(before.indexOf('data-testid="settings-remote-feishu"'))
    expect(before).toMatch(/<h3>微信<\/h3><span[^>]*>实验功能<\/span>/)
    expect(before).toContain('先在上面用微信扫码登录。')
    expect(before).not.toContain('退出微信登录')
    const after = render(snapshot({ workspaceDirectory: '~/projects/demo' }, {}, { hasCredential: true, accountLabel: 'ClawBot decb', enabled: true, status: { state: 'connected' }, pairing: { code: '482915', expiresAt: 1 } }))
    expect(after).toContain('已登录：ClawBot decb')
    expect(after).toContain('aria-label="退出微信登录"')
    expect(after).toContain('在微信的 ClawBot 对话里发送这 6 位数字。10 分钟内有效。')
  })

  it('asks before unbinding the person or logging out, and says what has to be redone afterwards', () => {
    const markup = render(snapshot(
      { workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' }, boundPeer: { displayName: '小明', userIdTail: '9f3c', boundAt: 1 } },
    ))
    expect(markup).toContain('data-testid="settings-remote-feishu-unbind"')
    expect(markup).toContain('aria-label="退出飞书登录"')
    // 框只在点了以后才出来。
    expect(markup).not.toContain('settings-remote-feishu-confirm')
    expect(codexRemoteConfirmText.unbind).toEqual({ title: '解绑？', body: '解绑后，这个人就不能再用手机遥控这台电脑了，要用得重新配对。', ok: '解绑' })
    expect(codexRemoteConfirmText.logout.title('飞书')).toBe('退出飞书登录？')
    expect(codexRemoteConfirmText.logout.title('微信')).toBe('退出微信登录？')
    expect(codexRemoteConfirmText.logout.body).toBe('退出后要重新填机器人的凭据，才能再用手机遥控。')
    expect(codexRemoteConfirmText.logout.ok).toBe('退出登录')
  })

  it('warns when the credentials only last until the manager closes', () => {
    expect(render(snapshot({ credentialPersistence: 'session-only' }))).toContain('凭据只记到这次关掉星芒')
    expect(render(snapshot({ credentialPersistence: 'unavailable' }))).toContain('凭据存不下')
    expect(render(snapshot())).not.toContain('data-testid="settings-remote-persistence"')
  })
})
