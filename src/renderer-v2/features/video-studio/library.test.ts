import { describe, expect, it, vi } from 'vitest'
import type { VideoStudioProjectFile, VideoStudioProjectsSnapshot, VideoStudioProjectsWrite } from '../../../../electron/ipc-contract'
import {
  cleanVideoStudioItemName,
  legacyCurrentVideoStudioItemId,
  loadVideoStudioLibrary,
  maxVideoStudioItemNameLength,
  maxVideoStudioProjects,
  readLegacyVideoStudioDrafts,
  restoreVideoStudioItem,
  restoreVideoStudioLibrary,
  serializeVideoStudioItem,
  sortVideoStudioItems,
  verifyVideoStudioMigration,
  videoStudioItemName,
  videoStudioLibraryIndex,
  videoStudioProjectContent,
  type VideoStudioItem,
  type VideoStudioLibraryBridge,
} from './library'
import { createVideoStudioProject, defaultVideoStudioSettings, restoreVideoStudioProject, videoStudioDraftProgress, type VideoStudioProject } from './project'

const scope = 'xm-account:7'
const now = Date.parse('2026-11-20T12:00:00+08:00')

function asset(letter: string): string { return letter.repeat(43) }

// —— 0.2.24 在 localStorage 里实际存的样子 ——
// 下面两段是照 0.2.24 的写法手写的，不经过现在的 serialize：新版改了存法，这里也不会跟着变，
// 所以它钉住的是「老版本留下的东西，新版照样一条不少地读得出来、抄得过去」。
const legacySettings = { shotCount: 3, secondsPerShot: 5, aspect: '9:16', captions: true, textModel: 'gpt-5.6-sol', textGroup: 'GPT', videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型', imageModel: 'gpt-image-2', imageGroup: '图片模型', resolution: 720, fit: 'cover', transition: 'fade', fadeOut: true, captionSize: 'large', captionPosition: 'top' }
function legacyClip(letter: string, seconds = 5) {
  return { assetId: asset(letter), thumbnailUrl: `xingmang-asset://thumb/v2/video/${asset(letter)}`, width: 720, height: 1280, durationSeconds: seconds }
}
// 手头那一条：一段已生成（剪过头）、一段带开头图还在等结果、一段上次提交结果不明，外加配乐和成片。
const legacyCurrent = JSON.stringify({
  version: 1,
  settings: { idea: '一只橘猫在下雨的东京街头找回家的路', ...legacySettings },
  title: '橘猫回家',
  shots: [
    { id: 'shot-a', prompt: '雨夜街头的橘猫', caption: '下雨了', clip: legacyClip('a'), trimStart: 0.5 },
    { id: 'shot-b', prompt: '橘猫跳上台阶', caption: '到家了', image: { assetId: asset('i') }, requestId: 'req-waiting-1' },
    { id: 'shot-c', prompt: '主人抱起橘猫', caption: '', seconds: 8, requestId: 'req-lost-1', unconfirmed: true },
  ],
  music: { assetId: asset('m'), name: '晴天.mp3', durationSeconds: 200, clipSound: 'quiet' },
  exported: legacyClip('x', 15),
})
// 草稿箱：三份，新的在前（0.2.24 把换下来的那一份放最前面）。
const legacyDrafts = JSON.stringify({
  version: 1,
  drafts: [
    { id: '0b6f3c1e-8a52-4c8e-9d0a-2f7c5a1e9b10', savedAt: now - 3_600_000, project: { version: 1, settings: { idea: '新品口红 15 秒', ...legacySettings, aspect: '1:1' }, title: '新品口红 15 秒', shots: [
      { id: 's1', prompt: '口红特写', caption: '新色上市', clip: legacyClip('b') },
      { id: 's2', prompt: '模特上妆', caption: '一抹显白', clip: legacyClip('c') },
      { id: 's3', prompt: '品牌标志', caption: '', clip: legacyClip('d') },
    ], exported: legacyClip('e', 15) } },
    { id: '5d2a9f04-1c3b-4e6f-8a7d-9b0c1d2e3f40', savedAt: now - 86_400_000, project: { version: 1, settings: { idea: '海边日落，镜头慢慢拉远', ...legacySettings, aspect: '16:9' }, title: '', shots: [] } },
    { id: '9e8d7c6b-5a49-4382-b716-0f1e2d3c4b5a', savedAt: now - 3 * 86_400_000, project: { version: 1, settings: { idea: '咖啡店的早晨', ...legacySettings }, title: '咖啡', shots: [
      { id: 'k1', prompt: '手冲咖啡', caption: '早安', clip: legacyClip('f') },
      { id: 'k2', prompt: '窗边的座位', caption: '' },
    ] } },
  ],
})

function legacyStorage(entries: Record<string, string> = { [`xingmang-ui-v2:video-studio:${scope}`]: legacyCurrent, [`xingmang-ui-v2:video-studio:${scope}:drafts`]: legacyDrafts }) {
  return { getItem: vi.fn((key: string) => entries[key] ?? null) }
}

/** 假的主进程文件库：一个账号一格，按 electron/video-studio-project-store.ts 的规矩先写文件、最后写记号。 */
function fakeStore() {
  const scopes = new Map<string, { index: string | null, files: Map<string, string> }>()
  const writes: VideoStudioProjectsWrite[] = []
  const reports: Array<{ level?: string, context?: string, message: string }> = []
  let failWrites = 0
  let corrupt: string | null = null
  const of = (name: string) => { const existing = scopes.get(name) ?? { index: null, files: new Map<string, string>() }; scopes.set(name, existing); return existing }
  const bridge: VideoStudioLibraryBridge = {
    readVideoStudioProjects: vi.fn(async (name: string): Promise<VideoStudioProjectsSnapshot> => {
      const stored = of(name)
      return { index: stored.index, projects: [...stored.files].map(([key, content]) => ({ key, content })) }
    }),
    writeVideoStudioProjects: vi.fn(async (input: VideoStudioProjectsWrite) => {
      writes.push(input)
      if (failWrites > 0) { failWrites -= 1; throw new Error("Error invoking remote method 'video-studio:write-projects': Error: 视频草稿超过 64 MB 安全上限，本次未保存") }
      const stored = of(input.scope)
      for (const file of input.put) stored.files.set(file.key, file.key === corrupt ? '{"version":1,"project":{"version":1,"settings":{},"title":"","shots":[]}}' : file.content)
      if (input.index !== undefined) stored.index = input.index
      for (const key of input.remove) stored.files.delete(key)
    }),
    reportRendererError: vi.fn(async (payload) => { reports.push(payload) }),
  }
  return { bridge, scopes, of, writes, reports, failNextWrites: (count: number) => { failWrites = count }, corruptOnWrite: (key: string) => { corrupt = key } }
}

function film(idea: string, shots = 0): VideoStudioProject {
  return { ...createVideoStudioProject({ ...defaultVideoStudioSettings(), idea }), shots: Array.from({ length: shots }, (_, index) => ({ id: `shot-${index}`, prompt: `镜头 ${index}`, caption: '', status: 'idle' as const })) }
}

describe('video studio library files', () => {
  it('writes one file per film and reads it back with its name, time and storyboard', () => {
    const item: VideoStudioItem = { id: 'film-1', name: '橘猫回家', updatedAt: now, project: film('回家的猫', 2) }
    const file = serializeVideoStudioItem(item)
    expect(file.key).toBe('film-1')
    expect(JSON.parse(file.content)).toMatchObject({ version: 1, name: '橘猫回家', updatedAt: now, project: { version: 1, shots: [{ id: 'shot-0' }, { id: 'shot-1' }] } })
    expect(restoreVideoStudioItem(file)).toEqual(item)
    // 没另起名的不写名字这一项，读回来也没有。
    const unnamed = serializeVideoStudioItem({ id: 'film-2', updatedAt: now, project: film('海边') })
    expect(JSON.parse(unnamed.content)).not.toHaveProperty('name')
    expect(restoreVideoStudioItem(unnamed)).toEqual({ id: 'film-2', updatedAt: now, project: film('海边') })
  })

  it('takes the id from the file name only and refuses content it cannot recognise, leaving the rest of the folder listed', () => {
    const good = serializeVideoStudioItem({ id: 'good', updatedAt: 5, project: film('好的') })
    expect(restoreVideoStudioItem({ key: '../escape', content: good.content })).toBeNull()
    expect(restoreVideoStudioItem({ key: 'bad', content: '{not json' })).toBeNull()
    expect(restoreVideoStudioItem({ key: 'bad', content: JSON.stringify({ version: 2, updatedAt: 1, project: JSON.parse(good.content).project }) })).toBeNull()
    expect(restoreVideoStudioItem({ key: 'bad', content: JSON.stringify({ version: 1, updatedAt: 1, project: { version: 9 } }) })).toBeNull()
    // 文件里另写一个 id 不算数；时间不对的排到最后；名字收成一行。
    const odd = restoreVideoStudioItem({ key: 'odd', content: JSON.stringify({ version: 1, id: 'someone-else', name: ' 第一行\n第二行\u0000 ', updatedAt: 'yesterday', project: JSON.parse(good.content).project }) })
    expect(odd).toMatchObject({ id: 'odd', name: '第一行 第二行', updatedAt: 0 })
    const files: VideoStudioProjectFile[] = [{ key: 'broken', content: '[]' }, good, serializeVideoStudioItem({ id: 'newer', updatedAt: 9, project: film('新的') })]
    expect(restoreVideoStudioLibrary(files).map((entry) => entry.id)).toEqual(['newer', 'good'])
  })

  it('names a film by what the customer called it, else its title or idea, and keeps a typed name to one short line', () => {
    expect(videoStudioItemName({ name: '我起的名字', project: { ...film('想法'), title: '片名' } })).toBe('我起的名字')
    expect(videoStudioItemName({ project: { ...film('想法'), title: '片名' } })).toBe('片名')
    expect(videoStudioItemName({ project: film('想法') })).toBe('想法')
    expect(videoStudioItemName({ project: createVideoStudioProject() })).toBe('新视频')
    expect(videoStudioItemName({ name: '起了名的空白', project: createVideoStudioProject() })).toBe('起了名的空白')
    expect(cleanVideoStudioItemName(`  ${'长'.repeat(60)}  `)).toHaveLength(maxVideoStudioItemNameLength)
    expect(cleanVideoStudioItemName('\n\t ')).toBe('')
    expect(cleanVideoStudioItemName(42)).toBe('')
  })

  it('lists the newest first, breaks ties the same way every time and never lists more than the main process stores', () => {
    const items = [{ id: 'b', updatedAt: 5, project: film('b') }, { id: 'c', updatedAt: 9, project: film('c') }, { id: 'a', updatedAt: 5, project: film('a') }]
    expect(sortVideoStudioItems(items).map((item) => item.id)).toEqual(['c', 'a', 'b'])
    const many = Array.from({ length: maxVideoStudioProjects + 7 }, (_, index) => serializeVideoStudioItem({ id: `film-${index}`, updatedAt: index + 1, project: film(`第 ${index} 条`) }))
    expect(restoreVideoStudioLibrary(many)).toHaveLength(maxVideoStudioProjects)
    expect(maxVideoStudioProjects).toBe(200)
  })

  it('tells a saved change from one that only moved progress along', () => {
    const waiting = { ...film('回家的猫', 1), shots: [{ id: 'shot-0', prompt: '镜头 0', caption: '', status: 'generating' as const, requestId: 'req-1' }] }
    const further = { ...waiting, shots: [{ ...waiting.shots[0], progress: 42, stage: 'processing' as const }] }
    expect(videoStudioProjectContent(further)).toBe(videoStudioProjectContent(waiting))
    expect(videoStudioProjectContent({ ...waiting, title: '新片名' })).not.toBe(videoStudioProjectContent(waiting))
  })
})

describe('upgrading from the drafts 0.2.24 kept in localStorage', () => {
  it('reads the film in hand and every draft-box entry, in hand first, without writing anything back', () => {
    const storage = legacyStorage()
    const drafts = readLegacyVideoStudioDrafts(storage, scope, now)
    expect(drafts.map((item) => [item.id, videoStudioItemName(item), videoStudioDraftProgress(item.project), item.updatedAt])).toEqual([
      [legacyCurrentVideoStudioItemId, '橘猫回家', '已合成 · 3 个镜头', now],
      ['0b6f3c1e-8a52-4c8e-9d0a-2f7c5a1e9b10', '新品口红 15 秒', '已合成 · 3 个镜头', now - 3_600_000],
      ['5d2a9f04-1c3b-4e6f-8a7d-9b0c1d2e3f40', '海边日落，镜头慢慢拉远', '尚未编写分镜', now - 86_400_000],
      ['9e8d7c6b-5a49-4382-b716-0f1e2d3c4b5a', '咖啡', '2 个镜头 · 已生成 1 段', now - 3 * 86_400_000],
    ])
    expect(Object.keys(storage)).toEqual(['getItem'])
    // 别的账号的格子不读。
    expect(readLegacyVideoStudioDrafts(storage, 'xm-account:8', now)).toEqual([])
    expect(readLegacyVideoStudioDrafts(null, scope, now)).toEqual([])
  })

  it('skips an empty film in hand and survives either slot being unreadable', () => {
    const empty = JSON.stringify({ version: 1, settings: { idea: '  ', ...legacySettings }, title: '', shots: [] })
    expect(readLegacyVideoStudioDrafts(legacyStorage({ [`xingmang-ui-v2:video-studio:${scope}`]: empty, [`xingmang-ui-v2:video-studio:${scope}:drafts`]: legacyDrafts }), scope, now)).toHaveLength(3)
    expect(readLegacyVideoStudioDrafts(legacyStorage({ [`xingmang-ui-v2:video-studio:${scope}`]: '{broken', [`xingmang-ui-v2:video-studio:${scope}:drafts`]: legacyDrafts }), scope, now)).toHaveLength(3)
    expect(readLegacyVideoStudioDrafts(legacyStorage({ [`xingmang-ui-v2:video-studio:${scope}`]: legacyCurrent, [`xingmang-ui-v2:video-studio:${scope}:drafts`]: 'null' }), scope, now).map((item) => item.id)).toEqual([legacyCurrentVideoStudioItemId])
  })

  it('copies every old draft into a file of its own, with nothing lost, and marks the copy done only afterwards', async () => {
    const store = fakeStore()
    const loaded = await loadVideoStudioLibrary(store.bridge, scope, legacyStorage(), now)

    expect(loaded.status).toBe('ready')
    expect(loaded.items).toHaveLength(4)
    expect(loaded.items.map((item) => [videoStudioItemName(item), videoStudioDraftProgress(item.project)])).toEqual([
      ['橘猫回家', '已合成 · 3 个镜头'],
      ['新品口红 15 秒', '已合成 · 3 个镜头'],
      ['海边日落，镜头慢慢拉远', '尚未编写分镜'],
      ['咖啡', '2 个镜头 · 已生成 1 段'],
    ])
    // 手头那一条里的每一样都跟着过来：剪掉的开头、开头图、等结果的请求号、结果不明的那一段、单独定的时长、配乐、成片、每一项设置。
    const inHand = loaded.items[0].project
    expect(inHand).toEqual(restoreVideoStudioProject(JSON.parse(legacyCurrent)))
    expect(inHand.settings).toMatchObject({ idea: '一只橘猫在下雨的东京街头找回家的路', ...legacySettings })
    expect(inHand.shots[0]).toMatchObject({ id: 'shot-a', prompt: '雨夜街头的橘猫', caption: '下雨了', clip: { assetId: asset('a') }, trimStart: 0.5, status: 'done' })
    expect(inHand.shots[1]).toMatchObject({ id: 'shot-b', image: { assetId: asset('i') }, requestId: 'req-waiting-1', status: 'generating' })
    expect(inHand.shots[2]).toMatchObject({ id: 'shot-c', seconds: 8, requestId: 'req-lost-1', unconfirmed: true, status: 'failed' })
    expect(inHand.music).toEqual({ assetId: asset('m'), name: '晴天.mp3', durationSeconds: 200, clipSound: 'quiet' })
    expect(inHand.exported).toMatchObject({ assetId: asset('x'), durationSeconds: 15 })
    expect(loaded.items[1].project.shots.map((shot) => shot.clip?.assetId)).toEqual([asset('b'), asset('c'), asset('d')])
    expect(loaded.items[3].project.shots.map((shot) => [shot.id, shot.clip?.assetId])).toEqual([['k1', asset('f')], ['k2', undefined]])

    // 一条一个文件；先写文件、读回来核对，最后才单独写记号。
    expect([...store.of(scope).files.keys()].sort()).toEqual(['0b6f3c1e-8a52-4c8e-9d0a-2f7c5a1e9b10', '5d2a9f04-1c3b-4e6f-8a7d-9b0c1d2e3f40', '9e8d7c6b-5a49-4382-b716-0f1e2d3c4b5a', legacyCurrentVideoStudioItemId].sort())
    expect(store.writes.map((write) => [write.put.length, write.index, write.remove])).toEqual([[4, undefined, []], [0, videoStudioLibraryIndex, []]])
    expect(store.of(scope).index).toBe(videoStudioLibraryIndex)
    expect(store.reports).toEqual([])
  })

  it('does not copy again once the copy is marked done, even after the old slots change', async () => {
    const store = fakeStore()
    const storage = legacyStorage()
    await loadVideoStudioLibrary(store.bridge, scope, storage, now)
    store.writes.length = 0
    storage.getItem.mockClear()

    const again = await loadVideoStudioLibrary(store.bridge, scope, storage, now + 1_000)
    expect(again.items).toHaveLength(4)
    expect(store.writes).toEqual([])
    expect(storage.getItem).not.toHaveBeenCalled()
  })

  it('keeps showing the old drafts and tries again next time when the copy cannot be written', async () => {
    const store = fakeStore()
    store.failNextWrites(1)
    const first = await loadVideoStudioLibrary(store.bridge, scope, legacyStorage(), now)

    expect(first.status).toBe('ready')
    expect(first.items.map((item) => videoStudioItemName(item))).toEqual(['橘猫回家', '新品口红 15 秒', '海边日落，镜头慢慢拉远', '咖啡'])
    expect(store.of(scope).index).toBeNull()
    expect(store.of(scope).files.size).toBe(0)
    await vi.waitFor(() => expect(store.reports).toHaveLength(1))
    expect(store.reports[0]).toMatchObject({ level: 'warn', context: 'video-studio-drafts' })
    // 日志里只有「没抄成」和原因，没有草稿里写的东西。
    expect(store.reports[0].message).not.toContain('橘猫')

    const second = await loadVideoStudioLibrary(store.bridge, scope, legacyStorage(), now)
    expect(second.items).toHaveLength(4)
    expect(store.of(scope).files.size).toBe(4)
    expect(store.of(scope).index).toBe(videoStudioLibraryIndex)
  })

  it('does not mark the copy done when a draft does not read back the same, and never overwrites a file already copied', async () => {
    const store = fakeStore()
    const bad = '9e8d7c6b-5a49-4382-b716-0f1e2d3c4b5a'
    store.corruptOnWrite(bad)
    const first = await loadVideoStudioLibrary(store.bridge, scope, legacyStorage(), now)

    // 那一条读回来镜头数对不上：这一次照老的那份显示，不写记号，刚写坏的那个文件拿掉（留着下次就不会再抄它）。
    expect(first.items).toHaveLength(4)
    expect(first.items.find((item) => item.id === bad)?.project.shots).toHaveLength(2)
    expect(store.of(scope).index).toBeNull()
    expect([...store.of(scope).files.keys()]).not.toContain(bad)
    expect(store.of(scope).files.size).toBe(3)
    await vi.waitFor(() => expect(store.reports).toHaveLength(1))

    // 这期间客户改了已经抄好的那一条：下次再抄时只补没抄成的那一条，不拿老的那份把改过的盖回去。
    const edited = serializeVideoStudioItem({ id: legacyCurrentVideoStudioItemId, name: '改过的名字', updatedAt: now + 5, project: restoreVideoStudioProject(JSON.parse(legacyCurrent))! })
    store.of(scope).files.set(edited.key, edited.content)
    store.corruptOnWrite('')
    store.writes.length = 0
    const second = await loadVideoStudioLibrary(store.bridge, scope, legacyStorage(), now + 10)
    expect(store.writes.flatMap((write) => write.put.map((file) => file.key))).toEqual([bad])
    expect(second.items).toHaveLength(4)
    expect(second.items.find((item) => item.id === legacyCurrentVideoStudioItemId)?.name).toBe('改过的名字')
    expect(second.items.find((item) => item.id === bad)?.project.shots).toHaveLength(2)
    expect(store.of(scope).index).toBe(videoStudioLibraryIndex)
  })

  it('checks the copy by storyboard length, clips, title and idea', () => {
    const before: VideoStudioItem = { id: 'a', updatedAt: 1, project: restoreVideoStudioProject(JSON.parse(legacyCurrent))! }
    const same = serializeVideoStudioItem(before)
    expect(verifyVideoStudioMigration([before], { index: null, projects: [same] })).toEqual([])
    expect(verifyVideoStudioMigration([before], { index: null, projects: [] })).toEqual(['a'])
    const fewerShots = serializeVideoStudioItem({ ...before, project: { ...before.project, shots: before.project.shots.slice(0, 2) } })
    const noClip = serializeVideoStudioItem({ ...before, project: { ...before.project, shots: before.project.shots.map(({ clip: _clip, ...shot }) => shot) } })
    const otherTitle = serializeVideoStudioItem({ ...before, project: { ...before.project, title: '别的' } })
    const otherIdea = serializeVideoStudioItem({ ...before, project: { ...before.project, settings: { ...before.project.settings, idea: '别的' } } })
    for (const file of [fewerShots, noClip, otherTitle, otherIdea, { key: 'a', content: '{broken' }]) {
      expect(verifyVideoStudioMigration([before], { index: null, projects: [file] })).toEqual(['a'])
    }
  })

  it('copies each account from its own slots and keeps them apart', async () => {
    const store = fakeStore()
    const other = 'xm-account:8'
    const storage = legacyStorage({
      [`xingmang-ui-v2:video-studio:${scope}`]: legacyCurrent,
      [`xingmang-ui-v2:video-studio:${other}`]: JSON.stringify({ version: 1, settings: { idea: '另一个账号的想法', ...legacySettings }, title: '', shots: [] }),
    })
    const mine = await loadVideoStudioLibrary(store.bridge, scope, storage, now)
    const theirs = await loadVideoStudioLibrary(store.bridge, other, storage, now)
    expect(mine.items.map((item) => videoStudioItemName(item))).toEqual(['橘猫回家'])
    expect(theirs.items.map((item) => videoStudioItemName(item))).toEqual(['另一个账号的想法'])
    expect(store.of(scope).files.size).toBe(1)
    expect(store.of(other).files.size).toBe(1)
  })

  it('writes nothing at all for an account with no old drafts, and lists the films already saved as files', async () => {
    const store = fakeStore()
    expect(await loadVideoStudioLibrary(store.bridge, scope, legacyStorage({}), now)).toEqual({ items: [], status: 'ready' })
    expect(store.writes).toEqual([])
    const saved = serializeVideoStudioItem({ id: 'made-in-new-version', updatedAt: now, project: film('新版里做的') })
    store.of(scope).files.set(saved.key, saved.content)
    const loaded = await loadVideoStudioLibrary(store.bridge, scope, legacyStorage({}), now)
    expect(loaded.items.map((item) => item.id)).toEqual(['made-in-new-version'])
    expect(store.writes).toEqual([])
  })

  it('reports the files as unreadable without copying anything when the folder cannot be read', async () => {
    const store = fakeStore()
    vi.mocked(store.bridge.readVideoStudioProjects).mockRejectedValueOnce(new Error('视频草稿超过 64 MB 安全上限，原始文件已保留'))
    expect(await loadVideoStudioLibrary(store.bridge, scope, legacyStorage(), now)).toEqual({ items: [], status: 'unreadable' })
    expect(store.writes).toEqual([])
  })
})
