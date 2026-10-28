import { describe, expect, it } from 'vitest'
import { claudeDesktopRepairedNotice, codexPayloadNotice, toolTemplateFilledNotice, crashReportingNotice, displayCompatNotice, displayRelaunchNotice, settingsSaveNotice, startupCheckFailure, startupCheckLogContext, releaseNoteHeadline, startupDiagnosticsIssues, startupNoticesShown, toolRouteRestartNotice, unexpectedExitNotice, updatedNotice, usageStatsNotice, vaultRecoveredNotice, withStartupNotice, withoutStartupNotice } from './startup-notice'

describe('startup check notices', () => {
  it('keeps the backend sentence as the body so support still sees the original wording', () => {
    const notice = startupCheckFailure('update', '本地更新源暂时不可用')
    expect(notice.title).toBe('更新检查没有完成')
    expect(notice.body).toBe('本地更新源暂时不可用')
    expect(notice.failure).toBe(true)
    expect(notice.action).toEqual({ label: '查看更新', page: 'settings', section: 'version' })
  })

  it('offers no destination for checks whose page would not help', () => {
    expect(startupCheckFailure('appearance', '系统外观没有同步').action).toBeUndefined()
    expect(startupCheckFailure('diagnostics', '启动环境检查没有完成').action).toBeUndefined()
  })

  it('stays silent when the environment check found nothing to handle', () => {
    expect(startupDiagnosticsIssues({ warn: 0, fail: 0, error: 0 })).toBeNull()
    expect(startupDiagnosticsIssues({ warn: 0, fail: -1, error: 0 })).toBeNull()
    expect(startupDiagnosticsIssues({ warn: 0, fail: Number.NaN, error: 0 })).toBeNull()
  })

  it('stays silent when every finding is only worth a look, such as optional runtimes not installed', () => {
    // 只装了 Claude Code 的客户：另外几家 CLI、Python、Git 没装都是 warn，不该每次开机都提。
    expect(startupDiagnosticsIssues({ warn: 5, fail: 0, error: 0 })).toBeNull()
  })

  it('reports environment findings as a result rather than a failure', () => {
    const notice = startupDiagnosticsIssues({ warn: 0, fail: 2, error: 1 })
    expect(notice?.title).toBe('环境检查发现 3 项需要处理')
    expect(notice?.body).toBe('不影响继续使用，有空时到「检查」页看一下就行。')
    expect(notice?.failure).toBe(false)
    expect(notice?.action).toEqual({ label: '去看看', page: 'health', section: 'first-problem' })
  })

  it('leaves warnings out of the count and only mentions them lightly in the body', () => {
    const notice = startupDiagnosticsIssues({ warn: 4, fail: 1, error: 0 })
    expect(notice?.title).toBe('环境检查发现 1 项需要处理')
    expect(notice?.body).toBe('不影响继续使用，有空时到「检查」页看一下就行。另有 4 项可留意。')
  })

  it('explains a rebuilt account store as a fact with a way back in, not as a failed check', () => {
    const notice = vaultRecoveredNotice()
    expect(notice.id).toBe('vault-recovered')
    // 主进程已经把这件事记进运行日志了，界面再报一条错误日志只是重复。
    expect(notice.failure).toBe(false)
    expect(notice.title).toBe('本机保存的登录信息已重置，请重新登录')
    expect(notice.action).toEqual({ label: '去登录', login: true })
  })

  it('keeps the rebuilt-store wording free of site names, file names and blame', () => {
    const notice = vaultRecoveredNotice()
    const text = `${notice.title}${notice.body}`
    expect(text).not.toMatch(/solov|Sub2API|new-api/i)
    expect(text).not.toMatch(/\.dat|\.bak|realm-accounts/)
    expect(text).not.toMatch(/篡改|损坏|攻击/)
  })

  it('replaces an earlier notice from the same check instead of stacking repeats', () => {
    const first = withStartupNotice([], startupCheckFailure('update', '第一次'))
    const second = withStartupNotice(first, startupCheckFailure('update', '第二次'))
    expect(second).toHaveLength(1)
    expect(second[0]?.body).toBe('第二次')
  })

  it('keeps notices from different checks side by side, newest last', () => {
    const notices = withStartupNotice(withStartupNotice([], startupCheckFailure('update', 'A')), startupCheckFailure('appearance', 'B'))
    expect(notices.map((notice) => notice.id)).toEqual(['update', 'appearance'])
    expect(withoutStartupNotice(notices, 'update').map((notice) => notice.id)).toEqual(['appearance'])
    expect(withoutStartupNotice(notices, 'diagnostics')).toHaveLength(2)
  })

  it('names the check in the runtime log context', () => {
    expect(startupCheckLogContext('diagnostics')).toBe('renderer-v2 startup check: diagnostics')
  })

  it('announces the first launch after an update with its first changes and only an acknowledgement', () => {
    // yoyo 定的原则：用户是小白，这张卡片不让人做选择，只有一颗「知道了」。
    const notice = updatedNotice('0.2.9', { justUpdated: true, previousVersion: '0.2.8', notes: ['第一件事：细节', '第二件事。更多', '第三件事', '第四件事'] })
    expect(notice).toEqual({
      id: 'updated',
      failure: false,
      tone: 'ok',
      title: '已更新到 0.2.9',
      body: '这一版的主要改动如下，另外 1 项在「设置 › 版本更新」里可以看到。',
      items: ['第一件事', '第二件事', '第三件事'],
      action: { label: '知道了', dismiss: true },
    })
    expect(updatedNotice('0.2.9', { justUpdated: true, previousVersion: '0.2.8', notes: ['唯一一件'] })?.body).toBe('这一版的改动：')
  })

  it('still confirms the update when the build carried no notes', () => {
    const notice = updatedNotice('0.2.9', { justUpdated: true, previousVersion: null, notes: null })
    expect(notice?.title).toBe('已更新到 0.2.9')
    expect(notice?.body).toBe('已经在用新版本了，可以照常使用。')
    expect(notice?.items).toBeUndefined()
    expect(notice?.action).toEqual({ label: '知道了', dismiss: true })
  })

  it('keeps only the leading clause of a change and trims it to fit the corner card', () => {
    expect(releaseNoteHeadline('修复开着本机加速时安装 CLI 却下载不动：安装用的下载以前从不经过加速线路')).toBe('修复开着本机加速时安装 CLI 却下载不动')
    expect(releaseNoteHeadline('没有标点的一句话')).toBe('没有标点的一句话')
    const long = releaseNoteHeadline('长'.repeat(80))
    expect(long).toHaveLength(36)
    expect(long.endsWith('…')).toBe(true)
  })

  it('says nothing on an ordinary launch or with an old snapshot', () => {
    expect(updatedNotice('0.2.9', { justUpdated: false, previousVersion: '0.2.9', notes: ['一条'] })).toBeNull()
    expect(updatedNotice('0.2.9', null)).toBeNull()
    expect(updatedNotice('0.2.9', undefined)).toBeNull()
  })

  it('tells the user which drive to clean up when settings could not be saved at startup', () => {
    const notice = settingsSaveNotice({ kind: 'disk-full', drive: 'C' })
    expect(notice?.id).toBe('settings-save')
    expect(notice?.failure).toBe(false)
    expect(notice?.title).toBe('部分设置可能保存不上')
    expect(notice?.body).toContain('C 盘空间快满了')
    expect(notice?.action).toEqual({ label: '知道了', dismiss: true })
    expect(settingsSaveNotice({ kind: 'disk-full' })?.body).toContain('电脑磁盘空间快满了')
    expect(settingsSaveNotice({ kind: 'disk-full', drive: 'C:\\Users' })?.body).toContain('磁盘空间')
  })

  it('names the antivirus case and a generic case without technical words', () => {
    expect(settingsSaveNotice({ kind: 'blocked' })?.body).toContain('杀毒软件')
    for (const kind of ['disk-full', 'blocked', 'other'] as const) {
      expect(settingsSaveNotice({ kind })?.body).not.toMatch(/ENOSPC|EPERM|settings\.json|AppData/)
    }
  })

  it('stays silent on a normal launch', () => {
    expect(settingsSaveNotice(undefined)).toBeNull()
    expect(settingsSaveNotice(null)).toBeNull()
  })
})

