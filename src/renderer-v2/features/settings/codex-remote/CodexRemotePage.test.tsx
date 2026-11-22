import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import { CodexRemotePage, CodexRemotePageView, codexRemoteAdminAccountNotice, codexRemoteAutoStartText, codexRemoteConfirmText, codexRemoteIdleCloseText, codexRemoteModelText, codexRemotePageText, codexRemotePermissionText, initialRemoteMethod, remoteLowBalanceAmount, type RemoteModelChoices } from './CodexRemotePage'
import { remoteChannelSections } from './channel-sections'
import { feishuBotChatLink, feishuBotQrText, feishuGuideActions, feishuSetupSteps } from './FeishuRemoteSection'

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

type ViewProps = Partial<Omit<Parameters<typeof CodexRemotePageView>[0], 'snapshot'>>

function view(state: CodexRemoteSnapshot, props: ViewProps = {}) {
  return renderToStaticMarkup(<CodexRemotePageView snapshot={state} api={{} as V2Bridge} busy="" run={async () => true} error={null} {...props} />)
}

function render(state: CodexRemoteSnapshot, busy = '', onOpenHelp?: () => void) {
  return view(state, { busy, onOpenHelp })
}

function buttonMarkup(markup: string, testId: string) {
  return markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''
}

function switchMarkup(markup: string) {
  return markup.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? ''
}

