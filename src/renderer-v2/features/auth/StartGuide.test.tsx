import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toolCertificateMessages } from '../../../../electron/network-failure'
import { StartGuide, defaultGuideRoute, guideCanSkipConnect, guideFailureExits, guideInstallFailure, guideInstallExits, guideStepFailure, guideSupportAction, type GuideToolState, type StartGuideProps } from './StartGuide'

const resumeKey = 'fixture-scope'

/**
 * ready 步是引导里唯一的内部状态，没有 DOM 就只能靠恢复进度进去：把一份
 * 「上次停在 ready」的记录塞进 localStorage，组件挂载时就直接渲染完成步。
 * 副作用（重新检测）在 renderToStaticMarkup 下不会跑。
 */
function stubResumedGuide(route: string, step: string) {
  const stored = JSON.stringify({ version: 1, owner: resumeKey, route, step })
  vi.stubGlobal('window', { localStorage: { getItem: () => stored, setItem: () => undefined, removeItem: () => undefined } })
}

function guideTool(overrides: Partial<GuideToolState> = {}): GuideToolState {
  return { id: 'claude', installed: true, configured: true, source: 'account', runtimeReady: true, pythonReady: true, ...overrides }
}

function render(tools: GuideToolState[], overrides: Partial<StartGuideProps> = {}): string {
  const async = async () => undefined
  const props: StartGuideProps = {
    platform: 'win', tools, signedIn: true, resumeKey,
    onDetect: async, onInstall: async, onConfigure: async, onLogin: () => undefined,
    onLaunch: async, onComplete: () => undefined,
    ...overrides,
  }
  return renderToStaticMarkup(<StartGuide {...props} />)
}