describe('displayCompatNotice', () => {
  it('stays silent unless this launch fell back to the compatible display on its own', () => {
    expect(displayCompatNotice(undefined)).toBeNull()
    expect(displayCompatNotice(null)).toBeNull()
    expect(displayCompatNotice({})).toBeNull()
  })

  it('asks the user to keep or undo the fallback in plain words', () => {
    const notice = displayCompatNotice({ displayCompat: 'auto' })
    expect(notice).toMatchObject({
      id: 'display-compat',
      failure: false,
      action: { label: '一直用兼容方式', displayCompat: 'keep' },
      secondaryAction: { label: '恢复原来的方式', displayCompat: 'restore' },
    })
    const text = `${notice?.title}${notice?.body}`
    expect(text).toContain('显卡')
    expect(text).not.toMatch(/GPU|硬件加速|渲染/)
  })

  it('offers an immediate relaunch or later', () => {
    expect(displayRelaunchNotice()).toMatchObject({
      id: 'display-relaunch',
      action: { label: '现在重开', relaunch: true },
      secondaryAction: { label: '稍后', dismiss: true },
    })
  })
})

describe('crashReportingNotice', () => {
  it('tells a signed-in user once, without naming the service, and offers to turn reporting off', () => {
    const notice = crashReportingNotice({}, true)
    expect(notice).toMatchObject({
      id: 'crash-reporting',
      failure: false,
      action: { label: '知道了', crashReporting: 'keep' },
      secondaryAction: { label: '不想发送', crashReporting: 'off' },
    })
    expect(notice?.body).toContain('海外的错误收集服务')
    expect(notice?.body).toContain('不含你的账号、密钥、文件路径和聊天内容')
    expect(`${notice?.title}${notice?.body}`).not.toMatch(/sentry/i)
  })

  it('stays quiet before sign-in, once told, or when reporting is already off', () => {
    expect(crashReportingNotice({}, false)).toBeNull()
    expect(crashReportingNotice(null, true)).toBeNull()
    expect(crashReportingNotice({ crashReportingNoticeShown: true }, true)).toBeNull()
    expect(crashReportingNotice({ crashReporting: false }, true)).toBeNull()
  })

  it('waits for the onboarding guide and the interface tour to close', () => {
    expect(crashReportingNotice({}, true)?.waitsForOnboarding).toBe(true)
  })
})

