import { describe, expect, it } from 'vitest'
import { createConversation, type Conversation } from '../chat/state'
import { createFilterOptions, createTimeText, filterCreateExtras, groupCreateList, resolveCreateFilter, type CreateExtraItem, type CreateRow } from './list'

const now = new Date(2026, 10, 20, 15, 0).getTime()
const hour = 60 * 60 * 1000
const day = 24 * hour

function conversation(id: string, updatedAt: number, pinned = false): Conversation {
  return { ...createConversation(undefined, id), title: id, updatedAt, ...(pinned ? { pinned: true } : {}) }
}

function extra(kind: CreateExtraItem['kind'], id: string, updatedAt: number, title = id): CreateExtraItem {
  return { kind, id, title, detail: kind === 'canvas' ? '画布项目' : '尚未编写分镜', updatedAt }
}

function names(rows: readonly CreateRow[]): string[] {
  return rows.map((row) => row.kind === 'chat' ? `chat:${row.conversation.id}` : `${row.kind}:${row.item.id}`)
}

describe('the list of things made on the create page', () => {
  it('mixes conversations, films and canvas projects by when each was last touched, under today, yesterday and earlier', () => {
    const groups = groupCreateList(
      [conversation('c-now', now - hour), conversation('c-morning', now - 6 * hour), conversation('c-yesterday', now - day), conversation('c-old', now - 9 * day)],
      [extra('video', 'v-noon', now - 3 * hour), extra('canvas', 'k-yesterday', now - day - hour), extra('video', 'v-old', now - 30 * day), extra('canvas', 'k-fresh', now - 60_000)],
      'all', now,
    )
    expect(groups.map((group) => [group.label, names(group.rows)])).toEqual([
      ['今天', ['canvas:k-fresh', 'chat:c-now', 'video:v-noon', 'chat:c-morning']],
      ['昨天', ['chat:c-yesterday', 'canvas:k-yesterday']],
      ['更早', ['chat:c-old', 'video:v-old']],
    ])
  })

  it('keeps conversations in the order the chat page holds them, and only slots the other kinds in between', () => {
    // 对话列表的先后是它自己的（置顶、刚发过的在前），不一定跟 updatedAt 完全一致；这里不重排它。
    const groups = groupCreateList(
      [conversation('c-older-first', now - 5 * hour), conversation('c-newer-second', now - hour)],
      [extra('video', 'v-middle', now - 3 * hour), extra('video', 'v-newest', now - 60_000)],
      'all', now,
    )
    expect(names(groups[0].rows)).toEqual(['video:v-newest', 'video:v-middle', 'chat:c-older-first', 'chat:c-newer-second'])
  })

  it('puts pinned conversations in a section of their own at the top, whatever day they are from', () => {
    const groups = groupCreateList([conversation('c-today', now - hour), conversation('c-pinned', now - 40 * day, true)], [extra('video', 'v', now)], 'all', now)
    expect(groups.map((group) => [group.label, names(group.rows)])).toEqual([['置顶', ['chat:c-pinned']], ['今天', ['video:v', 'chat:c-today']]])
  })

  it('shows only the kind picked', () => {
    const conversations = [conversation('c', now - hour), conversation('p', now - 3 * day, true)]
    const extras = [extra('video', 'v', now - 2 * hour), extra('canvas', 'k', now - day)]
    expect(groupCreateList(conversations, extras, 'chat', now).flatMap((group) => names(group.rows))).toEqual(['chat:p', 'chat:c'])
    expect(groupCreateList(conversations, extras, 'video', now).map((group) => [group.label, names(group.rows)])).toEqual([['今天', ['video:v']]])
    expect(groupCreateList(conversations, extras, 'canvas', now).map((group) => [group.label, names(group.rows)])).toEqual([['昨天', ['canvas:k']]])
    expect(groupCreateList([], [], 'all', now)).toEqual([])
  })

  it('orders films and projects touched at the same moment the same way every time', () => {
    const rows = groupCreateList([], [extra('video', 'b', now), extra('canvas', 'a', now), extra('video', 'c', now)], 'all', now)[0].rows
    expect(names(rows)).toEqual(['canvas:a', 'video:b', 'video:c'])
  })

  it('offers only the kinds this account has, and falls back to everything when the picked kind is gone', () => {
    expect(createFilterOptions(['video', 'canvas']).map((option) => option.label)).toEqual(['全部', '对话', '视频', '画布'])
    expect(createFilterOptions(['canvas']).map((option) => option.value)).toEqual(['all', 'chat', 'canvas'])
    expect(createFilterOptions([]).map((option) => option.value)).toEqual(['all', 'chat'])
    expect(resolveCreateFilter('video', ['canvas'])).toBe('all')
    expect(resolveCreateFilter('video', ['video', 'canvas'])).toBe('video')
    expect(resolveCreateFilter('chat', [])).toBe('chat')
  })

  it('finds films and projects by name, ignoring case and outer spaces', () => {
    const items = [extra('video', 'v1', now, '橘猫回家'), extra('canvas', 'k1', now, 'Double 11 主图'), extra('video', 'v2', now, '海边日落')]
    expect(filterCreateExtras(items, '  ').map((item) => item.id)).toEqual(['v1', 'k1', 'v2'])
    expect(filterCreateExtras(items, ' double ').map((item) => item.id)).toEqual(['k1'])
    expect(filterCreateExtras(items, '日落').map((item) => item.id)).toEqual(['v2'])
    expect(filterCreateExtras(items, '没有这个')).toEqual([])
  })

  it('writes a time as today, yesterday, a date this year, or a date with its year', () => {
    expect(createTimeText(new Date(2026, 10, 20, 9, 5).getTime(), now)).toBe('今天 09:05')
    expect(createTimeText(new Date(2026, 10, 19, 21, 14).getTime(), now)).toBe('昨天 21:14')
    expect(createTimeText(new Date(2026, 10, 18, 8, 0).getTime(), now)).toBe('11 月 18 日 08:00')
    expect(createTimeText(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe('2025 年 12 月 31 日')
  })
})
