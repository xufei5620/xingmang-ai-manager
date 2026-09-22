import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StartGuide, guideInstallErrorMessage, type GuideToolState, type StartGuideProps } from './StartGuide'

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
})

describe('guide install failure wording', () => {
  it('names the stage that failed and points at the retry button', () => {
    const runtime = guideInstallErrorMessage(new Error('Node.js 运行环境没装上，Claude Code 还没开始安装。下载 Node.js 时 ETIMEDOUT'), 'Claude Code')
    expect(runtime).toBe('运行环境没装上（下载超时），Claude Code 还没开始装。点「再试一次」，还不行就点「需要帮助」。')
    const tool = guideInstallErrorMessage(new Error('Claude Code 安装失败：ENOSPC: no space left on device'), 'Claude Code')
    expect(tool).toBe('Claude Code 没装上（磁盘空间不够）。点「再试一次」，还不行就点「需要帮助」。')
    expect(guideInstallErrorMessage(new Error('something odd'), 'Codex')).toBe('Codex 没装上。点「再试一次」，还不行就点「需要帮助」。')
  })

  it('never borrows the login wording about the Xingmang server or kept input', () => {
    const message = guideInstallErrorMessage(new Error('fetch failed'), 'Codex')
    expect(message).not.toMatch(/星芒服务器|输入已保留/)
    expect(message).toContain('网络连不上')
    expect(guideInstallErrorMessage(new Error('HTTP 401 unauthorized'), 'Codex')).toBe('Codex 没装上。点「再试一次」，还不行就点「需要帮助」。')
  })
})
