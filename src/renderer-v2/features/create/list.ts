import { conversationDay, type Conversation, type ConversationDay, type ConversationListLabel } from '../chat/state'

// 「创作」左边那一列（融合第 1 步）：对话、视频、画布项目排在一起。这里全是纯计算：哪一行排在哪、筛出哪几行、时间怎么写。

/** 对话以外的一行：一条视频，或一个画布项目。 */
export type CreateExtraKind = 'video' | 'canvas'
export type CreateKind = 'chat' | CreateExtraKind

export interface CreateExtraItem {
  kind: CreateExtraKind
  id: string
  title: string
  /** 名字下面那行小字：视频是做到哪一步了，画布是「画布项目」。 */
  detail: string
  /** 最后一次动它的时间（毫秒）。 */
  updatedAt: number
}

/** 右边开着的是对话以外的哪一行。 */
export interface CreateSelection {
  kind: CreateExtraKind
  id: string
}

export type CreateFilter = 'all' | CreateKind
export type CreateRow = { kind: 'chat', conversation: Conversation } | { kind: CreateExtraKind, item: CreateExtraItem }

export const createKindNames: Record<CreateKind, string> = { chat: '对话', video: '视频', canvas: '画布' }

/** 搜索框下面那一排：只列这个账号有的那几类。 */
export function createFilterOptions(kinds: readonly CreateExtraKind[]): Array<{ value: CreateFilter, label: string }> {
  const shown: CreateKind[] = ['chat', ...(['video', 'canvas'] as const).filter((kind) => kinds.includes(kind))]
  return [{ value: 'all', label: '全部' }, ...shown.map((kind) => ({ value: kind, label: createKindNames[kind] }))]
}

/** 选着的那一类这个账号没有了（换成了没有视频的账号）就回到「全部」。 */
export function resolveCreateFilter(filter: CreateFilter, kinds: readonly CreateExtraKind[]): CreateFilter {
  return filter === 'all' || filter === 'chat' || kinds.includes(filter) ? filter : 'all'
}

/** 视频和画布项目只按名字搜；对话照旧连内容一起搜（chat/state 的 filterConversations）。 */
export function filterCreateExtras(items: readonly CreateExtraItem[], search: string): CreateExtraItem[] {
  const keyword = search.trim().toLocaleLowerCase()
  return keyword ? items.filter((item) => item.title.toLocaleLowerCase().includes(keyword)) : [...items]
}

const createDays: readonly ConversationDay[] = ['今天', '昨天', '更早']

// 一天里：对话保持原来的先后（同对话列表），视频和画布项目按最后动过的时间插进去，新的在前。
function mergeCreateDay(conversations: readonly Conversation[], extras: readonly CreateExtraItem[]): CreateRow[] {
  const sorted = [...extras].sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const rows: CreateRow[] = []
  let next = 0
  for (const conversation of conversations) {
    while (next < sorted.length && sorted[next].updatedAt > conversation.updatedAt) rows.push({ kind: sorted[next].kind, item: sorted[next++] })
    rows.push({ kind: 'chat', conversation })
  }
  while (next < sorted.length) rows.push({ kind: sorted[next].kind, item: sorted[next++] })
  return rows
}

/**
 * 列表上的分段：置顶的对话单独一段排最上面，其余按今天 / 昨天 / 更早分，三类混在一起排。
 * filter 选了某一类就只留那一类。
 */
export function groupCreateList(conversations: readonly Conversation[], extras: readonly CreateExtraItem[], filter: CreateFilter = 'all', now = Date.now()): Array<{ label: ConversationListLabel, rows: CreateRow[] }> {
  const chats = filter === 'all' || filter === 'chat' ? conversations : []
  const others = filter === 'all' ? extras : extras.filter((item) => item.kind === filter)
  const pinned = chats.filter((conversation) => conversation.pinned)
  const groups: Array<{ label: ConversationListLabel, rows: CreateRow[] }> = pinned.length ? [{ label: '置顶', rows: pinned.map((conversation) => ({ kind: 'chat', conversation })) }] : []
  for (const day of createDays) {
    const rows = mergeCreateDay(
      chats.filter((conversation) => !conversation.pinned && conversationDay(conversation.updatedAt, now) === day),
      others.filter((item) => conversationDay(item.updatedAt, now) === day),
    )
    if (rows.length) groups.push({ label: day, rows })
  }
  return groups
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** 「昨天 21:14」这样的时间：今天、昨天写出来，更早的写几月几日，不是今年的带上年份。 */
export function createTimeText(time: number, now = Date.now()): string {
  const date = new Date(time)
  const clock = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
  const day = conversationDay(time, now)
  if (day !== '更早') return `${day} ${clock}`
  const monthDay = `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  return date.getFullYear() === new Date(now).getFullYear() ? `${monthDay} ${clock}` : `${date.getFullYear()} 年 ${monthDay}`
}
