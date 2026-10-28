import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_VIDEO_TASK_VERSION, AiVideoTaskStore, MAXIMUM_FINISHED_VIDEO_TASKS, MAXIMUM_UNCONFIRMED_VIDEO_REQUESTS, type StoredAiVideoTask } from './ai-video-task-store'

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

  // 视频剪辑页关掉软件再打开时，按请求号找回那一段（审查清单 JJ-1）。
  it('drops a finished task and remembers which clip its request became', async () => {
    const { root, store } = fixture()
    await store.upsert(task('video-done'))
    await store.upsert({ ...task('video-waiting'), requestId: 'request-2' })
    const clip = { assetId: 'C'.repeat(43), width: 720, height: 1280, durationSeconds: 6 }
    await store.finish(task('video-done'), clip)

    const reopened = new AiVideoTaskStore({ rootDirectory: root, now: () => new Date('2026-10-26T00:00:00.000Z') })
    expect((await reopened.list(7)).map(({ taskId }) => taskId)).toEqual(['video-waiting'])
    await expect(reopened.findFinished(7, 'request-1')).resolves.toMatchObject({ requestId: 'request-1', taskId: 'video-done', ...clip })
    await expect(reopened.findFinished(7, 'request-2')).resolves.toBeNull()
    await expect(reopened.findFinished(8, 'request-1')).resolves.toBeNull()
    await expect(reopened.findFinished(7, 'bad\u0000id')).resolves.toBeNull()
    const content = fs.readFileSync(path.join(root, 'user-7', 'video-tasks.json'), 'utf8')
    expect(content).not.toMatch(/apiKey|accessToken|refreshToken|https?:\/\//)
  })

  it('keeps only the newest finished requests', async () => {
    const { store } = fixture()
    for (let index = 0; index <= MAXIMUM_FINISHED_VIDEO_TASKS; index += 1) {
      await store.finish({ userId: 7, taskId: `video-${index}`, requestId: `request-${index}` }, { assetId: String(index).padStart(43, 'a') })
    }
    await expect(store.findFinished(7, 'request-0')).resolves.toBeNull()
    await expect(store.findFinished(7, 'request-1')).resolves.toMatchObject({ taskId: 'video-1' })
    await expect(store.findFinished(7, `request-${MAXIMUM_FINISHED_VIDEO_TASKS}`)).resolves.toMatchObject({ taskId: `video-${MAXIMUM_FINISHED_VIDEO_TASKS}` })
  })

  it('drops a damaged finished entry on its own without losing the tasks still waiting', async () => {
    const { root, store } = fixture()
    await store.upsert(task('video-waiting'))
    await store.finish({ userId: 7, taskId: 'video-done', requestId: 'request-done' }, { assetId: 'C'.repeat(43) })
    const filePath = path.join(root, 'user-7', 'video-tasks.json')
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { finished: Record<string, unknown>[] }
    state.finished.push({ ...state.finished[0], requestId: 'request-bad', assetId: '../escape' })
    state.finished.push({ ...state.finished[0], requestId: 'https://evil.example/relay' })
    fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, 'utf8')

    const reopened = new AiVideoTaskStore({ rootDirectory: root })
    expect((await reopened.list(7)).map(({ taskId }) => taskId)).toEqual(['video-waiting'])
    await expect(reopened.findFinished(7, 'request-done')).resolves.toMatchObject({ assetId: 'C'.repeat(43) })
    await expect(reopened.findFinished(7, 'request-bad')).resolves.toBeNull()
    await expect(reopened.findFinished(7, 'https://evil.example/relay')).resolves.toBeNull()
    expect(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.includes('.corrupt-'))).toBe(false)
  })

  it('writes no finished list until there is one, so the file stays what older builds wrote', async () => {
    const { root, store } = fixture()
    await store.upsert(task())
    const state = JSON.parse(fs.readFileSync(path.join(root, 'user-7', 'video-tasks.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(['tasks', 'userId', 'version'])
  })

  it('remembers a request sent without a task id until it is cleared or its task is recorded', async () => {
    const { root, store } = fixture()
    const now = () => new Date('2026-10-28T00:00:00.000Z')
    const dated = new AiVideoTaskStore({ rootDirectory: root, now })
    await dated.markUnconfirmed(7, 'request-1')
    await dated.markUnconfirmed(7, 'request-2')

    const reopened = new AiVideoTaskStore({ rootDirectory: root })
    await expect(reopened.findUnconfirmed(7, 'request-1')).resolves.toEqual({ requestId: 'request-1', submittedAt: '2026-10-28T00:00:00.000Z' })
    await expect(reopened.findUnconfirmed(8, 'request-1')).resolves.toBeNull()
    await expect(reopened.findUnconfirmed(7, 'bad\u0000id')).resolves.toBeNull()
    await expect(reopened.markUnconfirmed(7, 'bad\u0000id')).rejects.toThrow('请求标识格式错误')

    // The task id came back: the request is no longer unclear, in the same write that records the task.
    const reservation = await store.reserve(7)
    await store.commitReservation(reservation, task())
    await expect(store.findUnconfirmed(7, 'request-1')).resolves.toBeNull()
    await store.clearUnconfirmed(7, 'request-2')
    await expect(store.findUnconfirmed(7, 'request-2')).resolves.toBeNull()
    const state = JSON.parse(fs.readFileSync(path.join(root, 'user-7', 'video-tasks.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(['tasks', 'userId', 'version'])
  })

  it('keeps only the newest unclear requests and drops a damaged one on its own', async () => {
    const { root, store } = fixture()
    await store.upsert(task('video-waiting'))
    for (let index = 0; index <= MAXIMUM_UNCONFIRMED_VIDEO_REQUESTS; index += 1) await store.markUnconfirmed(7, `request-${index}`)
    await expect(store.findUnconfirmed(7, 'request-0')).resolves.toBeNull()
    await expect(store.findUnconfirmed(7, `request-${MAXIMUM_UNCONFIRMED_VIDEO_REQUESTS}`)).resolves.toMatchObject({ requestId: `request-${MAXIMUM_UNCONFIRMED_VIDEO_REQUESTS}` })

    // A request id is whatever the page sent; one that looks like an endpoint must not condemn the paid tasks.
    await store.markUnconfirmed(7, 'https://evil.example/relay')
    const filePath = path.join(root, 'user-7', 'video-tasks.json')
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { unconfirmed: Record<string, unknown>[] }
    state.unconfirmed.push({ requestId: 'request-undated', submittedAt: 'yesterday' })
    fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, 'utf8')
    const reopened = new AiVideoTaskStore({ rootDirectory: root })
    expect((await reopened.list(7)).map(({ taskId }) => taskId)).toEqual(['video-waiting'])
    await expect(reopened.findUnconfirmed(7, 'https://evil.example/relay')).resolves.toBeNull()
    await expect(reopened.findUnconfirmed(7, 'request-undated')).resolves.toBeNull()
    await expect(reopened.findUnconfirmed(7, 'request-50')).resolves.toMatchObject({ requestId: 'request-50' })
    expect(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.includes('.corrupt-'))).toBe(false)
  })
})
