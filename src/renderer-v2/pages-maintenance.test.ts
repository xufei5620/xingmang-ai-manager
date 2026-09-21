import { describe, expect, it } from 'vitest'
import { tutorialTopics } from './pages-maintenance'
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

  it('only links steps at pages the shell can actually navigate to', () => {
    for (const topic of tutorialTopics)
      for (const step of topic.steps) expect(pageIds.has(step.page)).toBe(true)
  })

  it('keeps every topic id unique so the chapter list stays selectable', () => {
    const ids = tutorialTopics.map((topic) => topic.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
