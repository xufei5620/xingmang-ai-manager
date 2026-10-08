import { describe, expect, it } from 'vitest'
import { pageRegistry } from '../../registry/pages'
import { tutorialTopics, tutorialTopicsFor } from '../../registry/tutorials'
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
    expect(searchCommands('开机')[0]).toMatchObject({ page: 'settings', section: 'launch-at-login' })
    expect(searchCommands('开机').some((item) => item.section === 'startup')).toBe(true)
    expect(searchCommands('通知')[0]).toMatchObject({ page: 'settings', section: 'notifications' })
    expect(searchCommands('隐私')[0]).toMatchObject({ page: 'settings', section: 'privacy' })
    expect(searchCommands('卸载')[0]).toMatchObject({ group: 'page', page: 'maintenance' })
  })

  it('leaves out pages this computer does not have, such as game acceleration on Linux', () => {
    const pageVisible = (page: string) => page !== 'acceleration'
    expect(searchCommands('', { pageVisible }).map((item) => item.page)).toEqual(pageRegistry.map((page) => page.id).filter((id) => id !== 'acceleration'))
    expect(searchCommands('加速', { pageVisible }, tutorialTopicsFor('linux')).some((item) => item.page === 'acceleration' || item.section === 'acceleration')).toBe(false)
    expect(searchCommands('加速')[0]).toMatchObject({ group: 'page', page: 'acceleration' })
  })

  it('searches the Linux tutorials on Linux, so it never offers the desktop-app chapters there', () => {
    const linux = tutorialTopicsFor('linux')
    const hits = searchCommands('桌面端', {}, linux)
    for (const item of hits.filter((entry) => entry.group === 'tutorial')) expect(linux.some((topic) => topic.id === item.section)).toBe(true)
    expect(hits.some((item) => item.section === 'install' || item.section === 'launch')).toBe(false)
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

  it('offers the account center switch button under the account center, whichever tabs the account has', () => {
    expect(searchCommands('切换账号').find((item) => item.group === 'account')).toEqual({
      key: 'account:switch-account', group: 'account', label: '切换账号', page: 'account', section: 'switch-account',
    })
    expect(searchCommands('换号', { accountTabVisible: () => false }).some((item) => item.key === 'account:switch-account')).toBe(true)
  })

  it('returns nothing for text no page, setting or tutorial mentions', () => {
    expect(searchCommands('qqqqzzzz')).toEqual([])
  })
})

describe('searchCommands for single settings', () => {
  function settingsHits(query: string, options: Parameters<typeof searchCommands>[1] = {}) {
    return searchCommands(query, options).filter((item) => item.group === 'settings')
  }

  it('offers each setting on its own, labelled with its group, and opens that row', () => {
    expect(settingsHits('自动更新')[0]).toEqual({ key: 'settings-item:auto-update', group: 'settings', label: '更新与关于 › 自动更新', page: 'settings', section: 'auto-update' })
    expect(settingsHits('测试通知')[0]).toMatchObject({ label: '通知 › 测试通知', section: 'test-notification' })
  })

  it('still offers the group itself next to its rows', () => {
    const hits = settingsHits('通知')
    expect(hits[0]).toMatchObject({ key: 'settings:notifications', section: 'notifications' })
    expect(hits.some((item) => item.section === 'desktop-notifications')).toBe(true)
  })

  it('finds settings by the everyday words customers type', () => {
    const cases: Array<[string, string]> = [
      ['深色', 'theme'], ['太小', 'ui-scale'], ['看不清', 'large-text'], ['黑屏', 'hardware-acceleration'], ['自启', 'launch-at-login'],
      ['最小化', 'close-behavior'], ['项目文件夹', 'workspace'], ['推荐版本', 'latest-cli'], ['下载慢', 'mirror'], ['梯子', 'proxy'],
      ['公司电脑', 'certificate'], ['收不到通知', 'test-notification'], ['换号', 'switch-account'], ['注销', 'logout'],
      ['换电脑', 'transfer'], ['日志', 'logs'], ['版本号', 'version'], ['检查更新', 'update-check'], ['键盘', 'shortcuts'],
      ['从头', 'guide'], ['删除软件', 'uninstall'],
    ]
    for (const [word, section] of cases) expect(settingsHits(word).some((item) => item.section === section), word).toBe(true)
  })

  it('matches a row by its own name and words, not by the name of its group', () => {
    expect(settingsHits('更新与关于').map((item) => item.section)).toEqual(['about'])
  })

  it('leaves out rows this computer or this login does not have', () => {
    const windows = { settingsItemVisible: (item: { when?: string }) => item.when !== 'mac' && item.when !== 'autoUpdate' && item.when !== 'signedIn' }
    expect(settingsHits('卸载星芒', windows).map((item) => item.section)).toEqual(['uninstall'])
    expect(settingsHits('自动更新', windows).some((item) => item.section === 'auto-update')).toBe(false)
    expect(settingsHits('注销', windows)).toEqual([])
    expect(settingsHits('卸载星芒').map((item) => item.section)).toEqual(['uninstall-app', 'uninstall'])
  })

  it('finds the pages and account tabs behind the words that used to find nothing', () => {
    expect(searchCommands('配置')[0]).toMatchObject({ group: 'page', page: 'home' })
    expect(searchCommands('换模型')[0]).toMatchObject({ group: 'page', page: 'home' })
    expect(searchCommands('检查更新')[0]).toMatchObject({ group: 'page', page: 'updates' })
    expect(searchCommands('修改密码').find((item) => item.group === 'account')).toMatchObject({ section: 'overview' })
    for (const word of ['扣费偏好', '先扣', '兑换码', '充值码']) expect(searchCommands(word).find((item) => item.group === 'account'), word).toMatchObject({ section: 'recharge' })
    for (const word of ['限额', '额度上限']) expect(searchCommands(word).find((item) => item.group === 'account'), word).toMatchObject({ section: 'keys' })
    expect(searchCommands('换账号').some((item) => item.section === 'switch-account')).toBe(true)
  })
})
