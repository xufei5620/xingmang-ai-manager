import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import { CodexRemoteCard, CodexRemotePanel, codexRemoteAutoStartText, codexRemoteConfirmText, codexRemoteIdleCloseText, remoteLowBalanceAmount } from './CodexRemoteCard'
import { remoteChannelSections } from './channel-sections'
import { feishuBotChatLink, feishuBotQrText, feishuGuideActions } from './FeishuRemoteSection'

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

function render(state: CodexRemoteSnapshot, busy = '', onOpenHelp?: () => void) {
  return renderToStaticMarkup(<CodexRemotePanel snapshot={state} api={{} as V2Bridge} busy={busy} run={async () => true} error={null} onOpenHelp={onOpenHelp} />)
}

function buttonMarkup(markup: string, testId: string) {
  return markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''
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

  // YF-4：六步下面两颗，飞书开发者后台交给浏览器，教程是星芒自己的那一章；不给跳页的就只摆前一颗。
  it('puts the Feishu console and the tutorial under the setup steps, and drops the tutorial without a way to navigate', () => {
    const state = snapshot()
    const withNavigate = renderToStaticMarkup(<CodexRemotePanel snapshot={state} api={{} as V2Bridge} busy="" run={async () => true} error={null} navigate={() => undefined} />)
    expect(feishuGuideActions).toEqual({ console: '打开飞书开放平台', tutorial: '看教程' })
    expect(withNavigate).toContain('data-testid="settings-remote-feishu-console"')
    expect(withNavigate).toContain('data-testid="settings-remote-feishu-tutorial"')
    expect(withNavigate.indexOf('在「版本管理与发布」里发布一个版本')).toBeLessThan(withNavigate.indexOf('settings-remote-feishu-console'))
    const withoutNavigate = render(state)
    expect(withoutNavigate).toContain('data-testid="settings-remote-feishu-console"')
    expect(withoutNavigate).not.toContain('data-testid="settings-remote-feishu-tutorial"')
  })

  it('shows the saved app by its App ID only and lets the switch on once the folder is chosen', () => {
    const markup = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(markup).toContain('App ID：cli_a1b2c3d4')
    expect(markup).not.toContain('data-testid="settings-remote-feishu-form"')
    expect(buttonMarkup(markup, 'settings-remote-workspace')).toBeTruthy()
    expect(markup).toContain('<span>添加一个</span></button>')
    // Only one folder: no list, no 「正在用」 tag, just the path as before.
    expect(markup).not.toContain('data-testid="settings-remote-workspace-list"')
    expect(switchMarkup(markup)).not.toContain('disabled=""')
    expect(markup).toContain('还没配对。打开遥控后才能配对。')
  })

  // YF-19：不止一个文件夹时一个一行，正在用的标出来，别的能换过去、能移除；满 5 个不让再加。
  it('lists several folders with the one in use marked and the others switchable, and stops adding at five', () => {
    const three = render(snapshot({ workspaceDirectory: '~/projects/blog', workspaces: ['~/projects/demo', '~/projects/blog', '~/projects/shop'] }))
    expect(three).toContain('data-testid="settings-remote-workspace-list"')
    expect(three.match(/data-testid="settings-remote-workspace-in-use"/g)).toHaveLength(1)
    expect(three).toContain('~/projects/blog</span><span class="xm-pill xm-tone-accent" data-testid="settings-remote-workspace-in-use">正在用</span>')
    expect(three.match(/>用这个</g)).toHaveLength(2)
    expect(three.match(/>移除</g)).toHaveLength(2)
    expect(three).toContain('手机上发「文件夹」也能换。')
    expect(buttonMarkup(three, 'settings-remote-workspace')).not.toContain('disabled=""')
    const five = render(snapshot({ workspaceDirectory: '~/a', workspaces: ['~/a', '~/b', '~/c', '~/d', '~/e'] }))
    expect(five).toContain('最多 5 个，先移除一个再添加。')
    expect(five).not.toContain('手机上发「文件夹」也能换。')
    expect(buttonMarkup(five, 'settings-remote-workspace')).toContain('disabled=""')
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

  // YF-2：码挂了 1 分钟还没收到私聊，各渠道说各自的那句。
  it('says on the desktop why a pairing code got no answer, in each channel\'s own words', () => {
    const connected = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' as const } }
    const feishu = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: { code: '482915', expiresAt: 1, quiet: 'nothing' } }))
    expect(feishu).toMatch(/data-testid="settings-remote-feishu-pairing-note"[^>]*>机器人还没收到任何消息。多半是飞书后台还差两步：「事件与回调」里选长连接并添加「接收消息」，再到「版本管理与发布」发布一个版本。做完重新私聊机器人发这 6 位数字。</)
    const weixin = render(snapshot({ workspaceDirectory: '~/projects/demo' }, {}, { ...connected, channel: 'weixin', pairing: { code: '482915', expiresAt: 1, quiet: 'nothing' } }))
    expect(weixin).toMatch(/data-testid="settings-remote-weixin-pairing-note"[^>]*>还没收到消息。在手机微信里找到 ClawBot 对话，把这 6 位数字发过去。</)
    const group = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: { code: '482915', expiresAt: 1, quiet: 'group-only' } }))
    expect(group).toMatch(/data-testid="settings-remote-feishu-pairing-note"[^>]*>收到的是群里的消息，不算。要点开机器人单独私聊它。</)
  })

  it('says why the channel stopped and does not repeat it once connected', () => {
    const stopped = render(snapshot({}, { hasCredential: true, status: { state: 'needs-login', message: '飞书应用的 App ID 或 Secret 不对，到飞书开放平台核对后重新填。' } }))
    expect(stopped).toContain('要重新登录')
    expect(stopped).toContain('data-testid="settings-remote-feishu-status"')
    const connected = render(snapshot({}, { hasCredential: true, enabled: true, status: { state: 'connected', message: '旧原因' } }))
    expect(connected).not.toContain('旧原因')
  })

  // D23：三种说法各配按钮。凭据不对就是「飞书应用」那一行的「重新填写」，不另摆一颗。
  it('pairs each stop reason with its own buttons: refill for a bad credential, reconnect, and support for anything else', () => {
    const ready = { workspaceDirectory: '~/projects/demo' }
    const saved = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true }
    const openHelp = () => undefined

    const credential = render(snapshot(ready, { ...saved, status: { state: 'needs-login', message: '飞书应用的 App ID 或 Secret 不对，到飞书开放平台核对后重新填。', problem: 'credential' } }), '', openHelp)
    expect(credential).toMatch(/data-testid="settings-remote-feishu-status"[^>]*>飞书应用的 App ID 或 Secret 不对，到飞书开放平台核对后重新填。</)
    expect(buttonMarkup(credential, 'settings-remote-feishu-edit')).toContain('xm-btn-primary')
    expect(credential).not.toContain('settings-remote-feishu-reconnect')
    expect(credential).not.toContain('settings-remote-feishu-support')

    const limit = render(snapshot(ready, { ...saved, status: { state: 'error', message: '这个飞书应用在别处也连着，先关掉别处再试。', problem: 'connection-limit' } }), '', openHelp)
    expect(limit).toMatch(/data-testid="settings-remote-feishu-reconnect"[^>]*>.*<span>重新连接<\/span><\/button>/)
    expect(limit).not.toContain('settings-remote-feishu-support')
    expect(buttonMarkup(limit, 'settings-remote-feishu-edit')).not.toContain('xm-btn-primary')
    // 按钮紧跟在那句话下面。
    expect(limit.indexOf('settings-remote-feishu-status-actions')).toBeGreaterThan(limit.indexOf('settings-remote-feishu-status'))

    const other = render(snapshot(ready, { ...saved, status: { state: 'error', message: '没连上，点「重新连接」再试；还不行点「找客服」。', problem: 'other' } }), '', openHelp)
    expect(other).toContain('data-testid="settings-remote-feishu-reconnect"')
    expect(other).toMatch(/data-testid="settings-remote-feishu-support"[^>]*>.*<span>找客服<\/span><\/button>/)
    // 没有帮助框可开时不摆「找客服」。
    expect(render(snapshot(ready, { ...saved, status: { state: 'error', problem: 'other' } }))).not.toContain('settings-remote-feishu-support')

    // 别的操作在跑时先别点；正在重连时转圈。
    expect(buttonMarkup(render(snapshot(ready, { ...saved, status: { state: 'error', problem: 'other' } }), 'feishu-pair'), 'settings-remote-feishu-reconnect')).toContain('disabled=""')
    expect(buttonMarkup(render(snapshot(ready, { ...saved, status: { state: 'error', problem: 'other' } }), 'feishu-reconnect'), 'settings-remote-feishu-reconnect')).toContain('aria-busy="true"')
  })

  it('offers no reconnect for a channel that is switched off, still connecting, or has no stop reason', () => {
    const ready = { workspaceDirectory: '~/projects/demo' }
    const saved = { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }
    expect(render(snapshot(ready, { ...saved, enabled: false, status: { state: 'error', problem: 'other' } }))).not.toContain('settings-remote-feishu-reconnect')
    expect(render(snapshot(ready, { ...saved, enabled: true, status: { state: 'connecting', message: '连不上飞书，正在重试。' } }))).not.toContain('settings-remote-feishu-reconnect')
    expect(render(snapshot(ready, { ...saved, enabled: true, status: { state: 'error', message: '渠道没能连上。' } }))).not.toContain('settings-remote-feishu-status-actions')
    expect(render(snapshot(ready, { ...saved, enabled: true, status: { state: 'connected', problem: 'other' } }))).not.toContain('settings-remote-feishu-reconnect')
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
    // 退出以后怎么登回来，飞书和微信不一样：飞书重新填凭据，微信重新扫码。
    expect(remoteChannelSections.feishu.logoutHint).toBe('退出后要重新填机器人的凭据，才能再用手机遥控。')
    expect(remoteChannelSections.weixin.logoutHint).toBe('退出后要重新用微信扫码登录，才能再用手机遥控。')
    expect(codexRemoteConfirmText.logout.ok).toBe('退出登录')
  })

  // YK-5：手机上收到「Codex 没能启动」时，电脑卡片上也看得见、点一下去首页。
  it('says on top of the card that Codex could not start, with a way to the home page', () => {
    const connected = { hasCredential: true, enabled: true, status: { state: 'connected' } } as const
    const failed = renderToStaticMarkup(
      <CodexRemotePanel snapshot={snapshot({ workspaceDirectory: '~/projects/demo', codexStartFailed: true }, connected)} api={{} as V2Bridge} busy="" run={async () => true} error={null} navigate={() => undefined} />,
    )
    expect(failed).toContain('data-testid="settings-remote-codex-failed"')
    expect(failed).toContain('xm-tone-warn')
    expect(failed).toContain('<strong>Codex 没能启动</strong>')
    expect(failed).toContain('手机上刚发来的那条没有做。去首页看一下 Codex，好了以后在手机上再发一次。')
    expect(failed).toMatch(/data-testid="settings-remote-codex-failed-home"[^>]*>.*去首页看 Codex/)
    expect(failed.indexOf('settings-remote-codex-failed')).toBeLessThan(failed.indexOf('settings-remote-workspace-row'))
    expect(render(snapshot({ workspaceDirectory: '~/projects/demo' }, connected))).not.toContain('settings-remote-codex-failed')
  })

  // YF-9：「打开星芒时自动打开遥控」在卡片最后一行，默认关，说明把没人在电脑前也会连上说在前头。
  it('ends the card with the launch switch, off unless turned on, warning that it connects with nobody around', () => {
    expect(codexRemoteAutoStartText).toEqual({
      title: '打开星芒时自动打开遥控',
      description: '开着时，每次打开星芒都会自己连上，不用再回这里点。星芒开机自启的话，没人在电脑前时手机也能指挥它。不放心就别开。',
    })
    const off = render(snapshot())
    const row = off.slice(off.indexOf('data-testid="settings-remote-auto-start"'))
    expect(off.indexOf('data-testid="settings-remote-auto-start"')).toBeGreaterThan(off.indexOf('data-testid="settings-remote-weixin"'))
    expect(row).toContain(codexRemoteAutoStartText.title)
    expect(row).toContain(codexRemoteAutoStartText.description)
    expect(row).toMatch(/data-testid="settings-remote-auto-start-switch"><button[^>]*aria-checked="false"[^>]*aria-label="打开星芒时自动打开遥控"/)
    expect(render(snapshot({ autoStart: true }))).toMatch(/data-testid="settings-remote-auto-start-switch"><button[^>]*aria-checked="true"/)
    expect(render(snapshot({ available: false, unavailableReason: '星芒正以管理员身份运行。' }))).toMatch(/data-testid="settings-remote-auto-start-switch"><button[^>]*disabled=""/)
  })

  // YF-10：「多久没消息就自动关」三选一，缺省「不自动关」并写明还有哪几种办法关；选了时长不写小字。
  it('offers four hours, twelve hours or never for the idle close, never by default with how else it closes', () => {
    expect(codexRemoteIdleCloseText).toEqual({ title: '多久没消息就自动关', never: '不自动关', neverHint: '只有你在电脑上、托盘里关，或者手机上发「关闭遥控」才会关。' })
    const never = render(snapshot())
    const row = never.slice(never.indexOf('data-testid="settings-remote-idle-close"'))
    expect(never.indexOf('data-testid="settings-remote-idle-close"')).toBeGreaterThan(never.indexOf('data-testid="settings-remote-auto-start"'))
    expect(row).toContain('<strong>多久没消息就自动关</strong>')
    expect(row).toContain('只有你在电脑上、托盘里关，或者手机上发「关闭遥控」才会关。')
    expect(row).toMatch(/role="group" aria-label="多久没消息就自动关" data-testid="settings-remote-idle-close-choice">/)
    expect([...row.matchAll(/aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((match) => [match[2], match[1]])).toEqual([['4 小时', 'false'], ['12 小时', 'false'], ['不自动关', 'true']])
    const twelve = render(snapshot({ idleCloseHours: 12 }))
    expect(twelve).not.toContain('只有你在电脑上、托盘里关')
    expect(twelve).toMatch(/aria-pressed="true"[^>]*>12 小时<\/button>/)
    expect(render(snapshot({ available: false, unavailableReason: '星芒正以管理员身份运行。' }))).toMatch(/<button[^>]*disabled=""[^>]*aria-pressed="true"[^>]*>不自动关<\/button>/)
  })

  it('warns when the credentials only last until the manager closes', () => {
    expect(render(snapshot({ credentialPersistence: 'session-only' }))).toContain('凭据只记到这次关掉星芒')
    expect(render(snapshot({ credentialPersistence: 'unavailable' }))).toContain('凭据存不下')
    expect(render(snapshot())).not.toContain('data-testid="settings-remote-persistence"')
  })

  // YF-13：坐回电脑前看得出手机最近让它干了什么；只摆时间和结果。
  it('shows the last phone request with stop and decline-all only while a channel is on', () => {
    const now = new Date(2026, 10, 11, 14, 8, 30).getTime()
    const lastRequest = { receivedAt: new Date(2026, 10, 11, 14, 5).getTime(), state: 'running' as const }
    const on = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' as const } }
    const off = renderToStaticMarkup(<CodexRemotePanel snapshot={snapshot({ lastRequest })} api={{} as V2Bridge} busy="" run={async () => true} error={null} now={now} />)
    expect(off).not.toContain('settings-remote-last-request')
    const running = renderToStaticMarkup(<CodexRemotePanel snapshot={snapshot({ lastRequest, task: 'waiting-approval', pendingApprovals: 2 }, on)} api={{} as V2Bridge} busy="" run={async () => true} error={null} now={now} navigate={() => undefined} />)
    expect(running).toContain('最近一次')
    expect(running).toContain('14:05 发来一条，正在处理，已经 3 分钟')
    expect(running).toContain('等你同意 2 条，要在手机上回。')
    expect(running).toContain('<span>停下这一轮</span></button>')
    expect(running).toContain('<span>都拒绝</span></button>')
    expect(running).toContain('<span>在记录里看</span></button>')
    // 在文件夹那行上面。
    expect(running.indexOf('settings-remote-last-request')).toBeLessThan(running.indexOf('settings-remote-workspace-row'))
    const done = renderToStaticMarkup(<CodexRemotePanel snapshot={snapshot({ lastRequest: { ...lastRequest, state: 'done' } }, on)} api={{} as V2Bridge} busy="" run={async () => true} error={null} now={now} />)
    expect(done).toContain('14:05 那一条做完了')
    expect(done).not.toContain('停下这一轮')
    expect(done).not.toContain('都拒绝')
    expect(done).not.toContain('在记录里看')
    expect(renderToStaticMarkup(<CodexRemotePanel snapshot={snapshot({}, on)} api={{} as V2Bridge} busy="" run={async () => true} error={null} now={now} />)).not.toContain('settings-remote-last-request')
  })

  // YF-12：开着遥控、余额不到 $1 又没订阅时提醒先充值，照样让开。
  it('warns about a low balance only while a channel is on, with a way to top up', () => {
    const on = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' as const } }
    const warned = renderToStaticMarkup(<CodexRemotePanel snapshot={snapshot({}, on)} api={{} as V2Bridge} busy="" run={async () => true} error={null} lowBalance={0.8} navigate={() => undefined} />)
    expect(warned).toContain('data-testid="settings-remote-low-balance"')
    expect(warned).toContain('xm-tone-warn')
    expect(warned).toContain('<strong>余额只剩 $0.80</strong>')
    expect(warned).toContain('人不在电脑前时充不了值，建议先充一点再出门。')
    expect(warned).toContain('<span>去充值</span></button>')
    expect(renderToStaticMarkup(<CodexRemotePanel snapshot={snapshot({}, { ...on, enabled: false })} api={{} as V2Bridge} busy="" run={async () => true} error={null} lowBalance={0.8} />)).not.toContain('settings-remote-low-balance')
    expect(renderToStaticMarkup(<CodexRemotePanel snapshot={snapshot({}, on)} api={{} as V2Bridge} busy="" run={async () => true} error={null} lowBalance={null} />)).not.toContain('settings-remote-low-balance')
  })

  it('counts a balance as low only under a dollar with no usable subscription and a balance read', () => {
    expect(remoteLowBalanceAmount('bad', { quota: 400_000, quotaPerUnit: 500_000 })).toBe(0.8)
    expect(remoteLowBalanceAmount('zero', { quota: 0, quotaPerUnit: 500_000 })).toBe(0)
    expect(remoteLowBalanceAmount('bad', { quota: 1_500_000, quotaPerUnit: 500_000 })).toBeNull()
    expect(remoteLowBalanceAmount('ok', { quota: 0, quotaPerUnit: 500_000 })).toBeNull()
    expect(remoteLowBalanceAmount('neutral', { quota: 0, quotaPerUnit: 500_000 })).toBeNull()
    expect(remoteLowBalanceAmount('bad', null)).toBeNull()
    expect(remoteLowBalanceAmount('bad', { quota: 0, quotaPerUnit: 0 })).toBeNull()
  })

  // YF-7：只用飞书的人，下面不再摊着微信那一大块和橙色警告。
  it('folds the WeChat block into one line while only Feishu is logged in', () => {
    const folded = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(folded).toContain('aria-expanded="false"')
    expect(folded).toContain('data-testid="settings-remote-weixin-toggle"')
    expect(folded).not.toContain('data-testid="settings-remote-weixin-warning"')
    expect(folded).not.toContain('data-testid="settings-remote-feishu-toggle"')
    const fresh = render(snapshot())
    expect(fresh).not.toContain('aria-expanded')
    expect(fresh).toContain('data-testid="settings-remote-weixin-warning"')
  })

  // YF-3：保存好飞书应用、还没配对时，「还差这几步」下面给一个二维码，手机飞书扫了直接到机器人对话。
  it('offers a QR code that opens the bot chat in Feishu while someone still has to pair', () => {
    const saved = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(saved).toContain('data-testid="settings-remote-feishu-bot-qr"')
    expect(saved).toContain(feishuBotQrText)
    expect(feishuBotQrText).toBe('用手机飞书扫一扫，直接打开和机器人的对话')
    const paired = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4', boundPeer: { userIdTail: 'a1b2', boundAt: 1 } }))
    expect(paired).not.toContain('settings-remote-feishu-bot-qr')
  })

  it('builds the Feishu bot chat link only from an App ID that looks right', () => {
    expect(feishuBotChatLink('cli_a1b2c3d4')).toBe('https://applink.feishu.cn/client/bot/open?appId=cli_a1b2c3d4')
    expect(feishuBotChatLink(null)).toBeNull()
    expect(feishuBotChatLink('cli_a1b2&x=1')).toBeNull()
    expect(feishuBotChatLink('https://evil.example/')).toBeNull()
  })
})