describe('renderer-v2 start guide first run', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('hands over the first command and a prompt to paste on the last step', () => {
    stubResumedGuide('claude', 'ready')
    const markup = render([guideTool()])
    expect(markup).toContain('data-guide-step="ready"')
    expect(markup).toContain('data-testid="guide-first-run"')
    expect(markup).toContain('data-testid="guide-first-run-command"')
    expect(markup).toContain('>claude<')
    expect(markup).toContain('data-testid="guide-first-run-copy-command"')
    expect(markup).toContain('data-testid="guide-first-run-copy-prompt"')
    expect(markup).toContain('复制命令')
  })

  // 状态在最后一步变了（Key 没了、工具被卸了）时收尾文案会改口，那时给一条敲下去
  // 必然报错的命令只会让用户更糊涂。
  it('holds the command back when the tool is no longer ready', () => {
    stubResumedGuide('claude', 'ready')
    const markup = render([guideTool({ configured: false, source: 'none' })])
    expect(markup).toContain('data-guide-step="ready"')
    expect(markup).not.toContain('data-testid="guide-first-run"')
  })

  it('says nothing about a terminal for the chat route, which has none', () => {
    stubResumedGuide('chat', 'ready')
    const markup = render([guideTool()])
    expect(markup).toContain('data-guide-step="ready"')
    expect(markup).not.toContain('data-testid="guide-first-run"')
  })

  // 新手没有「项目」这个概念，最后一步要告诉他打开时选什么，并给一颗不用选的按钮。
  it('offers to create a project folder before opening a CLI', () => {
    stubResumedGuide('claude', 'ready')
    const markup = render([guideTool()])
    expect(markup).toContain('data-testid="guide-folder-hint"')
    expect(markup).toContain('不知道选哪个')
    expect(markup).toContain('data-testid="guide-open-tool-new-folder"')
  })

  // 客服远程装好的客户走完引导也不知道要充值、去哪充（2026-09-29 yoyo 反馈）。
  it('points a new customer to top-up on the last step when the tool spends the current account', () => {
    stubResumedGuide('claude', 'ready')
    const markup = render([guideTool()], { onFailureAction: () => undefined })
    expect(markup).toContain('data-testid="guide-recharge"')
    expect(markup).toContain('data-testid="guide-recharge-button"')
    expect(markup).toContain('去充值')
    expect(markup).toContain('左下角余额旁边的「充值」')
    stubResumedGuide('chat', 'ready')
    expect(render([guideTool()], { onFailureAction: () => undefined })).toContain('data-testid="guide-recharge"')
  })

  it('does not send people to top up when the tool spends someone else\'s quota or the host has no way there', () => {
    stubResumedGuide('claude', 'ready')
    expect(render([guideTool({ source: 'official' })], { onFailureAction: () => undefined })).not.toContain('data-testid="guide-recharge"')
    expect(render([guideTool({ source: 'manual' })], { onFailureAction: () => undefined })).not.toContain('data-testid="guide-recharge"')
    expect(render([guideTool({ configured: false, source: 'none' })], { onFailureAction: () => undefined })).not.toContain('data-testid="guide-recharge"')
    expect(render([guideTool()])).not.toContain('data-testid="guide-recharge"')
    stubResumedGuide('claude', 'connect')
    expect(render([guideTool()], { onFailureAction: () => undefined })).not.toContain('data-testid="guide-recharge"')
  })

  it('does not offer a folder for the desktop app, the chat route or a tool that is not ready', () => {
    stubResumedGuide('codexDesktop', 'ready')
    expect(render([guideTool({ id: 'codexDesktop' })])).not.toContain('data-testid="guide-folder-hint"')
    stubResumedGuide('chat', 'ready')
    expect(render([guideTool()])).not.toContain('data-testid="guide-folder-hint"')
    stubResumedGuide('claude', 'ready')
    expect(render([guideTool({ configured: false, source: 'none' })])).not.toContain('data-testid="guide-folder-hint"')
  })

  it('leaves the earlier steps unchanged', () => {
    stubResumedGuide('claude', 'connect')
    const markup = render([guideTool()])
    expect(markup).toContain('data-guide-step="connect"')
    expect(markup).not.toContain('data-testid="guide-first-run"')
  })

  // 引导里留着官方来源的 Gemini 配置,在 CLI 里已经登不上去了(Google 2026-06-18
  // 起停服个人账号)。确认这一步会把限制讲出来,而不是让用户带着它走到最后一屏。
  it('spells out the Gemini enterprise-only limit while the official source is kept', () => {
    stubResumedGuide('gemini', 'connect')
    const markup = render([guideTool({ id: 'gemini', source: 'official' })])
    expect(markup).toContain('data-testid="guide-official-note"')
    expect(markup).toContain('企业版 Code Assist')
  })

  it('stays quiet about it for the other tools and for a relay-backed Gemini', () => {
    stubResumedGuide('claude', 'connect')
    expect(render([guideTool({ source: 'official' })])).not.toContain('data-testid="guide-official-note"')
    stubResumedGuide('gemini', 'connect')
    expect(render([guideTool({ id: 'gemini', source: 'account' })])).not.toContain('data-testid="guide-official-note"')
  })

  it('leaves one install button when the app can prepare the missing runtime itself', () => {
    stubResumedGuide('gemini', 'prepare')
    const markup = render([guideTool({ id: 'gemini', installed: false, configured: false, source: 'none', runtimeReady: false, pythonReady: false, runtimeAutoPrepare: true, pythonAutoPrepare: true })], { onInstallRuntime: async () => undefined, onInstallPython: async () => undefined })
    expect(markup).not.toContain('data-testid="guide-node"')
    expect(markup).not.toContain('data-testid="guide-python"')
    expect(markup).toContain('点「安装」时会一并装好')
    expect(markup).toMatch(/<button[^>]*data-testid="guide-install"(?![^>]*disabled)/)
    expect(markup).not.toMatch(/Node\.js 和 Python|PATH|LTS/)
  })

  // Linux 版拆分 ③：Linux 上 Gemini 不需要 Python，引导不再多一步、也不因为没有 Python 拦着「安装」和「下一步」。
  it('skips the Python step for a Gemini that does not need it on this computer', () => {
    stubResumedGuide('gemini', 'prepare')
    const missing = render([guideTool({ id: 'gemini', installed: false, configured: false, source: 'none', runtimeReady: true, pythonReady: false, pythonNotNeeded: true })], { platform: 'linux', onInstallPython: async () => undefined })
    expect(missing).not.toContain('data-testid="guide-python-step"')
    expect(missing).not.toContain('data-testid="guide-python"')
    expect(missing).toMatch(/<button[^>]*data-testid="guide-install"(?![^>]*disabled)/)
    expect(missing).not.toContain('Python')

    const installed = guideTool({ id: 'gemini', pythonReady: false, pythonNotNeeded: true })
    expect(guideCanSkipConnect('gemini', installed, true)).toBe(true)
  })

  it('keeps the Python step where Gemini still needs it', () => {
    stubResumedGuide('gemini', 'prepare')
    const markup = render([guideTool({ id: 'gemini', installed: false, configured: false, source: 'none', runtimeReady: true, pythonReady: false })], { onInstallPython: async () => undefined })
    expect(markup).toContain('data-testid="guide-python-step"')
    expect(markup).toMatch(/<button[^>]*data-testid="guide-install"[^>]*disabled/)
    expect(guideCanSkipConnect('gemini', guideTool({ id: 'gemini', pythonReady: false }), true)).toBe(false)
    expect(guideCanSkipConnect('gemini', guideTool({ id: 'gemini', pythonReady: false, pythonNotNeeded: false }), true)).toBe(false)
  })

  // 0.2.12～0.2.13 在这里按 Windows 账户类型提醒「装完可能打不开」，是误报，已撤掉。
  it('lets the Codex desktop app install without an account warning', () => {
    stubResumedGuide('codexDesktop', 'prepare')
    const markup = render([guideTool({ id: 'codexDesktop', installed: false, configured: false, source: 'none', installMode: 'managed' })])
    expect(markup).not.toMatch(/Administrator|用户账户控制|可能打不开/)
    expect(markup).toMatch(/<button[^>]*data-testid="guide-install"(?![^>]*disabled)/)
  })

  // 工具已经装了、Node 却太旧：这时没有「安装」可点，运行环境那一行必须留着自己的按钮。
  it('keeps the runtime button when the tool is installed but its runtime is not ready', () => {
    stubResumedGuide('claude', 'prepare')
    const markup = render([guideTool({ runtimeReady: false, runtimeAutoPrepare: true })], { onInstallRuntime: async () => undefined })
    expect(markup).toContain('data-testid="guide-node"')
    expect(markup).not.toContain('data-testid="guide-install"')
  })

  it('keeps the old step-by-step preparation where the runtime has to be installed by hand', () => {
    stubResumedGuide('claude', 'prepare')
    const markup = render([guideTool({ installed: false, runtimeReady: false })], { platform: 'mac', onInstallRuntime: async () => undefined })
    expect(markup).toContain('data-testid="guide-node"')
    expect(markup).toMatch(/<button[^>]*data-testid="guide-install"[^>]*disabled/)
  })

  // Linux 版拆分 ②：Linux 上 Node.js 由本软件准备时，不再说「在应用外安装」、按钮也不叫「安装指南」。
  it('lets a Linux customer install a CLI with one button once the app prepares Node.js', () => {
    stubResumedGuide('claude', 'prepare')
    const markup = render([guideTool({ installed: false, runtimeReady: false, runtimeAutoPrepare: true })], { platform: 'linux', onInstallRuntime: async () => undefined })
    expect(markup).toContain('点「安装」时会一并装好')
    expect(markup).toMatch(/<button[^>]*data-testid="guide-install"(?![^>]*disabled)/)
    expect(markup).not.toContain('data-testid="guide-node"')
    expect(markup).not.toContain('在应用外安装')
  })

  // Mac 上 Node.js 也是本软件准备的（第十六批 2）：这一行以前照旧叫人去应用外装，点下去其实是
  // 星芒自己去下（已知9）。现在和 Linux 一样按能力判断。
  it('offers the one-click runtime button on Linux and Mac when the installed tool needs a newer Node.js', () => {
    for (const platform of ['linux', 'mac'] as const) {
      stubResumedGuide('claude', 'prepare')
      const markup = render([guideTool({ runtimeReady: false, runtimeAutoPrepare: true })], { platform, onInstallRuntime: async () => undefined })
      expect(markup).toMatch(/data-testid="guide-node"[^>]*>.*一键安装/)
      expect(markup).toContain('命令行工具需要运行环境')
      expect(markup).not.toContain('安装指南')
      expect(markup).not.toContain('在应用外安装')
      vi.unstubAllGlobals()
    }
  })

  it('keeps the by-hand wording on Linux and Mac when the app cannot prepare Node.js', () => {
    for (const platform of ['linux', 'mac'] as const) {
      stubResumedGuide('claude', 'prepare')
      const markup = render([guideTool({ runtimeReady: false, runtimeAutoPrepare: false })], { platform, onInstallRuntime: async () => undefined })
      expect(markup).toContain('在应用外安装完成后回来重新检测')
      expect(markup).toMatch(/data-testid="guide-node"[^>]*>.*安装指南/)
      vi.unstubAllGlobals()
    }
  })

  // 全面检测 Q50：装着 2.1.42 也说「已经装好」，人要到打开工具才发现差了一截。
  it('says an installed tool is out of date and offers the update without blocking the next step', () => {
    stubResumedGuide('claude', 'prepare')
    const markup = render([guideTool({ version: '2.1.42', update: { version: '2.1.277', target: '2.1.277', newer: true, knownIssue: false, manualHint: null } })])
    expect(markup).toContain('Claude Code 已经装好，但版本旧了，建议先点「更新」。不更新也能直接点「下一步」。')
    expect(markup).toContain('已找到 v2.1.42，新版是 2.1.277')
    expect(markup).toMatch(/data-testid="guide-tool-status"[^>]*>可更新</)
    expect(markup).toMatch(/<button[^>]*data-testid="guide-update"(?![^>]*disabled)/)
    expect(markup).toMatch(/<button[^>]*data-testid="guide-next"(?![^>]*disabled)/)
  })

  it('calls a version with a known problem what it is and stops advertising the skip', () => {
    stubResumedGuide('codex', 'prepare')
    const markup = render([guideTool({ id: 'codex', version: '0.155.0', update: { version: '0.155.1', target: '0.155.1', newer: true, knownIssue: true, manualHint: null } })])
    expect(markup).toContain('Codex CLI 已经装好，但这个版本有已知问题，用起来会出错，建议先点「更新」。')
    expect(markup).not.toContain('不更新也能')
    expect(markup).toMatch(/data-testid="guide-tool-status"[^>]*>有已知问题</)
    expect(markup).toMatch(/<button[^>]*data-testid="guide-next"(?![^>]*disabled)/)
  })

  it('points a tool installed some other way at its own updater instead of offering a button', () => {
    stubResumedGuide('claude', 'prepare')
    const markup = render([guideTool({ version: '2.1.42', update: { version: '2.1.277', target: '2.1.277', newer: true, knownIssue: false, manualHint: '该版本由官方安装器管理，请用它自己的方式更新' } })])
    expect(markup).toContain('data-testid="guide-update-manual"')
    expect(markup).toContain('建议先用它原来的方式更新')
    expect(markup).not.toContain('data-testid="guide-update"')
  })

  it('keeps the plain installed wording when nothing needs updating, and says nothing until the tool is ready', () => {
    stubResumedGuide('claude', 'prepare')
    const current = render([guideTool({ version: '2.1.277' })])
    expect(current).toContain('Claude Code 已经装好。')
    expect(current).toMatch(/data-testid="guide-tool-status"[^>]*>已安装</)
    expect(current).not.toContain('data-testid="guide-update"')
    const offer = { version: '2.1.277', target: '2.1.277', newer: true, knownIssue: false, manualHint: null }
    const notReady = render([guideTool({ version: '2.1.42', runtimeReady: false, update: offer })], { onInstallRuntime: async () => undefined })
    expect(notReady).not.toContain('data-testid="guide-update"')
    expect(notReady).not.toContain('版本旧了')
  })
})

