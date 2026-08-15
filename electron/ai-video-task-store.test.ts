import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AiVideoTaskStore, type StoredAiVideoTask } from './ai-video-task-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-tasks-'))
  roots.push(root)
  return { root, store: new AiVideoTaskStore({ rootDirectory: root }) }
}

function task(taskId = 'video_123'): StoredAiVideoTask {
  return {
    version: 1, userId: 7, taskId, group: '生图分组', model: 'grok-imagine-video',
    requestId: 'request-1', createdAt: '2026-08-14T00:00:00.000Z',
  }
}

describe('AiVideoTaskStore', () => {
  it('persists pending tasks per account without credentials or remote URLs', async () => {
    const { root, store } = fixture()
    const scopedTask = { ...task(), projectId: '11111111-1111-4111-8111-111111111111' }
    await store.upsert(scopedTask)
    expect(await store.list(7)).toEqual([scopedTask])
    expect(await store.list(8)).toEqual([])
    const content = fs.readFileSync(path.join(root, 'user-7', 'video-tasks.json'), 'utf8')
    expect(content).not.toMatch(/apiKey|accessToken|refreshToken|https?:\/\//)
  })

  it('removes only an owned task and rejects unsafe identifiers', async () => {
    const { store } = fixture()
    await store.upsert(task('video-a'))
    await store.upsert(task('video-b'))
    await store.remove(7, 'video-a')
    expect((await store.list(7)).map(({ taskId }) => taskId)).toEqual(['video-b'])
    await expect(store.remove(7, '../escape')).rejects.toThrow('任务标识')
  })

  it('backs up corrupt state and degrades to an empty list', async () => {
    const { root, store } = fixture()
    await store.upsert(task())
    const filePath = path.join(root, 'user-7', 'video-tasks.json')
    fs.writeFileSync(filePath, '{invalid', 'utf8')
    expect(await store.list(7)).toEqual([])
    expect(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.includes('.corrupt-'))).toBe(true)
  })

  it('preserves all existing paid task ids when the recovery store reaches its limit', async () => {
    const { root, store } = fixture()
    const tasks = Array.from({ length: 200 }, (_, index) => ({
      ...task(`video-${index}`), requestId: `request-${index}`,
    }))
    const directory = path.join(root, 'user-7')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'video-tasks.json'), `${JSON.stringify({ version: 1, userId: 7, tasks })}\n`, 'utf8')

    await expect(store.upsert(task('video-new'))).rejects.toThrow('200 条上限')
    expect((await store.list(7)).map(({ taskId }) => taskId)).toEqual(tasks.map(({ taskId }) => taskId))

    await expect(store.upsert({ ...tasks[199], group: 'grok' })).resolves.toBeUndefined()
    const updated = await store.list(7)
    expect(updated).toHaveLength(200)
    expect(updated[0]).toMatchObject({ taskId: tasks[199].taskId, group: 'grok' })
  })

  it('reserves the final slot atomically and prevents ordinary writes from stealing it', async () => {
    const { root, store } = fixture()
    const tasks = Array.from({ length: 199 }, (_, index) => ({
      ...task(`video-${index}`), requestId: `request-${index}`,
    }))
    const directory = path.join(root, 'user-7')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'video-tasks.json'), `${JSON.stringify({ version: 1, userId: 7, tasks })}\n`, 'utf8')

    const reservationId = await store.reserve(7)
    await expect(store.reserve(7)).rejects.toThrow('200 条上限')
    await expect(store.upsert(task('video-unreserved'))).rejects.toThrow('200 条上限')

    await store.commitReservation(reservationId, task('video-reserved'))
    expect(await store.list(7)).toHaveLength(200)
    await expect(store.releaseReservation(7, reservationId)).resolves.toBeUndefined()
  })
})
