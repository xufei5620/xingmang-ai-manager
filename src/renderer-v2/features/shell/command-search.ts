import { accountSwitchAnchor, accountSwitchKeywords, accountTabs, settingsGroups, settingsItems, type SettingsItem } from '../../registry/business'
import { pageRegistry, pageSearchKeywords, type PageId } from '../../registry/pages'
import { tutorialTopics, type TutorialTopic } from '../../registry/tutorials'
import { searchWords, tutorialSearchText } from '../tutorial/tutorial-search'

export type CommandGroup = 'page' | 'tool' | 'action' | 'account' | 'settings' | 'tutorial'
/** 不只是跳页的那几条：开始检查、切换深浅色、打开帮助与客服、退出登录，「工具」组的打开、安装、配置。 */
export type CommandAction = 'check' | 'theme' | 'help' | 'logout' | 'openTool' | 'installTool' | 'configureTool'

/** 「工具」组按它列：装了的给「打开」「配置」，没装的给「安装」（v4 批 04）。 */
export interface CommandTool {
  id: string
  name: string
  installed: boolean
}

export interface CommandResult {
  key: string
  group: CommandGroup
  label: string
  page: PageId
  /** 那一页里要落的分页、分组、设置里的某一行或教程主题；缺省 = 只跳页。 */
  section?: string
  /** 选中后要做的事；缺省 = 跳到 page / section。 */
  action?: CommandAction
  /** 「工具」组那一条是哪个工具。 */
  tool?: string
}

export interface CommandSearchOptions {
  /** 当前账号用不上的个人中心分页（比如历史账号没有充值）不出现在结果里；缺省 = 全部显示。 */
  accountTabVisible?(tab: string): boolean
  /** 这台电脑上没有的页面（Linux 没有游戏加速）不出现在结果里；缺省 = 全部显示。 */
  pageVisible?(page: PageId): boolean
  /** 这台电脑上没有的设置项（Windows 上的「卸载星芒」、不支持自动更新时的「自动更新」）不出现在结果里；缺省 = 全部显示。 */
  settingsItemVisible?(item: SettingsItem): boolean
  /** 现在是深色还是浅色，「操作」里只给切到另一种的那一条；缺省 = 不给。 */
  theme?: 'light' | 'dark'
  /** 登录着才有「退出登录」；缺省 = 不给。 */
  signedIn?: boolean
  /** 首页那几个工具，按首页卡片的顺序；缺省 = 没有「工具」组。只在输了字时列。 */
  tools?: readonly CommandTool[]
}

/** 结果按这个次序分组显示，回车打开的是排在最前面的那一项。 */
export const commandGroupLabels: Record<CommandGroup, string> = {
  page: '页面',
  tool: '工具',
  action: '操作',
  account: '个人中心',
  settings: '设置',
  tutorial: '教程',
}
// 「操作」排在页面后面：搜「检查」先给检查页，不先给「开始检查」；什么都没输入时「操作」排最上面。
// 「工具」紧跟页面：搜「Codex」先给打开它，再给别的。
const commandGroupOrder: readonly CommandGroup[] = ['page', 'tool', 'action', 'account', 'settings', 'tutorial']
// 教程是全文搜的，常见词会命中一大串；列表只留最相关的几篇，其余到教程页里搜。
export const maximumTutorialResults = 5

interface Entry {
  result: CommandResult
  label: string
  keywords: readonly string[]
  /** 全文，只有教程有。 */
  body?: string
}

// 分数越小越靠前；null = 没命中。名字完全一样 < 名字开头 < 名字里有 < 常用说法里有 < 正文里有。
function score(entry: Entry, words: readonly string[]) {
  const label = entry.label.toLocaleLowerCase()
  const keywords = entry.keywords.map(word => word.toLocaleLowerCase())
  let worst = 0
  for (const word of words) {
    let best: number | null = null
    if (label === word) best = 0
    else if (label.startsWith(word)) best = 1
    else if (label.includes(word)) best = 2
    else if (keywords.some(keyword => keyword === word)) best = 3
    else if (keywords.some(keyword => keyword.includes(word))) best = 4
    else if (entry.body?.includes(word)) best = 5
    if (best === null) return null
    worst = Math.max(worst, best)
  }
  return worst
}

function pageEntries(options: CommandSearchOptions): Entry[] {
  return pageRegistry.filter(page => options.pageVisible?.(page.id) ?? true).map(page => ({ result: { key: `page:${page.id}`, group: 'page', label: page.label, page: page.id }, label: page.label, keywords: [page.id, ...pageSearchKeywords[page.id]] }))
}

function actionEntry(key: string, label: string, target: Pick<CommandResult, 'page' | 'section' | 'action'>, keywords: readonly string[]): Entry {
  return { result: { key: `action:${key}`, group: 'action', label, ...target }, label, keywords }
}