describe('guide setup result card', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows detected installation and billing separately from an unfinished first task', () => {
    stubResumedGuide('codexDesktop', 'ready')
    const markup = render([guideTool({ id: 'codexDesktop', version: '1.2.3' })])
    expect(markup).toContain('data-testid="guide-result"')
    expect(markup).toContain('data-testid="guide-result-install"')
    expect(markup).toContain('已装好（版本 1.2.3）')
    expect(markup).toContain('data-testid="guide-result-billing"')
    expect(markup).toContain('花的是当前账号的余额。')
    expect(markup).toContain('Codex 桌面端 已准备好。打开工具，即可开始第一次任务。')
    expect(markup).toContain('data-testid="guide-first-task-copy"')
    expect(markup).toContain('data-testid="guide-ready-rescan"')
    expect(markup).not.toContain('data-testid="guide-switched-note"')
  })

  it('keeps official login pending and gives no first task when connection is missing', () => {
    stubResumedGuide('codexDesktop', 'connect')
    const markup = render([guideTool({ id: 'codexDesktop', source: 'official', officialLoginRequired: true })])
    expect(markup).toContain('data-testid="guide-result-connection"')
    expect(markup).toContain('ChatGPT 账号，还没登录')
    expect(markup).toContain('不扣当前账号的余额')
    expect(markup).not.toContain('data-testid="guide-first-task-copy"')
  })

  it('takes back readiness when the installed status is no longer confirmed', () => {
    stubResumedGuide('codexDesktop', 'ready')
    const markup = render([guideTool({ id: 'codexDesktop', installed: false })])
    expect(markup).toContain('还没装好')
    expect(markup).toMatch(/<button[^>]*data-testid="guide-open-tool"[^>]*disabled/)
    expect(markup).not.toContain('data-testid="guide-first-task-copy"')
  })
})