describe('codex remote page', () => {
  it('reads the state before drawing anything else', () => {
    const markup = renderToStaticMarkup(<CodexRemotePage api={{} as V2Bridge} />)
    expect(markup).toContain('data-testid="page-remote"')
    expect(markup).toContain('<h1>手机遥控</h1>')
    expect(markup).toContain('正在读取…')
  })

  // 0.2.25（yoyo 2026-11-19「改」）：字逐字钉住。
  it('says the approved words for the page head, the two ways to connect and the closing warning', () => {
    expect(codexRemotePageText).toEqual({
      title: '手机遥控',
      lead: '不在电脑前时，在手机上私聊您的机器人，即可远程操作本机的 Codex，使用当前账号的额度。',
      methodsTitle: '连接方式',
      methodsMeta: '开启一种即可，也可同时开启两种',
      methods: {
        feishu: { tag: '推荐长期使用', body: '需先在飞书开放平台创建您的机器人，步骤稍多；使用飞书官方接口，连接稳定。' },
        weixin: { tag: '实验功能', body: '使用手机微信扫码登录即可，设置最简便；该通道为借用通道，可能随时中断。' },
      },
      channelSettings: codexRemotePageText.channelSettings,
      sharedTitle: '通用设置',
      safety: '仅响应已配对的用户。任何能使用您绑定的飞书或微信发送消息的人，均可操作本机，请勿将账号借予他人。',
    })
    expect(codexRemotePageText.channelSettings('飞书')).toBe('飞书设置')
    expect(codexRemoteModelText.follow('gpt-6.2')).toBe('与电脑端相同（gpt-6.2）')
    expect(codexRemoteModelText.follow()).toBe('与电脑端相同')
    expect(codexRemoteModelText).toMatchObject({ title: '手机端使用的模型', followHint: '如需更换，请前往首页 Codex 的「配置」修改，电脑端与手机端同时生效。', ownHint: '仅手机端使用此模型，电脑端的 Codex 不受影响。' })
    const markup = render(snapshot())
    expect(markup).toContain('<h1>手机遥控</h1><p>不在电脑前时，在手机上私聊您的机器人，即可远程操作本机的 Codex，使用当前账号的额度。</p>')
    expect(markup).toMatch(/<p class="v2-remote-safety" data-testid="settings-remote-safety">仅响应已配对的用户。任何能使用您绑定的飞书或微信发送消息的人，均可操作本机，请勿将账号借予他人。<\/p><\/div><\/section>$/)
    // 旧卡片开头那段不再出现，也不说「星芒的线路」。
    expect(markup).not.toContain('v2-remote-intro')
    expect(markup).not.toContain('星芒的线路')
    // 都没开时页头右边不摆状态；开着时说 Codex 在干什么。
    expect(markup).not.toContain('settings-remote-meta')
    expect(render(snapshot({ task: 'running' }, { hasCredential: true, enabled: true, status: { state: 'connected' } }))).toMatch(/data-testid="settings-remote-meta"><i aria-hidden="true"><\/i>Codex 正在处理</)
  })

  // 两种连接方式并排两张卡，是一组页签；点哪张下面摆哪张的设置，另一张的设置不摆。
  it('shows the two ways to connect side by side and only the chosen one\'s settings below', () => {
    const markup = render(snapshot())
    expect(markup).toContain('role="tablist" aria-label="连接方式"')
    expect(markup.indexOf('data-testid="remote-method-feishu"')).toBeLessThan(markup.indexOf('data-testid="remote-method-weixin"'))
    expect(markup).toMatch(/<button type="button" role="tab" id="remote-method-feishu" aria-selected="true" aria-controls="remote-method-panel" tabindex="0" class="v2-remote-method is-selected"/)
    expect(markup).toMatch(/<button type="button" role="tab" id="remote-method-weixin" aria-selected="false" aria-controls="remote-method-panel" tabindex="-1" class="v2-remote-method"/)
    expect(markup).toContain('<strong>飞书</strong><span class="xm-pill xm-tone-accent">推荐长期使用</span>')
    expect(markup).toContain('<strong>微信</strong><span class="xm-pill xm-tone-warn">实验功能</span>')
    expect(markup).toContain('需先在飞书开放平台创建您的机器人，步骤稍多；使用飞书官方接口，连接稳定。')
    expect(markup).toContain('使用手机微信扫码登录即可，设置最简便；该通道为借用通道，可能随时中断。')
    // 两张卡上各有自己的状态。
    expect(markup).toContain('data-testid="settings-remote-feishu-state"')
    expect(markup).toContain('data-testid="settings-remote-weixin-state"')
    expect(markup).toContain('role="tabpanel" id="remote-method-panel" aria-labelledby="remote-method-feishu"')
    expect(markup).toContain('<h3>飞书设置</h3>')
    expect(markup).toContain('data-testid="settings-remote-feishu"')
    expect(markup).not.toContain('data-testid="settings-remote-weixin"')
    const weixin = view(snapshot(), { initialMethod: 'weixin' })
    expect(weixin).toContain('<h3>微信设置</h3>')
    expect(weixin).toContain('data-testid="settings-remote-weixin"')
    expect(weixin).not.toContain('data-testid="settings-remote-feishu"')
  })

  it('opens on the way that is switched on, else the one with a login, else Feishu', () => {
    expect(initialRemoteMethod(snapshot())).toBe('feishu')
    expect(initialRemoteMethod(snapshot({}, {}, { hasCredential: true }))).toBe('weixin')
    expect(initialRemoteMethod(snapshot({}, { hasCredential: true }, { hasCredential: true, enabled: true }))).toBe('weixin')
    expect(initialRemoteMethod(snapshot({}, { hasCredential: true, enabled: true }, { hasCredential: true, enabled: true }))).toBe('feishu')
    expect(render(snapshot({}, {}, { hasCredential: true, accountLabel: 'ClawBot decb' }))).toContain('<h3>微信设置</h3>')
  })

  // 两种方式共用的设置另起一块（「通用设置」）：工作文件夹、权限、手机端使用的模型、自动打开、自动关，摆在连接方式下面。
  it('puts the shared settings in their own card after the ways to connect', () => {
    const markup = render(snapshot())
    const order = ['remote-methods', 'remote-shared', 'settings-remote-workspace-row', 'settings-remote-permission"', 'settings-remote-model"', 'settings-remote-auto-start"', 'settings-remote-idle-close"'].map((id) => markup.indexOf(`data-testid="${id}`))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(markup).toContain('<h2>通用设置</h2>')
  })

  // 权限两档（yoyo 2026-11-22 亲手打字同意、北京 09:56 贴的字）：缺省「默认」，说明跟着选中的那一档换；没有完全访问。
  it('offers the default and read-only permission levels, explaining the chosen one', () => {
    expect(codexRemotePermissionText).toEqual({
      title: '权限',
      options: { default: '默认', readOnly: '只读' },
      hints: {
        default: '与电脑端 Codex 一致：在所选文件夹内查看、修改文件和执行命令无需确认；联网或修改该文件夹以外的内容前，将先在手机上征求您的同意。',
        readOnly: '仅查看：查看文件、获取本机信息无需确认；修改文件、执行会产生改动的命令或联网前，均将先在手机上征求您的同意。',
      },
    })
    function permissionRow(markup: string): string {
      return markup.slice(markup.indexOf('data-testid="settings-remote-permission"'), markup.indexOf('data-testid="settings-remote-model"'))
    }
    const byDefault = permissionRow(render(snapshot()))
    expect(byDefault).toContain(`<strong>权限</strong><p>${codexRemotePermissionText.hints.default}</p>`)
    expect([...byDefault.matchAll(/<button[^>]*aria-(?:pressed|checked|selected)="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((match) => [match[2], match[1]])).toEqual([['默认', 'true'], ['只读', 'false']])
    const readOnly = permissionRow(render(snapshot({ permission: 'readOnly' })))
    expect(readOnly).toContain(`<strong>权限</strong><p>${codexRemotePermissionText.hints.readOnly}</p>`)
    expect([...readOnly.matchAll(/<button[^>]*aria-(?:pressed|checked|selected)="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((match) => [match[2], match[1]])).toEqual([['默认', 'false'], ['只读', 'true']])
    expect(byDefault).not.toContain('完全访问')
    expect(permissionRow(render(snapshot({ available: false, unavailableReason: '星芒正以管理员身份运行。' })))).toMatch(/disabled=""/)
  })

  // 「手机端使用的模型」：选项跟首页 Codex「配置」里「默认模型」是同一张单，第一项「与电脑端相同（…）」是缺省。
  it('offers following the computer first and then the same models as the Codex config', () => {
    const choices: RemoteModelChoices = { computerModel: 'gpt-6.2', models: ['gpt-6.2', 'gpt-6.3-sol', 'gpt-6.1-mini'] }
    const follow = view(snapshot(), { modelChoices: choices })
    const row = follow.slice(follow.indexOf('data-testid="settings-remote-model"'), follow.indexOf('data-testid="settings-remote-auto-start"'))
    expect(row).toContain('<strong>手机端使用的模型</strong><p>如需更换，请前往首页 Codex 的「配置」修改，电脑端与手机端同时生效。</p>')
    expect([...row.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((match) => [match[1], match[2]])).toEqual([
      ['', '与电脑端相同（gpt-6.2）'],
      ['gpt-6.2', 'gpt-6.2'],
      ['gpt-6.3-sol', 'gpt-6.3-sol'],
      ['gpt-6.1-mini', 'gpt-6.1-mini'],
    ])
    expect(row).toMatch(/<select aria-label="手机端使用的模型"[^>]*data-testid="settings-remote-model-choice"/)
    const own = view(snapshot({ model: 'gpt-6.3-sol' }), { modelChoices: choices })
    expect(own).toContain('<strong>手机端使用的模型</strong><p>仅手机端使用此模型，电脑端的 Codex 不受影响。</p>')
    // 单独选过、这次没读到的型号也列着，下拉框跟实际用的对得上；电脑上的读不到就不写括号。
    const unlisted = view(snapshot({ model: 'gpt-6.0' }), { modelChoices: { computerModel: '', models: [] } })
    expect([...unlisted.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((match) => match[2])).toEqual(['与电脑端相同', 'gpt-6.0'])
    expect(render(snapshot({ available: false, unavailableReason: '星芒正以管理员身份运行。' }))).toMatch(/<select aria-label="手机端使用的模型" disabled=""/)
  })

  it('starts with the folder and the Feishu app form, and keeps the switch off until both are there', () => {
    const markup = render(snapshot())
    expect(markup).toContain('选择文件夹')
    expect(markup).toContain('data-testid="settings-remote-feishu-form"')
    expect(markup).toContain('如何创建飞书机器人')
    expect(markup).toContain('请先在上方填写飞书应用信息。')
    expect(switchMarkup(markup)).toContain('disabled=""')
    // 还没填应用时不摆配对那一行。
    expect(markup).not.toContain('data-testid="settings-remote-feishu-peer"')
  })

  // YF-4：六步下面两颗，飞书开发者后台交给浏览器，教程是星芒自己的那一章；不给跳页的就只摆前一颗。
  it('puts the Feishu console and the tutorial under the setup steps, and drops the tutorial without a way to navigate', () => {
    const state = snapshot()
    const withNavigate = view(state, { navigate: () => undefined })
    expect(feishuGuideActions).toEqual({ console: '打开飞书开放平台', tutorial: '查看教程' })
    expect(withNavigate).toContain('data-testid="settings-remote-feishu-console"')
    expect(withNavigate).toContain('data-testid="settings-remote-feishu-tutorial"')
    expect(withNavigate.indexOf('在「版本管理与发布」中发布一个版本')).toBeLessThan(withNavigate.indexOf('settings-remote-feishu-console'))
    const withoutNavigate = render(state)
    expect(withoutNavigate).toContain('data-testid="settings-remote-feishu-console"')
    expect(withoutNavigate).not.toContain('data-testid="settings-remote-feishu-tutorial"')
  })

  it('shows the saved app by its App ID only and lets the switch on once the folder is chosen', () => {
    const markup = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(markup).toContain('App ID：cli_a1b2c3d4')
    expect(markup).not.toContain('data-testid="settings-remote-feishu-form"')
    expect(buttonMarkup(markup, 'settings-remote-workspace')).toBeTruthy()
    expect(markup).toContain('<span>添加文件夹</span></button>')
    // Only one folder: no list, no 「正在用」 tag, just the path as before.
    expect(markup).not.toContain('data-testid="settings-remote-workspace-list"')
    expect(switchMarkup(markup)).not.toContain('disabled=""')
    expect(markup).toContain('尚未配对。开启遥控后方可配对。')
  })

  // YF-19：不止一个文件夹时一个一行，正在用的标出来，别的能换过去、能移除；满 5 个不让再加。
  it('lists several folders with the one in use marked and the others switchable, and stops adding at five', () => {
    const three = render(snapshot({ workspaceDirectory: '~/projects/blog', workspaces: ['~/projects/demo', '~/projects/blog', '~/projects/shop'] }))
    expect(three).toContain('data-testid="settings-remote-workspace-list"')
    expect(three.match(/data-testid="settings-remote-workspace-in-use"/g)).toHaveLength(1)
    expect(three).toContain('~/projects/blog</span><span class="xm-pill xm-tone-accent" data-testid="settings-remote-workspace-in-use">使用中</span>')
    expect(three.match(/>使用此文件夹</g)).toHaveLength(2)
    expect(three.match(/>移除</g)).toHaveLength(2)
    expect(three).toContain('也可在手机上发送「文件夹」切换。')
    expect(buttonMarkup(three, 'settings-remote-workspace')).not.toContain('disabled=""')
    const five = render(snapshot({ workspaceDirectory: '~/a', workspaces: ['~/a', '~/b', '~/c', '~/d', '~/e'] }))
    expect(five).toContain('最多 5 个，请先移除一个再添加。')
    expect(five).not.toContain('也可在手机上发送「文件夹」切换。')
    expect(buttonMarkup(five, 'settings-remote-workspace')).toContain('disabled=""')
  })

  // YF-1：飞书后两步要在保存、打开遥控以后才做，保存以后不能把说明一起收走。
  it('keeps the remaining Feishu steps after saving until someone is paired, then folds the guide into one line', () => {
    const saved = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' } }))
    expect(saved).toContain('data-testid="settings-remote-feishu-next"')
    expect(saved).toContain('已保存。请完成以下步骤，手机端方可接收消息')
    expect(saved).toContain('<li>开启下方的「打开遥控」，待其显示「已连接」。</li>')
    expect(saved).toContain('<li>在「版本管理与发布」中发布一个版本。</li>')
    expect(saved).toContain('<li>在飞书中搜索该机器人名称并发起私聊，然后返回此处点击「开始配对」，将 6 位数字发送给机器人。</li>')
    expect(saved).toContain('第 2 步需先开启遥控，飞书后台才能保存。')
    expect(saved).not.toContain('data-testid="settings-remote-feishu-guide"')
    // 摆在「打开遥控」上面，第 1 步说的「下面」才对得上。
    expect(saved.indexOf('settings-remote-feishu-next')).toBeLessThan(saved.indexOf('settings-remote-feishu-enable'))

    const paired = render(snapshot(
      { workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' }, boundPeer: { userIdTail: 'a1b2', boundAt: 0 } },
    ))
    expect(paired).not.toContain('settings-remote-feishu-next')
    expect(paired).toMatch(/data-testid="settings-remote-feishu-guide"><details class="v2-remote-guide"><summary>如何创建飞书机器人<\/summary>/)
  })

  it('shows the pairing code with where to send it', () => {
    const markup = render(snapshot(
      { workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' }, pairing: { code: '482915', expiresAt: 1 } },
    ))
    expect(markup).toMatch(/data-testid="settings-remote-feishu-code"[^>]*>482915</)
    expect(markup).toContain('在飞书中打开您创建的机器人，私聊发送这 6 位数字。10 分钟内有效。')
    expect(markup).toContain('已连接')
  })

  // D66 / YKS-21：配对码发错了只在电脑卡片上说。
  it('says how many wrong codes came in and that a voided code needs a new pairing', () => {
    const connected = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' as const } }
    const clean = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: { code: '482915', expiresAt: 1 } }))
    expect(clean).not.toContain('settings-remote-feishu-pairing-note')
    const wrong = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: { code: '482915', expiresAt: 1, failures: 3 } }))
    expect(wrong).toMatch(/data-testid="settings-remote-feishu-pairing-note"[^>]*>配对码已输错 3 次</)
    const voided = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: null, pairingLocked: true }))
    expect(voided).toMatch(/data-testid="settings-remote-feishu-pairing-note"[^>]*>此配对码已失效，请重新开始配对。</)
    expect(voided).toContain('开始配对')
  })

  // YF-2：码挂了 1 分钟还没收到私聊，各渠道说各自的那句。
  it('says on the desktop why a pairing code got no answer, in each channel\'s own words', () => {
    const connected = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' as const } }
    const feishu = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: { code: '482915', expiresAt: 1, quiet: 'nothing' } }))
    expect(feishu).toMatch(/data-testid="settings-remote-feishu-pairing-note"[^>]*>机器人尚未收到任何消息，通常是飞书后台还有两步未完成：在「事件与回调」中选择长连接并添加「接收消息」，再在「版本管理与发布」中发布一个版本。完成后重新私聊机器人发送这 6 位数字。</)
    const weixin = view(snapshot({ workspaceDirectory: '~/projects/demo' }, {}, { ...connected, channel: 'weixin', pairing: { code: '482915', expiresAt: 1, quiet: 'nothing' } }), { initialMethod: 'weixin' })
    expect(weixin).toMatch(/data-testid="settings-remote-weixin-pairing-note"[^>]*>尚未收到消息。请在手机微信中找到 ClawBot 对话，发送这 6 位数字。</)
    const group = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { ...connected, pairing: { code: '482915', expiresAt: 1, quiet: 'group-only' } }))
    expect(group).toMatch(/data-testid="settings-remote-feishu-pairing-note"[^>]*>收到的是群聊消息，无法用于配对。请打开机器人，单独私聊发送。</)
  })

  it('says why the channel stopped and does not repeat it once connected', () => {
    const stopped = render(snapshot({}, { hasCredential: true, status: { state: 'needs-login', message: '飞书应用的 App ID 或 App Secret 不正确，请在飞书开放平台核对后重新填写。' } }))
    expect(stopped).toContain('需重新登录')
    expect(stopped).toContain('data-testid="settings-remote-feishu-status"')
    const connected = render(snapshot({}, { hasCredential: true, enabled: true, status: { state: 'connected', message: '旧原因' } }))
    expect(connected).not.toContain('旧原因')
  })

  // D23：三种说法各配按钮。凭据不对就是「飞书应用」那一行的「重新填写」，不另摆一颗。
  it('pairs each stop reason with its own buttons: refill for a bad credential, reconnect, and support for anything else', () => {
    const ready = { workspaceDirectory: '~/projects/demo' }
    const saved = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true }
    const openHelp = () => undefined

    const credential = render(snapshot(ready, { ...saved, status: { state: 'needs-login', message: '飞书应用的 App ID 或 App Secret 不正确，请在飞书开放平台核对后重新填写。', problem: 'credential' } }), '', openHelp)
    expect(credential).toMatch(/data-testid="settings-remote-feishu-status"[^>]*>飞书应用的 App ID 或 App Secret 不正确，请在飞书开放平台核对后重新填写。</)
    expect(buttonMarkup(credential, 'settings-remote-feishu-edit')).toContain('xm-btn-primary')
    expect(credential).not.toContain('settings-remote-feishu-reconnect')
    expect(credential).not.toContain('settings-remote-feishu-support')

    const limit = render(snapshot(ready, { ...saved, status: { state: 'error', message: '该飞书应用已在其他位置连接，请先断开其他连接后重试。', problem: 'connection-limit' } }), '', openHelp)
    expect(limit).toMatch(/data-testid="settings-remote-feishu-reconnect"[^>]*>.*<span>重新连接<\/span><\/button>/)
    expect(limit).not.toContain('settings-remote-feishu-support')
    expect(buttonMarkup(limit, 'settings-remote-feishu-edit')).not.toContain('xm-btn-primary')
    // 按钮紧跟在那句话下面。
    expect(limit.indexOf('settings-remote-feishu-status-actions')).toBeGreaterThan(limit.indexOf('settings-remote-feishu-status'))

    const other = render(snapshot(ready, { ...saved, status: { state: 'error', message: '未能建立连接，请点击「重新连接」重试；如问题仍存在，请点击「联系客服」。', problem: 'other' } }), '', openHelp)
    expect(other).toContain('data-testid="settings-remote-feishu-reconnect"')
    expect(other).toMatch(/data-testid="settings-remote-feishu-support"[^>]*>.*<span>联系客服<\/span><\/button>/)
    // 没有帮助框可开时不摆「联系客服」。
    expect(render(snapshot(ready, { ...saved, status: { state: 'error', problem: 'other' } }))).not.toContain('settings-remote-feishu-support')

    // 别的操作在跑时先别点；正在重连时转圈。
    expect(buttonMarkup(render(snapshot(ready, { ...saved, status: { state: 'error', problem: 'other' } }), 'feishu-pair'), 'settings-remote-feishu-reconnect')).toContain('disabled=""')
    expect(buttonMarkup(render(snapshot(ready, { ...saved, status: { state: 'error', problem: 'other' } }), 'feishu-reconnect'), 'settings-remote-feishu-reconnect')).toContain('aria-busy="true"')
  })

  it('offers no reconnect for a channel that is switched off, still connecting, or has no stop reason', () => {
    const ready = { workspaceDirectory: '~/projects/demo' }
    const saved = { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }
    expect(render(snapshot(ready, { ...saved, enabled: false, status: { state: 'error', problem: 'other' } }))).not.toContain('settings-remote-feishu-reconnect')
    expect(render(snapshot(ready, { ...saved, enabled: true, status: { state: 'connecting', message: '无法连接飞书，正在重试。' } }))).not.toContain('settings-remote-feishu-reconnect')
    expect(render(snapshot(ready, { ...saved, enabled: true, status: { state: 'error', message: '渠道未能建立连接。' } }))).not.toContain('settings-remote-feishu-status-actions')
    expect(render(snapshot(ready, { ...saved, enabled: true, status: { state: 'connected', problem: 'other' } }))).not.toContain('settings-remote-feishu-reconnect')
  })

  it('locks every action when the manager runs elevated and says why', () => {
    const markup = render(snapshot(
      { available: false, unavailableReason: '星芒正以管理员身份运行。', workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4' },
    ))
    expect(markup).toContain('本机当前无法开启手机遥控')
    expect(markup).toContain('星芒正以管理员身份运行。')
    expect(switchMarkup(markup)).toContain('disabled=""')
    expect(markup).toMatch(/data-testid="settings-remote-workspace" disabled=""/)
  })

  // yoyo typed his consent on 2026-11-20, this sentence included.
  it('warns right under the page head when the Windows account is an administrator by itself', () => {
    expect(codexRemoteAdminAccountNotice).toBe('本机登录的 Windows 账号自带管理员权限，Codex 在此修改文件、执行命令时同样具有管理员权限。在手机上回复「同意」前，请确认其将执行的操作。')
    const markup = render(snapshot({ alwaysElevated: true, workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(markup).toContain(`<span>${codexRemoteAdminAccountNotice}</span>`)
    expect(markup.indexOf('</h1>')).toBeLessThan(markup.indexOf('data-testid="settings-remote-admin-account"'))
    expect(markup.indexOf('data-testid="settings-remote-admin-account"')).toBeLessThan(markup.indexOf('data-testid="remote-methods"'))
    expect(markup).not.toContain('本机当前无法开启手机遥控')
    expect(switchMarkup(markup)).not.toContain('disabled=""')
    expect(render(snapshot())).not.toContain('settings-remote-admin-account')
  })

  it('gives WeChat its own block, marked experimental, with its own scan and logout', () => {
    const before = view(snapshot(), { initialMethod: 'weixin' })
    expect(before).toMatch(/<strong>微信<\/strong><span[^>]*>实验功能<\/span>/)
    expect(before).toContain('请先在上方使用微信扫码登录。')
    expect(before).not.toContain('退出微信登录')
    const after = render(snapshot({ workspaceDirectory: '~/projects/demo' }, {}, { hasCredential: true, accountLabel: 'ClawBot decb', enabled: true, status: { state: 'connected' }, pairing: { code: '482915', expiresAt: 1 } }))
    expect(after).toContain('已登录：ClawBot decb')
    expect(after).toContain('aria-label="退出微信登录"')
    expect(after).toContain('在微信的 ClawBot 对话中发送这 6 位数字。10 分钟内有效。')
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
    expect(codexRemoteConfirmText.unbind).toEqual({ title: '解绑？', body: '解绑后，该用户将无法通过手机遥控本机，如需使用需重新配对。', ok: '解绑' })
    expect(codexRemoteConfirmText.logout.title('飞书')).toBe('退出飞书登录？')
    expect(codexRemoteConfirmText.logout.title('微信')).toBe('退出微信登录？')
    // 退出以后怎么登回来，飞书和微信不一样：飞书重新填凭据，微信重新扫码。
    expect(remoteChannelSections.feishu.logoutHint).toBe('退出后需重新填写机器人凭据，方可继续使用手机遥控。')
    expect(remoteChannelSections.weixin.logoutHint).toBe('退出后需重新使用微信扫码登录，方可继续使用手机遥控。')
    expect(codexRemoteConfirmText.logout.ok).toBe('退出登录')
  })

  // YK-5：手机上收到「Codex 启动失败」时，电脑上这一页也看得见、点一下去首页。
  it('says on top of the page that Codex could not start, with a way to the home page', () => {
    const connected = { hasCredential: true, enabled: true, status: { state: 'connected' } } as const
    const failed = view(snapshot({ workspaceDirectory: '~/projects/demo', codexStartFailed: true }, connected), { navigate: () => undefined })
    expect(failed).toContain('data-testid="settings-remote-codex-failed"')
    expect(failed).toContain('xm-tone-warn')
    expect(failed).toContain('<strong>Codex 启动失败</strong>')
    expect(failed).toContain('手机刚发送的指令未执行。请前往首页检查 Codex，恢复后在手机上重新发送。')
    expect(failed).toMatch(/data-testid="settings-remote-codex-failed-home"[^>]*>.*前往首页查看 Codex/)
    expect(failed.indexOf('settings-remote-codex-failed')).toBeLessThan(failed.indexOf('settings-remote-workspace-row'))
    expect(render(snapshot({ workspaceDirectory: '~/projects/demo' }, connected))).not.toContain('settings-remote-codex-failed')
  })

  // YF-9：「打开星芒时自动打开遥控」在共用设置里，默认关，说明把没人在电脑前也会连上说在前头。
  it('keeps the launch switch among the shared settings, off unless turned on, warning that it connects with nobody around', () => {
    expect(codexRemoteAutoStartText).toMatchObject({
      title: '打开星芒时自动打开遥控',
      description: '开启后，每次打开星芒将自动连接，无需在此手动开启。如星芒设为开机自启，即使无人在电脑前，也可通过手机操作。如有顾虑，请勿开启。',
    })
    const off = render(snapshot())
    const row = off.slice(off.indexOf('data-testid="settings-remote-auto-start"'))
    expect(off.indexOf('data-testid="settings-remote-auto-start"')).toBeGreaterThan(off.indexOf('data-testid="settings-remote-feishu"'))
    expect(row).toContain(codexRemoteAutoStartText.title)
    expect(row).toContain(codexRemoteAutoStartText.description)
    expect(row).toMatch(/data-testid="settings-remote-auto-start-switch"><button[^>]*aria-checked="false"[^>]*aria-label="打开星芒时自动打开遥控"/)
    expect(render(snapshot({ autoStart: true }))).toMatch(/data-testid="settings-remote-auto-start-switch"><button[^>]*aria-checked="true"/)
    expect(render(snapshot({ available: false, unavailableReason: '星芒正以管理员身份运行。' }))).toMatch(/data-testid="settings-remote-auto-start-switch"><button[^>]*disabled=""/)
    expect(off).not.toContain('settings-remote-auto-start-failed')
  })

  // YR-7：这次打开星芒没能自动打开时，自动打开那行说明下面一句黄字说原因，原因照抄在这里点开打不开时那句。
  it('says under the launch switch why it could not open by itself this time', () => {
    const reason = '该文件夹已不存在，请重新选择。'
    expect(codexRemoteAutoStartText.failed(reason)).toBe('上次打开星芒时未能自动开启：该文件夹已不存在，请重新选择。')
    const failed = render(snapshot({ autoStart: true, autoStartFailure: reason }))
    const row = failed.slice(failed.indexOf('data-testid="settings-remote-auto-start"'), failed.indexOf('data-testid="settings-remote-idle-close"'))
    expect(row).toContain(codexRemoteAutoStartText.description)
    expect(row).toMatch(/<span class="v2-remote-auto-start-failed" data-testid="settings-remote-auto-start-failed">上次打开星芒时未能自动开启：该文件夹已不存在，请重新选择。<\/span>/)
    expect(row.indexOf(codexRemoteAutoStartText.description)).toBeLessThan(row.indexOf('settings-remote-auto-start-failed'))
    // 开关关着就不说：主进程关掉开关时也会清掉，这里再守一道。
    expect(render(snapshot({ autoStartFailure: reason }))).not.toContain('settings-remote-auto-start-failed')
  })

  // YF-10：「多久没消息就自动关」三选一，缺省「不自动关」并写明还有哪几种办法关；选了时长不写小字。
  it('offers four hours, twelve hours or never for the idle close, never by default with how else it closes', () => {
    expect(codexRemoteIdleCloseText).toEqual({ title: '无消息自动关闭时间', never: '不自动关闭', neverHint: '仅在电脑端、托盘中关闭，或在手机上发送「关闭遥控」时才会关闭。', neverHintMac: '仅在电脑端、菜单栏中关闭，或在手机上发送「关闭遥控」时才会关闭。' })
    const never = render(snapshot())
    const row = never.slice(never.indexOf('data-testid="settings-remote-idle-close"'))
    expect(never.indexOf('data-testid="settings-remote-idle-close"')).toBeGreaterThan(never.indexOf('data-testid="settings-remote-auto-start"'))
    expect(row).toContain('<strong>无消息自动关闭时间</strong>')
    expect(row).toContain('仅在电脑端、托盘中关闭，或在手机上发送「关闭遥控」时才会关闭。')
    expect(row).toMatch(/role="group" aria-label="无消息自动关闭时间" data-testid="settings-remote-idle-close-choice">/)
    expect([...row.matchAll(/aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((match) => [match[2], match[1]])).toEqual([['4 小时', 'false'], ['12 小时', 'false'], ['不自动关闭', 'true']])
    const twelve = render(snapshot({ idleCloseHours: 12 }))
    expect(twelve).not.toContain('仅在电脑端、托盘中关闭')
    expect(twelve).toMatch(/aria-pressed="true"[^>]*>12 小时<\/button>/)
    expect(render(snapshot({ available: false, unavailableReason: '星芒正以管理员身份运行。' }))).toMatch(/<button[^>]*disabled=""[^>]*aria-pressed="true"[^>]*>不自动关闭<\/button>/)
  })

  // 「菜单栏改」：Mac 上两句说菜单栏，别的平台（缺省）照旧说托盘。
  it('says the menu bar instead of the tray on a Mac', () => {
    const state = snapshot({ workspaceDirectory: '/Users/yoyo/work' }, { hasCredential: true })
    const mac = view(state, { isMac: true })
    expect(mac).toContain('窗口收到菜单栏后仍保持开启，退出星芒后才会断开')
    expect(mac).toContain('仅在电脑端、菜单栏中关闭，或在手机上发送「关闭遥控」时才会关闭。')
    expect(mac).not.toContain('托盘')
    const other = render(state)
    expect(other).toContain('窗口缩到托盘后仍保持开启，退出星芒后才会断开')
    expect(other).toContain('仅在电脑端、托盘中关闭，或在手机上发送「关闭遥控」时才会关闭。')
    expect(other).not.toContain('菜单栏')
  })

  it('warns when the credentials only last until the manager closes', () => {
    expect(render(snapshot({ credentialPersistence: 'session-only' }))).toContain('凭据仅在本次运行期间保存')
    expect(render(snapshot({ credentialPersistence: 'unavailable' }))).toContain('凭据无法保存')
    expect(render(snapshot())).not.toContain('data-testid="settings-remote-persistence"')
  })

  // YF-13：坐回电脑前看得出手机最近让它干了什么；只摆时间和结果。
  it('shows the last phone request with stop and decline-all only while a channel is on', () => {
    const now = new Date(2026, 10, 11, 14, 8, 30).getTime()
    const lastRequest = { receivedAt: new Date(2026, 10, 11, 14, 5).getTime(), state: 'running' as const }
    const on = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' as const } }
    const off = view(snapshot({ lastRequest }), { now })
    expect(off).not.toContain('settings-remote-last-request')
    const running = view(snapshot({ lastRequest, task: 'waiting-approval', pendingApprovals: 2 }, on), { now, navigate: () => undefined })
    expect(running).toContain('最近一次')
    expect(running).toContain('14:05 收到指令，正在处理，已用时 3 分钟')
    expect(running).toContain('待确认 2 条，请在手机上回复。')
    expect(running).toContain('<span>停止本轮</span></button>')
    expect(running).toContain('<span>全部拒绝</span></button>')
    expect(running).toContain('<span>查看记录</span></button>')
    // 在文件夹那行上面。
    expect(running.indexOf('settings-remote-last-request')).toBeLessThan(running.indexOf('settings-remote-workspace-row'))
    const done = view(snapshot({ lastRequest: { ...lastRequest, state: 'done' } }, on), { now })
    expect(done).toContain('14:05 已完成')
    expect(done).not.toContain('停止本轮')
    expect(done).not.toContain('都拒绝')
    expect(done).not.toContain('查看记录')
    expect(view(snapshot({}, on), { now })).not.toContain('settings-remote-last-request')
  })

  // YF-12：开着遥控、余额不到 $1 又没订阅时提醒先充值，照样让开。
  it('warns about a low balance only while a channel is on, with a way to top up', () => {
    const on = { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' as const } }
    const warned = view(snapshot({}, on), { lowBalance: 0.8, navigate: () => undefined })
    expect(warned).toContain('data-testid="settings-remote-low-balance"')
    expect(warned).toContain('xm-tone-warn')
    expect(warned).toContain('<strong>余额仅剩 $0.80</strong>')
    expect(warned).toContain('离开电脑后无法充值，建议外出前预先充值。')
    expect(warned).toContain('<span>前往充值</span></button>')
    expect(view(snapshot({}, { ...on, enabled: false }), { lowBalance: 0.8 })).not.toContain('settings-remote-low-balance')
    expect(view(snapshot({}, on), { lowBalance: null })).not.toContain('settings-remote-low-balance')
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

  // YF-7 的用意（只用飞书的人不再摊着微信那一大块和橙色警告）现在由连接方式那组页签做到：没选微信就不摆。
  it('keeps the WeChat warning out of sight until WeChat is picked', () => {
    const feishuOnly = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(feishuOnly).not.toContain('data-testid="settings-remote-weixin-warning"')
    expect(feishuOnly).not.toContain('aria-expanded')
    expect(view(snapshot(), { initialMethod: 'weixin' })).toContain('data-testid="settings-remote-weixin-warning"')
  })

  // YF-3：保存好飞书应用、还没配对时，「还差这几步」下面给一个二维码，手机飞书扫了直接到机器人对话。
  it('offers a QR code that opens the bot chat in Feishu while someone still has to pair', () => {
    const saved = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(saved).toContain('data-testid="settings-remote-feishu-bot-qr"')
    expect(saved).toContain(feishuBotQrText)
    expect(feishuBotQrText).toBe('使用手机飞书扫码，直接打开与机器人的对话')
    const paired = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4', boundPeer: { userIdTail: 'a1b2', boundAt: 1 } }))
    expect(paired).not.toContain('settings-remote-feishu-bot-qr')
  })

  // YF-14：手机上能发图片了，取图要多开「获取单聊、群组消息」（yoyo 2026-11-11「图片改」）。
  it('asks for the permission that lets the bot fetch pictures in the Feishu setup steps', () => {
    expect(feishuSetupSteps[2]).toBe('在「权限管理」中开通「读取用户发给机器人的单聊消息」「获取单聊、群组消息」和「以应用的身份发消息」。')
    const fresh = render(snapshot())
    expect(fresh).toContain('「获取单聊、群组消息」')
  })

  it('builds the Feishu bot chat link only from an App ID that looks right', () => {
    expect(feishuBotChatLink('cli_a1b2c3d4')).toBe('https://applink.feishu.cn/client/bot/open?appId=cli_a1b2c3d4')
    expect(feishuBotChatLink(null)).toBeNull()
    expect(feishuBotChatLink('cli_a1b2&x=1')).toBeNull()
    expect(feishuBotChatLink('https://evil.example/')).toBeNull()
  })
})