// 常用的几件事，不用先进页面再找按钮。
function actionEntries(options: CommandSearchOptions): Entry[] {
  const tabVisible = (tab: string) => options.accountTabVisible?.(tab) ?? true
  return [
    ...(tabVisible('recharge') ? [actionEntry('recharge', '充值', { page: 'account', section: 'recharge' }, ['余额', '买', '续费', '付款', '支付'])] : []),
    ...(tabVisible('dashboard') ? [actionEntry('usage', '查看用量账单', { page: 'account', section: 'dashboard' }, ['用量', '账单', '花了多少', '消耗', '统计'])] : []),
    actionEntry('check', '开始检查', { page: 'health', action: 'check' }, ['检测', '诊断', '体检', '环境']),
    ...(options.theme === 'dark' ? [actionEntry('theme', '切换到浅色', { page: 'settings', action: 'theme' }, ['浅色', '亮色', '白色', '主题', '外观', '深浅色'])] : []),
    ...(options.theme === 'light' ? [actionEntry('theme', '切换到深色', { page: 'settings', action: 'theme' }, ['深色', '暗色', '黑色', '主题', '外观', '深浅色'])] : []),
    actionEntry('help', '帮助与客服', { page: 'feedback', action: 'help' }, ['客服', '帮助', '联系', '二维码', '人工']),
  ]
}

// 工具挪进首页卡片以后，不用先回首页再找那张卡：装了的直接打开、配置，没装的直接装。
function toolEntries(options: CommandSearchOptions): Entry[] {
  return (options.tools ?? []).flatMap(tool => {
    const entry = (action: CommandAction, label: string): Entry => ({ result: { key: `tool:${action}:${tool.id}`, group: 'tool', label, page: 'home', action, tool: tool.id }, label, keywords: [tool.id, tool.name] })
    return tool.installed ? [entry('openTool', `打开 ${tool.name}`), entry('configureTool', `${tool.name} 配置`)] : [entry('installTool', `安装 ${tool.name}`)]
  })
}

// 页头的「切换账号」不是分页，哪种账号都有：点了停在当前分页，翻到那颗按钮。
function accountEntries(options: CommandSearchOptions): Entry[] {
  const tabs: Entry[] = accountTabs.filter(tab => options.accountTabVisible?.(tab.value) ?? true)
    .map(tab => ({ result: { key: `account:${tab.value}`, group: 'account', label: tab.label, page: 'account', section: tab.value }, label: tab.label, keywords: tab.keywords }))
  const logout: Entry[] = options.signedIn ? [{ result: { key: 'account:logout', group: 'account', label: '退出登录', page: 'account', action: 'logout' }, label: '退出登录', keywords: ['登出', '注销', '退出账号'] }] : []
  return [...tabs, { result: { key: `account:${accountSwitchAnchor}`, group: 'account', label: '切换账号', page: 'account', section: accountSwitchAnchor }, label: '切换账号', keywords: accountSwitchKeywords }, ...logout]
}

// 设置里每一行单独一条，写成「更新与关于 › 自动更新」，点了翻到那一行；只按行名和常用说法算分，
// 组名不算，免得搜「更新」把这一组十来行全拉出来。组本身也还是一条，排在它的行前面。
function settingsEntries(options: CommandSearchOptions): Entry[] {
  const groups: Entry[] = settingsGroups.map(group => ({ result: { key: `settings:${group.value}`, group: 'settings', label: group.label, page: 'settings', section: group.value }, label: group.label, keywords: group.keywords }))
  const items: Entry[] = settingsItems.filter(item => options.settingsItemVisible?.(item) ?? true).map(item => {
    const groupLabel = settingsGroups.find(group => group.value === item.group)?.label ?? ''
    return { result: { key: `settings-item:${item.id}`, group: 'settings', label: `${groupLabel} › ${item.label}`, page: 'settings', section: item.id }, label: item.label, keywords: item.keywords }
  })
  return [...groups, ...items]
}

function tutorialEntries(topics: readonly TutorialTopic[]): Entry[] {
  return topics.map(topic => ({ result: { key: `tutorial:${topic.id}`, group: 'tutorial', label: topic.title, page: 'tutorial', section: topic.id }, label: topic.title, keywords: topic.keywords, body: tutorialSearchText(topic) }))
}

/**
 * 顶部搜索的结果：页面、工具、操作、个人中心、设置（分组和每一行）、教程主题六组，组内按命中程度排。
 * 什么都没输入时先列操作、再列页面。
 */
export function searchCommands(query: string, options: CommandSearchOptions = {}, topics: readonly TutorialTopic[] = tutorialTopics): CommandResult[] {
  const words = searchWords(query)
  if (!words.length) return [...actionEntries(options), ...pageEntries(options)].map(entry => entry.result)
  const entries = [...pageEntries(options), ...toolEntries(options), ...actionEntries(options), ...accountEntries(options), ...settingsEntries(options), ...tutorialEntries(topics)]
  const hits = entries.flatMap((entry, index) => {
    const rank = score(entry, words)
    return rank === null ? [] : [{ entry, rank, index }]
  })
  return commandGroupOrder.flatMap(group => {
    // 「工具」组按首页卡片的次序排，不按命中程度：搜「Claude」时「Claude Code 配置」因为名字打头会排到
    // 「打开 Claude Code」前面，同一个工具的几条就被拆开了。
    const sorted = hits.filter(hit => hit.entry.result.group === group).sort((left, right) => (group === 'tool' ? 0 : left.rank - right.rank) || left.index - right.index)
    return (group === 'tutorial' ? sorted.slice(0, maximumTutorialResults) : sorted).map(hit => hit.entry.result)
  })
}
