import { describe, expect, it } from 'vitest'
import { pageRegistry } from '../../registry/pages'
import { tutorialTopics } from '../../registry/tutorials'
import { maximumTutorialResults, searchCommands } from './command-search'

describe('searchCommands', () => {
  it('lists only the pages, in sidebar order, when nothing is typed', () => {
    expect(searchCommands('   ').map((item) => item.page)).toEqual(pageRegistry.map((page) => page.id))
    expect(searchCommands('').every((item) => item.group === 'page' && item.section === undefined)).toBe(true)
  })

  it('still finds every page by its own name first', () => {
    for (const page of pageRegistry) expect(searchCommands(page.label)[0]).toMatchObject({ group: 'page', page: page.id })
  })

  it('finds the top-up tab of the account center by everyday words', () => {
    for (const word of ['充值', '余额', '续费', '买']) {
      expect(searchCommands(word).find((item) => item.group === 'account')).toMatchObject({ page: 'account', section: 'recharge' })
    }
    expect(searchCommands('充值')[0]).toMatchObject({ key: 'account:recharge' })
  })

  it('finds the key tab by Key, token and 令牌 in any letter case', () => {
    for (const word of ['密钥', 'key', 'KEY', '令牌']) expect(searchCommands(word)[0]).toMatchObject({ page: 'account', section: 'keys' })
  })

  it('finds settings groups and the install page by their common names', () => {
    expect(searchCommands('开机')[0]).toMatchObject({ page: 'settings', section: 'startup' })
    expect(searchCommands('通知')[0]).toMatchObject({ page: 'settings', section: 'notifications' })
    expect(searchCommands('隐私')[0]).toMatchObject({ page: 'settings', section: 'privacy' })
    expect(searchCommands('卸载')[0]).toMatchObject({ group: 'page', page: 'maintenance' })
  })

  it('finds tutorial topics by the problem the customer describes', () => {
    const hits = searchCommands('打不开')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((item) => item.group === 'tutorial' && item.page === 'tutorial')).toBe(true)
    for (const item of hits) expect(tutorialTopics.some((topic) => topic.id === item.section)).toBe(true)
  })

  it('groups results as pages, account center, settings, then tutorials', () => {
    const order = ['page', 'account', 'settings', 'tutorial']
    for (const word of ['账号', '密码', '版本', '更新']) {
      const groups = searchCommands(word).map((item) => order.indexOf(item.group))
      expect(groups).toEqual([...groups].sort((left, right) => left - right))
    }
  })

  it('keeps only the most relevant tutorials so common words do not flood the list', () => {
    expect(searchCommands('codex').filter((item) => item.group === 'tutorial').length).toBeLessThanOrEqual(maximumTutorialResults)
  })

  it('puts a tutorial whose title matches ahead of one that only mentions the word', () => {
    const tutorials = searchCommands('记录').filter((item) => item.group === 'tutorial')
    expect(tutorials[0]).toMatchObject({ section: 'sessions' })
  })

  it('requires every typed word to match', () => {
    expect(searchCommands('充值 订阅')[0]).toMatchObject({ key: 'account:recharge' })
    expect(searchCommands('充值 zzzz-nothing')).toEqual([])
  })

  it('hides account tabs the current account cannot open', () => {
    const hits = searchCommands('充值', { accountTabVisible: (tab) => tab !== 'recharge' })
    expect(hits.some((item) => item.key === 'account:recharge')).toBe(false)
  })

  it('returns nothing for text no page, setting or tutorial mentions', () => {
    expect(searchCommands('qqqqzzzz')).toEqual([])
  })
})