describe('startupNoticesShown', () => {
  const crash = crashReportingNotice({}, true)!
  const vault = vaultRecoveredNotice()
  const diagnostics = startupCheckFailure('diagnostics', 'fixture failure')

  it('holds back only the notices that wait for onboarding while the guide or the tour is open', () => {
    expect(startupNoticesShown([vault, crash, diagnostics], true).map((notice) => notice.id)).toEqual(['vault-recovered', 'diagnostics'])
    const usage = usageStatsNotice({ crashReportingNoticeShown: true }, true, true)!
    expect(startupNoticesShown([usage, vault], true)).toEqual([vault])
  })

  it('shows every notice, in its original order, once onboarding is closed', () => {
    const notices = [vault, crash, diagnostics]
    expect(startupNoticesShown(notices, false)).toBe(notices)
  })

  it('leaves notices without the flag alone, so news the user must act on is never held back', () => {
    for (const notice of [vault, diagnostics, displayRelaunchNotice(), settingsSaveNotice({ kind: 'disk-full' })!]) {
      expect(notice.waitsForOnboarding).toBeUndefined()
      expect(startupNoticesShown([notice], true)).toEqual([notice])
    }
  })
})

describe('usageStatsNotice', () => {
  const told = { crashReportingNoticeShown: true }

  it('tells a signed-in user once what is sent and offers to turn it off', () => {
    const notice = usageStatsNotice(told, true, true)
    expect(notice).toEqual({
      id: 'usage-stats',
      failure: false,
      tone: 'neutral',
      title: '软件会发送匿名使用情况',
      body: '为了知道新版本有没有顺利装上、哪里容易出错，星芒每天最多发一次匿名使用情况：版本、电脑系统、装了哪些工具、安装和更新是否成功。不含你的账号、密钥、文件路径和聊天内容，也没有能认出这台电脑的编号。以后想改，可以在「设置」的「隐私数据」里关掉。',
      action: { label: '知道了', usageStats: 'keep' },
      secondaryAction: { label: '不想发送', usageStats: 'off' },
      waitsForOnboarding: true,
    })
  })

  it('waits for the crash reporting notice, and stays quiet before sign-in, once told, or when already off', () => {
    expect(usageStatsNotice({}, true, true)).toBeNull()
    expect(usageStatsNotice({ crashReporting: false }, true, true)).not.toBeNull()
    expect(usageStatsNotice(told, false, true)).toBeNull()
    expect(usageStatsNotice(null, true, true)).toBeNull()
    expect(usageStatsNotice({ ...told, usageStatsNoticeShown: true }, true, true)).toBeNull()
    expect(usageStatsNotice(told, true, false)).toBeNull()
    expect(usageStatsNotice(told, true, null)).toBeNull()
  })
})