describe('guide install failure wording', () => {
  it('names the stage that failed and points at the retry button', () => {
    const runtime = guideInstallFailure(new Error('Node.js 运行环境没装上，Claude Code 还没开始安装。下载 Node.js 时 ETIMEDOUT'), 'Claude Code').message
    expect(runtime).toBe('运行环境没装上（下载超时），Claude Code 还没开始装。点「再试一次」，还不行就点「需要帮助」。')
    const tool = guideInstallFailure(new Error('Claude Code 安装失败：ENOSPC: no space left on device'), 'Claude Code').message
    expect(tool).toBe('Claude Code 没装上（磁盘空间不够）。点「再试一次」，还不行就点「需要帮助」。')
    expect(guideInstallFailure(new Error('something odd'), 'Codex').message).toBe('Codex 没装上（没认出是哪一类问题，原话在下面）。点「再试一次」，还不行就点「需要帮助」。')
  })

  it('never borrows the login wording about the Xingmang server or kept input', () => {
    const message = guideInstallFailure(new Error('fetch failed'), 'Codex').message
    expect(message).not.toMatch(/星芒服务器|输入已保留/)
    expect(message).toContain('网络连不上')
    expect(guideInstallFailure(new Error('HTTP 401 unauthorized'), 'Codex').message).toBe('Codex 没装上（没认出是哪一类问题，原话在下面）。点「再试一次」，还不行就点「需要帮助」。')
  })
})

