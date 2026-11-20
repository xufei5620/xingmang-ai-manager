import { describe, expect, it } from 'vitest'
import {
  applyVideoStudioPlan,
  createVideoStudioProject,
  openVideoStudioDraft,
  restoreVideoStudioDrafts,
  restoreVideoStudioProject,
  serializeVideoStudioDrafts,
  serializeVideoStudioProject,
  startVideoStudioProject,
  videoStudioDraftsStorageKey,
  videoStudioStorageKey,
  type VideoStudioDraft,
  type VideoStudioProject,
} from './project'
import { storeVideoStudioSwitch, type VideoStudioStorage } from './useVideoStudio'

const scope = 'xm-account:7'

function film(title: string, prompt: string): VideoStudioProject {
  let next = 0
  return applyVideoStudioPlan(createVideoStudioProject(), { title, shots: [{ prompt }] }, () => `${title}-${next++}`)
}

/** 像 localStorage 那样一格一格存；`fail` 返回 true 的那一次写入抛错，那一格保持原样。 */
function memoryStorage(cells: Record<string, string>, fail: (key: string, write: number) => boolean = () => false): VideoStudioStorage & { cells: Record<string, string> } {
  let writes = 0
  return {
    cells,
    getItem: (key) => cells[key] ?? null,
    setItem: (key, value) => {
      writes += 1
      if (fail(key, writes)) throw new DOMException('full', 'QuotaExceededError')
      cells[key] = value
    },
  }
}

function seeded(project: VideoStudioProject, drafts: readonly VideoStudioDraft[]) {
  return {
    [videoStudioStorageKey(scope)]: JSON.stringify(serializeVideoStudioProject(project)),
    [videoStudioDraftsStorageKey(scope)]: JSON.stringify(serializeVideoStudioDrafts(drafts)),
  }
}

/** 重开软件时读回来的样子：手上那一份的片名，和草稿箱里每一份的片名。 */
function reopened(storage: VideoStudioStorage) {
  const project = restoreVideoStudioProject(JSON.parse(storage.getItem(videoStudioStorageKey(scope)) ?? 'null'))
  const drafts = restoreVideoStudioDrafts(JSON.parse(storage.getItem(videoStudioDraftsStorageKey(scope)) ?? 'null'))
  return { project: project?.title, drafts: drafts.map((draft) => draft.project.title) }
}

describe('video studio draft switching', () => {
  const sunset = film('日落', '海浪')
  const coffee = film('咖啡', '拉花')
  const before: VideoStudioDraft[] = [{ id: 'draft-coffee', savedAt: 1, project: coffee }]
  const opened = openVideoStudioDraft(before, 'draft-coffee', sunset, 2, () => 'draft-sunset')!

  it('stores both the draft box and the film in hand when opening a draft', () => {
    const storage = memoryStorage(seeded(sunset, before))
    expect(storeVideoStudioSwitch(storage, scope, before, opened)).toBe(true)
    expect(reopened(storage)).toEqual({ project: '咖啡', drafts: ['日落'] })
  })

  // 11-18 复核 A01：草稿箱写好了、手上那一格没写成时，拿出来的那一份既不在手上也不在草稿箱里。
  it('puts the draft box back when the film in hand cannot be stored, so neither film is lost', () => {
    const storage = memoryStorage(seeded(sunset, before), (key) => key === videoStudioStorageKey(scope))
    expect(storeVideoStudioSwitch(storage, scope, before, opened)).toBe(false)
    expect(reopened(storage)).toEqual({ project: '日落', drafts: ['咖啡'] })
  })

  it('changes nothing when the draft box cannot be stored', () => {
    const cells = seeded(sunset, before)
    const untouched = { ...cells }
    const storage = memoryStorage(cells, (key) => key === videoStudioDraftsStorageKey(scope))
    expect(storeVideoStudioSwitch(storage, scope, before, opened)).toBe(false)
    expect(storage.cells).toEqual(untouched)
  })

  it('still reports the switch as not done when putting the draft box back fails too', () => {
    const storage = memoryStorage(seeded(sunset, before), (_key, write) => write > 1)
    expect(storeVideoStudioSwitch(storage, scope, before, opened)).toBe(false)
  })

  it('puts the draft box back the way the page shows it when starting a new film cannot store the empty one', () => {
    const started = startVideoStudioProject(before, sunset, 2, () => 'draft-sunset')!
    const storage = memoryStorage(seeded(sunset, before), (key) => key === videoStudioStorageKey(scope))
    expect(storeVideoStudioSwitch(storage, scope, before, started)).toBe(false)
    expect(reopened(storage)).toEqual({ project: '日落', drafts: ['咖啡'] })
  })

  it('has nothing to store without storage on this computer', () => {
    expect(storeVideoStudioSwitch(null, scope, before, opened)).toBe(true)
  })
})
