import { accountTabs, settingsGroups } from '../../registry/business'
import { pageRegistry, pageSearchKeywords, type PageId } from '../../registry/pages'
import { tutorialTopics, type TutorialTopic } from '../../registry/tutorials'
import { searchWords, tutorialSearchText } from '../tutorial/tutorial-search'

export type CommandGroup = 'page' | 'account' | 'settings' | 'tutorial'

export interface CommandResult {
  key: string
  group: CommandGroup
  label: string
  page: PageId
  /** 那一页里要落的分页、分组或教程主题；缺省 = 只跳页。 */
  section?: string
}

export interface CommandSearchOptions {
  /** 当前账号用不上的个人中心分页（比如历史账号没有充值）不出现在结果里；缺省 = 全部显示。 */
  accountTabVisible?(tab: string): boolean
}

/** 结果按这个次序分组显示，回车打开的是排在最前面的那一项。 */
export const commandGroupLabels: Record<CommandGroup, string> = {
  page: '页面',
  account: '个人中心',
  settings: '设置',
  tutorial: '教程',
}
const commandGroupOrder: readonly CommandGroup[] = ['page', 'account', 'settings', 'tutorial']
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

function pageEntries(): Entry[] {
  return pageRegistry.map(page => ({ result: { key: `page:${page.id}`, group: 'page', label: page.label, page: page.id }, label: page.label, keywords: [page.id, ...pageSearchKeywords[page.id]] }))
}

function accountEntries(options: CommandSearchOptions): Entry[] {
  return accountTabs.filter(tab => options.accountTabVisible?.(tab.value) ?? true)
    .map(tab => ({ result: { key: `account:${tab.value}`, group: 'account', label: tab.label, page: 'account', section: tab.value }, label: tab.label, keywords: tab.keywords }))
}

function settingsEntries(): Entry[] {
  return settingsGroups.map(group => ({ result: { key: `settings:${group.value}`, group: 'settings', label: group.label, page: 'settings', section: group.value }, label: group.label, keywords: group.keywords }))
}

function tutorialEntries(topics: readonly TutorialTopic[]): Entry[] {
  return topics.map(topic => ({ result: { key: `tutorial:${topic.id}`, group: 'tutorial', label: topic.title, page: 'tutorial', section: topic.id }, label: topic.title, keywords: topic.keywords, body: tutorialSearchText(topic) }))
}

/**
 * 顶部搜索的结果：页面、个人中心分页、设置分组、教程主题四组，组内按命中程度排。
 * 什么都没输入时只列页面，和原来一样。
 */
export function searchCommands(query: string, options: CommandSearchOptions = {}, topics: readonly TutorialTopic[] = tutorialTopics): CommandResult[] {
  const words = searchWords(query)
  if (!words.length) return pageEntries().map(entry => entry.result)
  const entries = [...pageEntries(), ...accountEntries(options), ...settingsEntries(), ...tutorialEntries(topics)]
  const hits = entries.flatMap((entry, index) => {
    const rank = score(entry, words)
    return rank === null ? [] : [{ entry, rank, index }]
  })
  return commandGroupOrder.flatMap(group => {
    const sorted = hits.filter(hit => hit.entry.result.group === group).sort((left, right) => left.rank - right.rank || left.index - right.index)
    return (group === 'tutorial' ? sorted.slice(0, maximumTutorialResults) : sorted).map(hit => hit.entry.result)
  })
}