describe('unexpectedExitNotice', () => {
  const at = new Date(2026, 8, 30, 14, 37).getTime()

  it('stays silent when the last run did not end unexpectedly', () => {
    expect(unexpectedExitNotice(undefined)).toBeNull()
    expect(unexpectedExitNotice({})).toBeNull()
    expect(unexpectedExitNotice({ unexpectedExit: { relaunched: true, exits: [] } })).toBeNull()
  })

  it('says the app came back by itself and offers a copy for support', () => {
    const notice = unexpectedExitNotice({ unexpectedExit: { relaunched: true, exits: [{ at, error: 'TypeError: x is undefined' }] } })
    expect(notice?.id).toBe('unexpected-exit')
    expect(notice?.failure).toBe(false)
    expect(notice?.body).toBe('星芒刚才意外退出了，已经重新打开。错误信息已经记下来，点「复制给客服」发给客服就行。')
    expect(notice?.secondaryAction).toEqual({ label: '知道了', dismiss: true })
    const action = notice?.action
    if (!action || !('supportFailure' in action)) throw new Error('expected a support copy action')
    expect(action.label).toBe('复制给客服')
    expect(action.supportFailure).toEqual({
      at: new Date(at),
      action: '星芒自己意外退出',
      message: '已自动重新打开',
      detail: '14:37 TypeError: x is undefined',
    })
  })

  it('switches wording and carries every recent exit when it did not relaunch again', () => {
    const notice = unexpectedExitNotice({ unexpectedExit: { relaunched: false, exits: [
      { at, error: 'Error: first' },
      { at: at + 3 * 60_000, error: 'Error: second' },
    ] } })
    expect(notice?.title).toBe('星芒刚才又意外退出了')
    expect(notice?.body).toBe('星芒刚才又意外退出了一次，这次没有自动重开。点「复制给客服」，把这几次的信息发给客服。')
    const action = notice?.action
    if (!action || !('supportFailure' in action)) throw new Error('expected a support copy action')
    expect(action.supportFailure.detail).toBe('14:37 Error: first；14:40 Error: second')
    expect(action.supportFailure.at).toEqual(new Date(at + 3 * 60_000))
  })

  it('uses no technical words in what the customer reads', () => {
    for (const relaunched of [true, false]) {
      const notice = unexpectedExitNotice({ unexpectedExit: { relaunched, exits: [{ at, error: 'Error: boom' }] } })
      expect(`${notice?.title}${notice?.body}`).not.toMatch(/主进程|异常|Electron|崩溃|exception/i)
    }
  })
})

describe('toolTemplateFilledNotice', () => {
  it('stays silent when no tool was filled', () => {
    expect(toolTemplateFilledNotice([])).toBeNull()
  })

  it('names the filled tools in display order and only offers a dismiss button', () => {
    const notice = toolTemplateFilledNotice(['grok', 'codex', 'claude'])
    expect(notice).toMatchObject({ id: 'template-filled', failure: false, tone: 'ok', action: { label: '知道了', dismiss: true } })
    expect(notice?.body).toContain('Claude Code、Codex、Grok CLI')
    expect(notice?.body).toContain('「设置 › 备份迁移」')
    expect(notice?.secondaryAction).toBeUndefined()
  })
})

describe('claudeDesktopRepairedNotice', () => {
  it('stays silent when nothing was repaired at startup', () => {
    expect(claudeDesktopRepairedNotice({}, 'windows')).toBeNull()
    expect(claudeDesktopRepairedNotice(null, 'macos')).toBeNull()
  })

  it('says what changed and how to fully quit on each platform, with only a dismiss button', () => {
    const mac = claudeDesktopRepairedNotice({ claudeDesktopRepaired: true }, 'macos')
    expect(mac).toMatchObject({ id: 'claude-desktop-repaired', failure: false, tone: 'ok', action: { label: '知道了', dismiss: true } })
    expect(mac?.secondaryAction).toBeUndefined()
    expect(mac?.body).toContain('别的设置都没动')
    expect(mac?.body).toContain('Command + Q')
    expect(claudeDesktopRepairedNotice({ claudeDesktopRepaired: true }, 'windows')?.body).toContain('托盘里的 Claude 图标')
  })

  it('uses no technical words in what the customer reads', () => {
    for (const platform of ['windows', 'macos', 'linux'] as const) {
      const notice = claudeDesktopRepairedNotice({ claudeDesktopRepaired: true }, platform)
      expect(`${notice?.title}${notice?.body}`).not.toMatch(/inferenceModels|JSON|配置文件|configLibrary|0\.2\.12|网关|gateway|xm\.solov|Sub2API/i)
    }
  })
})