describe('guide install failure exits', () => {
  const outdatedNode = new Error(`Claude Code 安装失败：npm 官方源：SELF_SIGNED_CERT_IN_CHAIN。${toolCertificateMessages.outdatedNode}`)

  it('offers the Node.js replacement where this app can do it and says the guide carries on', () => {
    expect(guideInstallExits(outdatedNode, true).map((action) => action.id)).toEqual(['replaceNode', 'log'])
    expect(guideInstallFailure(outdatedNode, 'Claude Code', true).message).toBe('Claude Code 没装上：这台电脑上的 Node.js 太旧，认不了公司电脑装的证书。点「换成新版 Node.js」，换好后星芒会接着装。')
  })

  it('falls back to support where the replacement is out of reach', () => {
    expect(guideInstallExits(outdatedNode, false).map((action) => action.id)).toEqual(['log', 'support'])
    expect(guideInstallFailure(outdatedNode, 'Claude Code', false).message).toContain('点「再试一次」，还不行就点「需要帮助」')
  })

  it('borrows the error dialog exits for the other install failures', () => {
    expect(guideInstallExits(new Error('Claude Code 安装失败：ENOSPC: no space left on device')).length).toBeGreaterThan(0)
    expect(guideInstallExits(new Error('Claude Code 安装失败：ENOSPC: no space left on device')).map((action) => action.id)).not.toContain('retry')
  })

  it('always leaves at least a way to reach support', () => {
    expect(guideInstallExits(new Error('something odd'))).toEqual([{ id: 'support', label: '找客服' }])
  })
})

