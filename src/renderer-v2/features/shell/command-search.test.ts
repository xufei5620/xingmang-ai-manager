import { describe, expect, it } from 'vitest'
import { pageRegistry, retiredPageAlias, settingsPageAlias } from '../../registry/pages'
import { tutorialTopics, tutorialTopicsFor } from '../../registry/tutorials'
import { chatParametersSection, maximumTutorialResults, searchCommands } from './command-search'

// 游戏加速、备份、更新并进了设置（v4 批09），「安装卸载」拆掉了（批10）：它们还在页面表里（老入口靠它换到
// 新去处），但不再单独出页面结果。
const searchablePages = pageRegistry.filter((page) => settingsPageAlias(page.id) === null && retiredPageAlias(page.id) === null)

describe('searchCommands', () => {
  it('lists the everyday actions, then every page, when nothing is typed', () => {
    const empty = searchCommands('   ')
    expect(empty.filter((item) => item.group === 'page').map((item) => item.page)).toEqual(searchablePages.map((page) => page.id))
    expect(empty.map((item) => item.group)).toEqual([...empty.filter((item) => item.group === 'action').map(() => 'action'), ...searchablePages.map(() => 'page')])
    expect(searchCommands('').filter((item) => item.group === 'page').every((item) => item.section === undefined)).toBe(true)
    expect(searchCommands('').filter((item) => item.group === 'action').map((item) => item.label)).toEqual(['充值', '查看用量账单', '开始检查', '帮助与客服', '运行日志', '聊天参数设置'])
  })

  it('offers switching to the other theme only, and sign-out only while signed in', () => {
    expect(searchCommands('', { theme: 'dark' }).find((item) => item.action === 'theme')?.label).toBe('切换到浅色')
    expect(searchCommands('', { theme: 'light' }).find((item) => item.action === 'theme')?.label).toBe('切换到深色')
    expect(searchCommands('主题', { theme: 'dark' }).filter((item) => item.group === 'action').map((item) => item.label)).toEqual(['切换到浅色'])
    expect(searchCommands('退出').some((item) => item.key === 'account:logout')).toBe(false)
    expect(searchCommands('退出', { signedIn: true })[0]).toEqual({ key: 'account:logout', group: 'account', label: '退出登录', page: 'account', action: 'logout' })
  })

  it('runs the check and opens help from the action group', () => {
    expect(searchCommands('开始检查')[0]).toMatchObject({ group: 'action', page: 'health', action: 'check' })
    expect(searchCommands('客服').find((item) => item.group === 'action')).toMatchObject({ label: '帮助与客服', action: 'help' })
    expect(searchCommands('账单')[0]).toMatchObject({ group: 'action', page: 'account', section: 'usage' })
    // 运行日志是「反馈与客服」的一个页签：这一条直接落到那个页签。
    expect(searchCommands('运行日志').find((item) => item.group === 'action')).toEqual({ key: 'action:log', group: 'action', label: '运行日志', page: 'feedback', section: 'log' })
  })

  // 「安装卸载」页拆掉以后安装过程记在运行日志里（#1104 第 13 条）：客户按老习惯搜「安装记录」也要找到它。
  it('finds the run log by the words customers use for install records', () => {
    const hits = searchCommands('安装记录')
    expect(hits.find((item) => item.group === 'page')).toMatchObject({ page: 'feedback' })
    expect(hits.find((item) => item.group === 'action')).toMatchObject({ key: 'action:log', page: 'feedback', section: 'log' })
  })

  // v4 的两套配色叫「黑金深色」「晨曦金浅色」（#1104 第 13 条）：按配色名搜到主题那一行，和切到另一种的那一条。
  it('finds the theme by the names of the two color schemes', () => {
    for (const word of ['黑金', '晨曦', '晨曦金']) expect(searchCommands(word).some((item) => item.key === 'settings-item:theme'), word).toBe(true)
    expect(searchCommands('黑金', { theme: 'light' }).find((item) => item.group === 'action')).toMatchObject({ label: '切换到深色', action: 'theme' })
    expect(searchCommands('晨曦', { theme: 'dark' }).find((item) => item.group === 'action')).toMatchObject({ label: '切换到浅色', action: 'theme' })
    // 已经是黑金深色时，搜「黑金」不给「切换到浅色」。
    expect(searchCommands('黑金', { theme: 'dark' }).some((item) => item.action === 'theme')).toBe(false)
  })

  it('leaves out the top-up and usage actions when the account cannot open those tabs', () => {
    const labels = searchCommands('', { accountTabVisible: (tab) => tab !== 'recharge' && tab !== 'usage' }).filter((item) => item.group === 'action').map((item) => item.label)
    expect(labels).toEqual(['开始检查', '帮助与客服', '运行日志', '聊天参数设置'])
  })

  it('opens the chat parameters dialog from the action group, and leaves it out when chat is not on this computer', () => {
    for (const word of ['聊天参数设置', '系统提示词', '随机度', '温度']) {
      expect(searchCommands(word).find((item) => item.group === 'action')).toEqual({ key: 'action:chat-parameters', group: 'action', label: '聊天参数设置', page: 'chat', section: chatParametersSection })
    }
    expect(searchCommands('系统提示词', { pageVisible: (page) => page !== 'chat' }).some((item) => item.key === 'action:chat-parameters')).toBe(false)
  })

  it('still finds every page by its own name first', () => {
    for (const page of searchablePages) expect(searchCommands(page.label)[0]).toMatchObject({ group: 'page', page: page.id })
  })

  it('finds the cards that moved into settings by their old page names', () => {
    // 加速卡改名「网络加速」以后跟它所在的设置分组同名：只出这张卡一条，就在这一组最上面。
    expect(searchCommands('网络加速')[0]).toMatchObject({ group: 'settings', label: '网络加速', page: 'settings', section: 'acceleration' })
    expect(searchCommands('备份').find((item) => item.group === 'settings')).toMatchObject({ page: 'settings' })
    expect(searchCommands('备份').some((item) => item.section === 'backups')).toBe(true)
    expect(searchCommands('更新').some((item) => item.section === 'version')).toBe(true)
    for (const word of ['网络加速', '备份', '更新']) expect(searchCommands(word).some((item) => item.group === 'page' && settingsPageAlias(item.page) !== null), word).toBe(false)
  })

  // #1362 第 2 条：以前搜「加速」出来「网络加速」「网络加速 › 网络加速」两条，落的是同一处。
  it('lists a settings row that shares its group name once, and the group again when that row is not on this computer', () => {
    for (const word of ['加速', '网络加速']) {
      const settings = searchCommands(word).filter((item) => item.group === 'settings')
      expect(settings.filter((item) => item.label.startsWith('网络加速') && !item.label.includes(' › ')), word).toEqual([
        { key: 'settings-item:acceleration', group: 'settings', label: '网络加速', page: 'settings', section: 'acceleration' },
      ])
      expect(settings.some((item) => item.label === '网络加速 › 网络加速'), word).toBe(false)
    }
    // 别的行照旧写成「组名 › 行名」。
    expect(searchCommands('企业证书').find((item) => item.group === 'settings')).toMatchObject({ label: '网络加速 › 企业证书', section: 'certificate' })
    const withoutAcceleration = searchCommands('网络加速', { settingsItemVisible: (item) => item.id !== 'acceleration' }).filter((item) => item.group === 'settings')
    expect(withoutAcceleration[0]).toEqual({ key: 'settings:network', group: 'settings', label: '网络加速', page: 'settings', section: 'network' })
    expect(withoutAcceleration.some((item) => item.section === 'acceleration')).toBe(false)
  })

  it('finds the top-up tab of the account center by everyday words', () => {
    for (const word of ['充值', '余额', '续费', '买']) {
      expect(searchCommands(word).find((item) => item.group === 'account')).toMatchObject({ page: 'account', section: 'recharge' })
    }
    expect(searchCommands('充值')[0]).toMatchObject({ key: 'action:recharge', page: 'account', section: 'recharge' })
  })

  it('finds the key tab by Key, token and 令牌 in any letter case', () => {
    for (const word of ['密钥', 'key', 'KEY', '令牌']) expect(searchCommands(word)[0]).toMatchObject({ page: 'account', section: 'keys' })
  })

  it('finds settings groups and the new homes of the install page by their common names', () => {
    expect(searchCommands('开机')[0]).toMatchObject({ page: 'settings', section: 'launch-at-login' })
    expect(searchCommands('开机').some((item) => item.section === 'startup')).toBe(true)
    expect(searchCommands('通知')[0]).toMatchObject({ page: 'settings', section: 'notifications' })
    expect(searchCommands('隐私')[0]).toMatchObject({ page: 'settings', section: 'privacy' })
    // 「安装卸载」页拆掉了（批10）：装、卸工具在首页卡片上，运行环境在检查页那几行。
    expect(searchCommands('卸载')[0]).toMatchObject({ group: 'page', page: 'home' })
    expect(searchCommands('安装')[0]).toMatchObject({ group: 'page', page: 'home' })
    for (const word of ['Node.js', 'Python', 'Git', '运行环境']) expect(searchCommands(word)[0], word).toMatchObject({ group: 'page', page: 'health' })
    expect(searchCommands('').some((item) => item.page === 'maintenance')).toBe(false)
  })

  it('leaves out pages this computer does not have, such as game acceleration on Linux', () => {
    const pageVisible = (page: string) => page !== 'chat'
    expect(searchCommands('', { pageVisible }).filter((item) => item.group === 'page').map((item) => item.page)).toEqual(searchablePages.map((page) => page.id).filter((id) => id !== 'chat'))
    const linux = { settingsItemVisible: (item: { when?: string }) => item.when !== 'acceleration' }
    expect(searchCommands('加速', linux, tutorialTopicsFor('linux')).some((item) => item.page === 'acceleration' || item.section === 'acceleration')).toBe(false)
    expect(searchCommands('加速').find((item) => item.section === 'acceleration')).toMatchObject({ group: 'settings', page: 'settings' })
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

  it('groups results as pages, actions, account center, settings, then tutorials', () => {
    const order = ['page', 'action', 'account', 'settings', 'tutorial']
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

  it('finds the parts that used to be tabs of their own, and the entries that moved, by their old names', () => {
    const landing = (query: string) => searchCommands(query).find((item) => item.group === 'account')
    expect(landing('我的订单')).toEqual({ key: 'account:orders', group: 'account', label: '我的订单', page: 'account', section: 'orders' })
    expect(landing('没到账')).toMatchObject({ section: 'orders' })
    expect(landing('异步任务')).toMatchObject({ section: 'tasks' })
    expect(landing('登录设备')).toMatchObject({ section: 'devices' })
    expect(landing('下线')).toMatchObject({ section: 'devices' })
    expect(landing('记住密码')).toMatchObject({ section: 'remember-password' })
    expect(landing('编辑资料')).toMatchObject({ section: 'edit-profile' })
    expect(landing('调用明细')).toMatchObject({ section: 'usage' })
    expect(landing('用量看板')).toMatchObject({ section: 'usage' })
    expect(landing('账号安全')).toMatchObject({ section: 'security' })
  })

  it('leaves out the moved parts the current account cannot use', () => {
    const historical = { accountTabVisible: (tab: string) => !['tasks', 'devices'].includes(tab) }
    expect(searchCommands('异步任务', historical).some((item) => item.section === 'tasks')).toBe(false)
    expect(searchCommands('登录设备', historical).some((item) => item.section === 'devices')).toBe(false)
    expect(searchCommands('修改密码', { accountTabVisible: () => false }).some((item) => item.section === 'change-password')).toBe(true)
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
    expect(settingsHits('自动更新')[0]).toEqual({ key: 'settings-item:auto-update', group: 'settings', label: '版本更新 › 自动下载更新', page: 'settings', section: 'auto-update' })
    // 「发测试通知」并进了桌面通知那一行，搜「测试通知」落到那一行。
    expect(settingsHits('测试通知')[0]).toMatchObject({ label: '消息通知 › 桌面通知', section: 'desktop-notifications' })
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
      ['公司电脑', 'certificate'], ['收不到通知', 'desktop-notifications'], ['网络连接', 'proxy'], ['重置', 'restore-appearance'],
      ['换电脑', 'transfer'], ['日志', 'logs'], ['版本号', 'version'], ['检查更新', 'update-check'], ['键盘', 'shortcuts'],
      ['从头', 'guide'], ['删除软件', 'uninstall'],
    ]
    for (const [word, section] of cases) expect(settingsHits(word).some((item) => item.section === section), word).toBe(true)
  })

  it('matches a row by its own name and words, not by the name of its group', () => {
    expect(settingsHits('版本更新').map((item) => item.section)).toEqual(['about'])
  })

  // 设置里的「账号」组拆掉了：切换账号、退出登录只在个人中心那边搜得到，不再有设置里的那一条。
  it('finds switching and signing out in the account center only', () => {
    expect(settingsHits('换号')).toEqual([])
    expect(settingsHits('注销', { signedIn: true })).toEqual([])
    expect(searchCommands('换号').find((item) => item.group === 'account')).toMatchObject({ section: 'switch-account' })
    expect(searchCommands('注销', { signedIn: true })[0]).toMatchObject({ key: 'account:logout', action: 'logout' })
  })

  it('leaves out rows this computer or this login does not have', () => {
    const windows = { settingsItemVisible: (item: { when?: string }) => item.when !== 'mac' && item.when !== 'autoUpdate' && item.when !== 'acceleration' }
    expect(settingsHits('卸载星芒', windows).map((item) => item.section)).toEqual(['uninstall'])
    expect(settingsHits('自动更新', windows).some((item) => item.section === 'auto-update')).toBe(false)
    expect(settingsHits('加速提醒', windows).some((item) => item.section === 'notify-acceleration')).toBe(false)
    expect(settingsHits('卸载星芒').map((item) => item.section)).toEqual(['uninstall-app', 'uninstall'])
  })

  it('finds the pages and account tabs behind the words that used to find nothing', () => {
    expect(searchCommands('配置')[0]).toMatchObject({ group: 'page', page: 'home' })
    expect(searchCommands('换模型')[0]).toMatchObject({ group: 'page', page: 'home' })
    expect(searchCommands('检查更新')[0]).toMatchObject({ group: 'settings', page: 'settings', section: 'version' })
    expect(searchCommands('修改密码').find((item) => item.group === 'account')).toMatchObject({ section: 'change-password' })
    for (const word of ['扣费偏好', '先扣', '兑换码', '充值码']) expect(searchCommands(word).find((item) => item.group === 'account'), word).toMatchObject({ section: 'recharge' })
    for (const word of ['限额', '额度上限']) expect(searchCommands(word).find((item) => item.group === 'account'), word).toMatchObject({ section: 'keys' })
    expect(searchCommands('换账号').some((item) => item.section === 'switch-account')).toBe(true)
  })

  describe('the tool group', () => {
    const tools = [
      { id: 'claude', name: 'Claude Code', installed: true },
      { id: 'claudeDesktop', name: 'Claude Desktop', installed: false },
      { id: 'codex', name: 'Codex CLI', installed: true },
      { id: 'workbuddy', name: 'WorkBuddy', installed: false },
    ]

    it('offers opening and configuring an installed tool, and installing a missing one', () => {
      const claude = searchCommands('Claude', { tools }).filter((item) => item.group === 'tool')
      expect(claude.map((item) => item.label)).toEqual(['打开 Claude Code', 'Claude Code 配置', '安装 Claude Desktop'])
      expect(claude.map((item) => item.action)).toEqual(['openTool', 'configureTool', 'installTool'])
      expect(claude.map((item) => item.tool)).toEqual(['claude', 'claude', 'claudeDesktop'])
      expect(claude.every((item) => item.page === 'home')).toBe(true)
      expect(new Set(searchCommands('a', { tools }).map((item) => item.key)).size).toBe(searchCommands('a', { tools }).length)
    })

    it('finds a tool by its id and in any letter case', () => {
      expect(searchCommands('workbuddy', { tools }).find((item) => item.group === 'tool')).toMatchObject({ label: '安装 WorkBuddy', action: 'installTool', tool: 'workbuddy' })
      expect(searchCommands('CODEX', { tools }).filter((item) => item.group === 'tool').map((item) => item.label)).toEqual(['打开 Codex CLI', 'Codex CLI 配置'])
    })

    it('puts the tool group right after the pages', () => {
      const groups = searchCommands('Codex', { tools }).map((item) => item.group)
      const firstTool = groups.indexOf('tool')
      expect(firstTool).toBeGreaterThan(-1)
      expect(groups.slice(0, firstTool).every((group) => group === 'page')).toBe(true)
    })

    it('stays out of the list until something is typed, and out entirely without tools', () => {
      expect(searchCommands('', { tools }).some((item) => item.group === 'tool')).toBe(false)
      expect(searchCommands('Claude').some((item) => item.group === 'tool')).toBe(false)
    })
  })
})
