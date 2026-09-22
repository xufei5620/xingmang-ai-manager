import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OnboardingSettingRows, tutorialTopics } from './pages-maintenance'
import { pages } from './registry/pages'

const pageIds = new Set<string>(pages.map((page) => page.id))
const pageLabels = new Map<string, string>(
  pages.map((page) => [page.id, page.label.replace(' ↗', '')]),
)

describe('tutorial topics', () => {
  it('covers the three extension pages with a chapter each', () => {
    for (const id of ['mcp', 'skills', 'plugins']) {
      const topic = tutorialTopics.find((entry) => entry.id === id)
      expect(topic, `缺少 ${id} 教程章节`).toBeDefined()
      // 章节标题与侧边导航上的页面名保持一致，用户搜哪个词都找得到。
      expect(topic?.title).toBe(pageLabels.get(id))
      expect(topic?.lead.length).toBeGreaterThan(0)
      // 是什么 / 怎么加 / 怎么验证 / 报错怎么办，四步缺一不可。
      expect(topic?.steps.length).toBe(4)
      for (const step of topic?.steps ?? []) {
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.detail.length).toBeGreaterThan(0)
        expect(step.action.length).toBeGreaterThan(0)
      }
    }
  })

  it('names every tool that actually has a plugin marketplace', () => {
    // 教程一度写着市场仅 Codex，Claude Code 的官方市场接上之后这句就错了。
    const plugins = tutorialTopics.find((entry) => entry.id === 'plugins')
    const text = plugins?.steps.map((step) => step.detail).join('\n') ?? ''
    expect(text).toContain('Claude Code')
    expect(text).toContain('添加官方市场')
    expect(text).toContain('Codex CLI')
  })

  it('keeps the two safety notes the skipped Claude Code welcome page used to carry', () => {
    // #284 替用户跳过了 Claude Code 首启那页英文安全须知，这两句由本教程用中文承担，不能再掉。
    const start = tutorialTopics.find((entry) => entry.id === 'start')
    const text = start?.steps.map((step) => step.detail).join('\n') ?? ''
    expect(text).toContain('都可能出错')
    expect(text).toContain('合并或执行之前自己再过一遍')
    expect(text).toContain('来路不明')
    expect(text).toContain('藏着让 AI 去做别的事的指令')
  })

  it('only links steps at pages the shell can actually navigate to', () => {
    for (const topic of tutorialTopics)
      for (const step of topic.steps) expect(pageIds.has(step.page)).toBe(true)
  })

  it('keeps every topic id unique so the chapter list stays selectable', () => {
    const ids = tutorialTopics.map((topic) => topic.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('settings onboarding entries', () => {
  it('offers both 「再看一遍」 and 「重看导览」 when the app can drive them', () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingSettingRows, { openGuide: () => undefined, replayTour: () => undefined }),
    )
    expect(markup).toContain('data-testid="settings-start-guide"')
    expect(markup).toContain('新手引导')
    expect(markup).toContain('再看一遍')
    expect(markup).toContain('data-testid="settings-replay-tour"')
    expect(markup).toContain('界面导览')
    expect(markup).toContain('重看导览')
    // 两行名字很像，说明必须把它们区分开，否则这一条改回了 A8 修的那个毛病。
    expect(markup).toContain('已经填好的账号和密钥不会被清空')
  })

  it('hides the tour entry when the host cannot replay it', () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingSettingRows, { openGuide: () => undefined }),
    )
    expect(markup).toContain('data-testid="settings-start-guide"')
    expect(markup).not.toContain('data-testid="settings-replay-tour"')
  })
})