describe('guide step failure wording', () => {
  it('names the kind of failure instead of blaming the Xingmang server', () => {
    const runtime = guideStepFailure(new Error('Node.js 下载超时，请检查网络后重试'), '准备环境').message
    expect(runtime).toBe('准备环境没有成功：下载超时。下载没有完成，已安装的工具不受影响。')
    expect(guideStepFailure(new Error('ETIMEDOUT'), '检测工具').message).toBe('检测工具没有成功：网络连不上。检查网络后点「再试一次」。')
    expect(guideStepFailure(new Error('EPERM: operation not permitted'), '准备 Python').message).toContain('写不进安装目录')
  })

  it('tells a switch that could not write the config file what to close and which buttons to press (known 29)', () => {
    // 以前叫人去查安装目录的写入权限，可「改用当前账号」写的是工具的配置文件；
    // 目录里那句说的「重试」「找客服」在引导里叫「再试一次」「复制给客服」。
    const raw = "Claude Code 改用当前账号没有完成：EPERM: operation not permitted, open 'C:\\Users\\alice\\.claude\\settings.json'。已恢复到切换前的配置。"
    const failure = guideStepFailure(new Error(raw), '改用当前账号', true)
    expect(failure.message).toBe('改用当前账号没有成功：写不进配置文件。常见是安全软件拦了，或者这个文件正被别的程序占着。关掉正在用这个工具的窗口后点「再试一次」，还不行就点「复制给客服」发给客服。')
    expect(failure.reason).toBe('写不进配置文件')
    expect(failure.detail).toContain('EPERM')
    expect(failure.detail).not.toContain('alice')
    expect(guideStepFailure(new Error(raw), '改用当前账号').message).toMatch(/关掉正在用这个工具的窗口后点「再试一次」，还不行就点「需要帮助」。$/)
    expect(guideStepFailure(new Error('切换前的备份没有完成，已取消切换，配置没有改动：EACCES: permission denied'), '改用当前账号', true).reason).toBe('写不进配置文件')
    // 装东西的几步照旧是安装目录。
    expect(guideStepFailure(new Error('EPERM: operation not permitted'), '准备 Python', true).reason).toBe('写不进安装目录')
  })

  it('keeps a Chinese reason the main process already wrote, with paths redacted', () => {
    expect(guideStepFailure(new Error('请先确认账号连接，再打开工具。'), '打开工具').message).toBe('请先确认账号连接，再打开工具。')
    expect(guideStepFailure(new Error('找不到 C:\\Users\\alice\\.codex\\config.toml'), '确认连接').message).not.toContain('alice')
  })

  it('does not show an English failure as is because its redacted path reads as Chinese', () => {
    // 脱敏后的占位词「本地配置文件」本身是汉字，以前这句英文整句上屏（第三十批 A）。
    const failure = guideStepFailure(new Error("ENOENT: no such file or directory, open 'C:\\Users\\张三\\.codex\\auth.json'"), '确认连接', true)
    expect(failure.message).toBe('确认连接没有成功（没认出是哪一类问题，原话在下面）。点「再试一次」，还不行就点「复制给客服」发给客服。')
    expect(failure.detail).toBe("ENOENT: no such file or directory, open '本地配置文件")
  })

  it('never borrows the login wording', () => {
    for (const reason of ['fetch failed', 'something odd', 'Node.js 下载超时，请检查网络后重试', '请先确认账号连接，再打开工具。']) {
      expect(guideStepFailure(new Error(reason), '打开工具').message).not.toMatch(/星芒服务器|输入已保留/)
    }
    expect(guideStepFailure(new Error('something odd'), '打开工具').message).toBe('打开工具没有成功（没认出是哪一类问题，原话在下面）。点「再试一次」，还不行就点「需要帮助」。')
  })
})

describe('guide failure reason and raw text for support', () => {
  it('keeps the raw text when the reason is not recognised and points at copying it for support', () => {
    const failure = guideInstallFailure(new Error('npm ERR! code E999 weird thing'), 'Claude Code', false, true)
    expect(failure.message).toBe('Claude Code 没装上（没认出是哪一类问题，原话在下面）。点「再试一次」，还不行就点「复制给客服」发给客服。')
    expect(failure.reason).toBeUndefined()
    expect(failure.detail).toBe('npm ERR! code E999 weird thing')
  })

  it('keeps the raw text folded behind a recognised reason', () => {
    const failure = guideInstallFailure(new Error('Claude Code 安装失败：ENOSPC: no space left on device'), 'Claude Code', false, true)
    expect(failure.reason).toBe('磁盘空间不够')
    expect(failure.detail).toContain('ENOSPC')
    expect(failure.message).toContain('还不行就点「需要帮助」')
  })

  it('drops nothing on the step failures either and masks keys', () => {
    const failure = guideStepFailure(new Error('helper said no for sk-abcdefghijklmnopqrstuvwxyz0123456789'), '改用当前账号', true)
    expect(failure.message).toContain('（没认出是哪一类问题，原话在下面）')
    expect(failure.message).toContain('点「复制给客服」发给客服')
    expect(failure.detail).toBe('helper said no for [REDACTED]')
  })

  it('masks keys in a Chinese reason shown as is and keeps no duplicate raw text', () => {
    const failure = guideStepFailure(new Error('写入失败，密钥 sk-abcdefghijklmnopqrstuvwxyz0123456789 不对'), '确认连接', true)
    expect(failure.message).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(failure.detail).toBeUndefined()
  })

  it('names the guide step and tool for the support bundle', () => {
    expect(guideSupportAction('安装工具', 'Claude Code')).toBe('新手引导 · 安装 Claude Code')
    expect(guideSupportAction('改用当前账号', 'Codex CLI')).toBe('新手引导 · Codex CLI 改用当前账号')
    expect(guideSupportAction('准备环境', 'Gemini CLI')).toBe('新手引导 · 准备环境')
  })
})

