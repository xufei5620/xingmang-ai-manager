import { describe, expect, it } from 'vitest'
import { buildTutorialCardState, readTutorialProgress, recordTutorialProgress, tutorialProgressKey, type TutorialProgressStorage } from './tutorial-progress'

const topics = [
  { id: 'start', steps: [{}, {}, {}, {}] },
  { id: 'chat', steps: [{}, {}, {}] },
] as unknown as Parameters<typeof readTutorialProgress>[1]

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[tutorialProgressKey, initial]])
  const writes: string[] = []
  const storage: TutorialProgressStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes.push(value) },
  }
  return { storage, writes }
}

describe('tutorial progress', () => {
  it('reads only known chapters with whole step counts and caps them at the chapter length', () => {
    const { storage } = memoryStorage(JSON.stringify({ start: 2, chat: 9, gone: 3, broken: 'x', half: 1.5 }))
    expect(readTutorialProgress(storage, topics)).toEqual({ start: 2, chat: 3 })
  })

  it('treats missing, oversized or malformed storage as no progress', () => {
    expect(readTutorialProgress(null, topics)).toEqual({})
    expect(readTutorialProgress(memoryStorage().storage, topics)).toEqual({})
    expect(readTutorialProgress(memoryStorage('{not json').storage, topics)).toEqual({})
    expect(readTutorialProgress(memoryStorage('[1,2]').storage, topics)).toEqual({})
    expect(readTutorialProgress(memoryStorage(JSON.stringify({ start: -1, chat: 0 })).storage, topics)).toEqual({})
    expect(readTutorialProgress(memoryStorage(`{"start":2,"pad":"${'x'.repeat(4_000)}"}`).storage, topics)).toEqual({})
    const throwing: TutorialProgressStorage = { getItem: () => { throw new Error('denied') }, setItem: () => undefined }
    expect(readTutorialProgress(throwing, topics)).toEqual({})
  })

  it('only moves progress forward and keeps the same object when nothing changes', () => {
    const { storage, writes } = memoryStorage()
    const first = recordTutorialProgress(storage, {}, topics[0], 2)
    expect(first).toEqual({ start: 2 })
    expect(recordTutorialProgress(storage, first, topics[0], 1)).toBe(first)
    expect(recordTutorialProgress(storage, first, topics[0], 2)).toBe(first)
    const finished = recordTutorialProgress(storage, first, topics[0], 99)
    expect(finished).toEqual({ start: 4 })
    expect(writes.map((value) => JSON.parse(value))).toEqual([{ start: 2 }, { start: 4 }])
  })

  it('keeps the progress for this session when storage cannot be written', () => {
    const failing: TutorialProgressStorage = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(recordTutorialProgress(failing, {}, topics[1], 1)).toEqual({ chat: 1 })
    expect(recordTutorialProgress(null, {}, topics[1], 3)).toEqual({ chat: 3 })
  })

  it('words the card by how far the reader got and resumes at the first unread step', () => {
    expect(buildTutorialCardState(0, 4, 5)).toEqual({ text: '4 步，约 5 分钟', action: '开始', resumeAt: 0 })
    expect(buildTutorialCardState(1, 4, 5)).toEqual({ text: '已完成 1 / 4 步', action: '继续', resumeAt: 1 })
    expect(buildTutorialCardState(3, 4, 5)).toEqual({ text: '已完成 3 / 4 步', action: '继续', resumeAt: 3 })
    expect(buildTutorialCardState(4, 4, 5)).toEqual({ text: '已全部完成', action: '再看一遍', resumeAt: 0 })
  })
})
