import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_VIDEO_TASK_VERSION, AiVideoTaskStore, type StoredAiVideoTask } from './ai-video-task-store'

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
    version: AI_VIDEO_TASK_VERSION, userId: 7, taskId, group: '生图分组', model: 'grok-imagine-video',
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

  it('round-trips complete canvas run correlation and rejects partial or unsafe fields', async () => {
    const { store } = fixture()
    const correlated = {
      ...task(),
      runId: 'run-123',
      nodeId: 'video-node',
      attemptId: 'attempt-123',
      graphRevision: 'a'.repeat(64),
    }
    await store.upsert(correlated)
    await expect(store.list(7)).resolves.toEqual([correlated])
    await expect(store.upsert({ ...task('partial'), runId: 'run-only' })).rejects.toThrow('任务记录格式错误')
    await expect(store.upsert({ ...task('control'), runId: 'run\u0000bad', nodeId: 'node', attemptId: 'attempt', graphRevision: 'revision' }))
      .rejects.toThrow('任务记录格式错误')
    await expect(store.upsert({ ...task('long'), runId: 'x'.repeat(257), nodeId: 'node', attemptId: 'attempt', graphRevision: 'revision' }))
      .rejects.toThrow('任务记录格式错误')
    await expect(store.upsert({ ...task('revision'), runId: 'run', nodeId: 'node', attemptId: 'attempt', graphRevision: 'not-a-sha256' }))
      .rejects.toThrow('任务记录格式错误')
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

  it('carries the prompt so a task resumed after a restart can still label its clip', async () => {
    const { root, store } = fixture()
    const prompted = { ...task(), prompt: '海边的黄昏，镜头缓慢推近' }
    await store.upsert(prompted)
    await expect(store.list(7)).resolves.toEqual([prompted])
    const reopened = new AiVideoTaskStore({ rootDirectory: root })
    await expect(reopened.list(7)).resolves.toEqual([prompted])
  })

  it('refuses a prompt that is empty, over-long or carries control characters', async () => {
    const { store } = fixture()
    await expect(store.upsert({ ...task('blank'), prompt: '   ' })).rejects.toThrow('任务记录格式错误')
    await expect(store.upsert({ ...task('long'), prompt: 'x'.repeat(2_001) })).rejects.toThrow('任务记录格式错误')
    await expect(store.upsert({ ...task('control'), prompt: 'a\u0000b' })).rejects.toThrow('任务记录格式错误')
    // Newlines are ordinary in a prompt and must survive.
    await expect(store.upsert({ ...task('lines'), prompt: '第一行\n第二行' })).resolves.toBeUndefined()
  })

  it('reads a version 1 record written before prompts existed', async () => {
    const { root, store } = fixture()
    const directory = path.join(root, 'user-7')
    fs.mkdirSync(directory, { recursive: true })
    const legacy = {
      version: 1, userId: 7, taskId: 'video-legacy', group: '生图分组', model: 'grok-imagine-video',
      requestId: 'request-1', createdAt: '2026-08-14T00:00:00.000Z',
    }
    fs.writeFileSync(path.join(directory, 'video-tasks.json'), `${JSON.stringify({ version: 1, userId: 7, tasks: [legacy] })}\n`, 'utf8')

    // A task submitted before the upgrade still has to be resumable; it just
    // has no prompt to put on the finished asset.
    await expect(store.list(7)).resolves.toEqual([{ ...legacy, version: AI_VIDEO_TASK_VERSION }])
    expect(fs.readdirSync(directory).some((entry) => entry.includes('.corrupt-'))).toBe(false)
  })

  it('rejects an unknown schema version rather than reading fields it cannot vouch for', async () => {
    const { root, store } = fixture()
    const directory = path.join(root, 'user-7')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, 'video-tasks.json'),
      `${JSON.stringify({ version: AI_VIDEO_TASK_VERSION + 1, userId: 7, tasks: [task()] })}\n`,
      'utf8',
    )
    expect(await store.list(7)).toEqual([])
    expect(fs.readdirSync(directory).some((entry) => entry.includes('.corrupt-'))).toBe(true)
  })

  it('keeps one prompt quoting a URL from condemning every task waiting to resume', async () => {
    const { root, store } = fixture()
    // The tripwire against credentials and endpoints still runs over the rest
    // of the record, but a prompt is text the user wrote and is never fetched.
    const quoting = { ...task('video-quoting'), prompt: '参考 https://example.com/board 的构图' }
    await store.upsert(quoting)
    await store.upsert(task('video-other'))
    const reopened = new AiVideoTaskStore({ rootDirectory: root })
    expect((await reopened.list(7)).map(({ taskId }) => taskId)).toEqual(['video-other', 'video-quoting'])

    const filePath = path.join(root, 'user-7', 'video-tasks.json')
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { tasks: Record<string, unknown>[] }
    state.tasks[0].group = 'https://evil.example/relay'
    fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, 'utf8')
    expect(await new AiVideoTaskStore({ rootDirectory: root }).list(7)).toEqual([])
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