describe('guide default route', () => {
  it('keeps where the user left off, otherwise picks the recommended tool when it is shown', () => {
    expect(defaultGuideRoute('gemini', ['claude', 'codexDesktop'])).toBe('gemini')
    expect(defaultGuideRoute(null, ['claude', 'codexDesktop'])).toBe('codexDesktop')
    expect(defaultGuideRoute(undefined, ['claude', 'codex'])).toBeNull()
  })

  it('opens a fresh guide with the recommended tool selected, first and labelled', () => {
    for (const platform of ['win', 'mac'] as const) {
      const markup = render([], { platform })
      expect(markup).toContain('data-guide-route="codexDesktop"')
      expect(markup.indexOf('guide-route-codexDesktop')).toBeLessThan(markup.indexOf('guide-route-claude'))
      expect(markup).toContain('data-testid="guide-recommended"')
      expect(markup).not.toMatch(/Node\.js|Python/)
      expect(markup).toMatch(/<button[^>]*data-testid="guide-next"(?![^>]*disabled)/)
    }
  })

  it('preselects Codex CLI on Linux, where the desktop app does not exist', () => {
    expect(defaultGuideRoute(null, ['claude', 'codex', 'gemini', 'grok'], 'codex')).toBe('codex')
    const markup = render([], { platform: 'linux' })
    expect(markup).toContain('data-guide-route="codex"')
    expect(markup).not.toContain('guide-route-codexDesktop')
    expect(markup.indexOf('guide-route-codex"')).toBeLessThan(markup.indexOf('guide-route-claude'))
    expect(markup.match(/data-testid="guide-recommended"/g)).toHaveLength(1)
    expect(markup).toMatch(/<button[^>]*data-testid="guide-next"(?![^>]*disabled)/)
  })
})

describe('guide choose step runtime wording', () => {
  // Mac 跟 Linux 一样按能力判断（已知9）：Node.js 由本软件准备时，不再说「要先按提示准备」。
  it('says the app prepares the runtime on Linux and Mac only when it really does', () => {
    for (const platform of ['linux', 'mac'] as const) {
      const managed = render([guideTool({ runtimeAutoPrepare: true })], { platform })
      expect(managed).toContain('命令行，会自动帮你准备运行环境')
      expect(managed).not.toContain('要先按提示准备运行环境')
      const external = render([guideTool({ runtimeAutoPrepare: false })], { platform })
      expect(external).toContain('命令行，要先按提示准备运行环境')
    }
  })

  it('keeps the Windows wording unchanged', () => {
    expect(render([guideTool({ runtimeAutoPrepare: true })], { platform: 'win' })).toContain('命令行，会自动帮你准备运行环境')
    expect(render([guideTool({ runtimeAutoPrepare: false })], { platform: 'win' })).toContain('命令行，会自动帮你准备运行环境')
  })
})

describe('guide connect step skipping', () => {
  it('skips only when the account key is already written and the tool is ready', () => {
    expect(guideCanSkipConnect('claude', guideTool(), true)).toBe(true)
    expect(guideCanSkipConnect('codexDesktop', guideTool({ id: 'codexDesktop', runtimeReady: false }), true)).toBe(true)
  })

  it('still stops for third-party config, official accounts, typed keys, a missing key, unfinished preparation and chat', () => {
    expect(guideCanSkipConnect('claude', guideTool({ source: 'unknown' }), true)).toBe(false)
    expect(guideCanSkipConnect('claude', guideTool({ source: 'official' }), true)).toBe(false)
    expect(guideCanSkipConnect('codex', guideTool({ id: 'codex', source: 'official', officialLoginRequired: true }), true)).toBe(false)
    expect(guideCanSkipConnect('claude', guideTool({ source: 'manual' }), true)).toBe(false)
    expect(guideCanSkipConnect('claude', guideTool({ configured: false }), true)).toBe(false)
    expect(guideCanSkipConnect('claude', guideTool({ runtimeReady: false }), true)).toBe(false)
    expect(guideCanSkipConnect('chat', undefined, true)).toBe(false)
    expect(guideCanSkipConnect(null, guideTool(), true)).toBe(false)
  })

  it('tells the user on the last step that the current account is already connected', () => {
    stubResumedGuide('claude', 'ready')
    expect(render([guideTool()])).toContain('data-testid="guide-connected-note"')
    stubResumedGuide('claude', 'ready')
    expect(render([guideTool({ source: 'official' })])).not.toContain('data-testid="guide-connected-note"')
  })
})