describe('toolRouteRestartNotice', () => {
  it('leads with the approved sentence, lists each tool and offers to restart the desktop app when it can', () => {
    expect(toolRouteRestartNotice({ id: 1, codex: { cli: false, desktop: 'win32', canRestartDesktop: true } })).toEqual({
      id: 'route-restart',
      failure: false,
      tone: 'neutral',
      title: '刚才那条连接线路连不上，已经换到另一条。',
      body: '',
      items: [
        'Codex 桌面端还开着：新建对话就走新线路，已经打开的对话要完全退出再打开。',
        '如果在 VS Code 等编辑器里用着 Codex，新建对话就走新线路，已经打开的对话要重新加载窗口。',
      ],
      action: { label: '帮我重开', restartCodexDesktop: true },
    })
  })

  it('has no button when nothing can be restarted, and nothing to say without a tool', () => {
    expect(toolRouteRestartNotice({ id: 1, grok: 'running' })).not.toHaveProperty('action')
    expect(toolRouteRestartNotice({ id: 1 })).toBeNull()
  })

  it('says why Codex moved when a conversation was too large for line 1, with the same steps below', () => {
    const notice = toolRouteRestartNotice({ id: 1, cause: 'payload-too-large', codex: { cli: true, desktop: null, canRestartDesktop: false } })
    expect(notice?.title).toBe('Codex 里这个对话超过了线路 1 的 100MB 上限，已为你切到线路 2，请重开 Codex 后继续。')
    expect(notice?.items).toEqual([
      'Codex 还开着：新建对话就走新线路，已经打开的对话要退出 Codex 再打开。',
      '如果在 VS Code 等编辑器里用着 Codex，新建对话就走新线路，已经打开的对话要重新加载窗口。',
    ])
  })
})

describe('codexPayloadNotice', () => {
  const newConversation = '请新开一个对话继续；对话里的截图和大文件会让体积变大很快。这时让 Codex 压缩对话也不管用，压缩同样要先把整段对话发上去。'

  it('asks for a new conversation on line 1 and says why the line was not changed', () => {
    const base = '这个对话已经超过 100MB，线路 1 发不出去，在这个对话里发什么都会失败。'
    expect(codexPayloadNotice({ id: 1, kind: 'locked' })).toEqual({
      id: 'codex-payload',
      failure: false,
      tone: 'warn',
      title: 'Codex 里这个对话太大，线路 1 发不出去',
      body: `${base}${newConversation}你在设置里选了只用线路 1，所以没有自动换线路。`,
      action: { label: '知道了', dismiss: true },
    })
    expect(codexPayloadNotice({ id: 1, kind: 'unreachable' }).body).toBe(`${base}${newConversation}线路 2 这会儿也连不上，所以没能帮你换过去。`)
    expect(codexPayloadNotice({ id: 1, kind: 'unfollowed' }).body).toBe(`${base}${newConversation}`)
  })

  it('asks for a new conversation when it is too large for line 2 as well', () => {
    expect(codexPayloadNotice({ id: 1, kind: 'too-large' })).toMatchObject({
      tone: 'warn',
      title: 'Codex 里这个对话太大，发不出去了',
      body: `这个对话已经超过线路 2 的上限，在这个对话里发什么都会失败。${newConversation}`,
    })
  })

  it('warns early in a neutral tone', () => {
    expect(codexPayloadNotice({ id: 1, kind: 'nearing' })).toMatchObject({
      tone: 'neutral',
      title: 'Codex 里有个对话快到线路 1 的上限了',
      body: '对话越聊越大，超过 100MB 后线路 1 就发不出去了。建议手上这件事做完就新开一个对话；截图和大文件会让体积变大很快。',
    })
  })

  it('keeps addresses, status codes and file or command names out of the words', () => {
    for (const kind of ['locked', 'unreachable', 'unfollowed', 'too-large', 'nearing'] as const) {
      const notice = codexPayloadNotice({ id: 1, kind })
      expect(`${notice.title}${notice.body}`).not.toMatch(/413|payload|rollout|compact|\/|solov|Cloudflare|CF|WebSocket|256/i)
    }
  })
})
