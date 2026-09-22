import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StartGuide, type GuideToolState, type StartGuideProps } from './StartGuide'

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
})