describe('guide connect step with a key the current account did not write', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const switchable = { onSwitchAccount: async () => null, accountName: 'peaker' }

  it('offers one button named after the account and hides the grey next button for another site', () => {
    stubResumedGuide('codexDesktop', 'connect')
    const markup = render([guideTool({ id: 'codexDesktop', source: 'unknown', configured: false, keyState: 'otherSite' })], switchable)
    expect(markup).toContain('Codex 桌面端 现在用的不是当前账号的 Key。')
    expect(markup).toContain('点「改用 peaker」就能接着往下走')
    expect(markup).toContain('Codex CLI 和 Codex 桌面端共用这份设置，会一起改。')
    expect(markup).toContain('data-testid="guide-switch-account"')
    expect(markup).toContain('>改用 peaker<')
    expect(markup).not.toContain('data-testid="guide-next"')
    expect(markup).not.toContain('data-testid="guide-config"')
    // 界面上不说对方是谁。
    expect(markup).not.toContain('别处')
  })

  it('asks a signed-out user to sign in first', () => {
    stubResumedGuide('claude', 'connect')
    const markup = render([guideTool({ source: 'unknown', configured: false, keyState: 'otherSite' })], { ...switchable, signedIn: false, accountName: null })
    expect(markup).toContain('>登录后改用我的账号<')
  })

  it('lets a usable key from another account on this site through, with the switch as a second choice', () => {
    stubResumedGuide('claude', 'connect')
    const markup = render([guideTool({ source: 'unknown', keyState: 'otherAccount' })], switchable)
    expect(markup).toContain('现在用的 Key 可能不是当前账号的')
    expect(markup).toContain('用量可能算到别的账号上')
    expect(markup).toContain('data-testid="guide-next"')
    expect(markup).not.toMatch(/data-testid="guide-next"[^>]*disabled/)
  })

  it('does not call a changed config somebody else\'s key', () => {
    stubResumedGuide('claude', 'connect')
    const markup = render([guideTool({ source: 'unknown', keyState: 'changed' })], switchable)
    expect(markup).toContain('配置在软件之外被改动过')
    expect(markup).not.toContain('不是当前账号的')
  })

  it('names the official account and keeps the switch as a second button', () => {
    stubResumedGuide('codex', 'connect')
    const markup = render([guideTool({ id: 'codex', source: 'official' })], switchable)
    expect(markup).toContain('ChatGPT 账号')
    expect(markup).toContain('data-testid="guide-switch-account"')
    expect(markup).toContain('data-testid="guide-next"')
  })

  it('keeps the old configure path when the caller cannot switch', () => {
    stubResumedGuide('claude', 'connect')
    const markup = render([guideTool({ source: 'unknown', configured: false, keyState: 'otherSite' })])
    expect(markup).toContain('data-testid="guide-config"')
    expect(markup).not.toContain('data-testid="guide-switch-account"')
  })
})

describe('guide switch failure exits', () => {
  it('sends a tool the account has not opened to support and a failed undo to the backups page', () => {
    expect(guideFailureExits(new Error('改用当前账号没有完成：分组不存在、不可用或名称重复。已恢复到切换前的配置。')).map((action) => action.id)).toEqual(['support'])
    expect(guideFailureExits(new Error('改用当前账号没有完成：EPERM。自动恢复也没有完成（EPERM），请到「备份」里恢复切换前那一份。')).map((action) => action.id)).toEqual(['backups', 'support'])
    expect(guideFailureExits('不过账号余额不足，充值后再试。').map((action) => action.id)).toEqual(['recharge'])
    expect(guideFailureExits(new Error('something odd'))).toEqual([])
  })

  it('keeps the same buttons when the switch could not write the config file (known 29)', () => {
    // 改的只是那句话：按钮照旧是「再试一次」「复制给客服」和这里的「查看日志」，不多出「找客服」。
    expect(guideFailureExits(new Error("Claude Code 改用当前账号没有完成：EPERM: operation not permitted, open 'C:\\Users\\alice\\.claude\\settings.json'。已恢复到切换前的配置。")))
      .toEqual([{ id: 'log', label: '查看日志' }])
  })
})
