import { describe, expect, it, vi } from 'vitest'
import type { VideoStudioProjectFile, VideoStudioProjectsWrite } from '../../../../electron/ipc-contract'
import { maxVideoStudioProjects, restoreVideoStudioItem, serializeVideoStudioItem } from './library'
import { createVideoStudioProject, defaultVideoStudioSettings, type VideoStudioProject } from './project'
import { exportableVideoStudioProjects, importVideoStudioProjects, planVideoStudioImport } from './transfer'

function film(idea: string, shots = 1): VideoStudioProject {
  return { ...createVideoStudioProject({ ...defaultVideoStudioSettings(), idea }), shots: Array.from({ length: shots }, (_, index) => ({ id: `shot-${index}`, prompt: `镜头 ${index}`, caption: '', status: 'idle' as const })) }
}

function file(id: string, idea: string, options: { name?: string, updatedAt?: number } = {}): VideoStudioProjectFile {
  return serializeVideoStudioItem({ id, updatedAt: options.updatedAt ?? 5, project: film(idea), ...(options.name ? { name: options.name } : {}) })
}

describe('exportableVideoStudioProjects', () => {
  it('takes the files as they are and leaves out the ones it cannot read', () => {
    const good = file('film-1', '海边')
    expect(exportableVideoStudioProjects([{ key: 'broken', content: '[]' }, good, { key: '../escape', content: good.content }])).toEqual([good])
  })
})

describe('planVideoStudioImport', () => {
  it('writes videos this computer does not have under their own key', () => {
    const incoming = file('film-1', '海边')
    expect(planVideoStudioImport([], [incoming])).toEqual({ put: [incoming], added: 1, skipped: 0 })
  })

  it('skips a video that is already here with the same storyboard', () => {
    const local = file('film-1', '海边', { updatedAt: 9 })
    expect(planVideoStudioImport([local], [file('film-1', '海边', { updatedAt: 3 })])).toEqual({ put: [], added: 0, skipped: 0 })
  })

  it('keeps the local video and saves the other one beside it, marked as imported', () => {
    const local = file('film-1', '海边', { name: '我的片子' })
    const plan = planVideoStudioImport([local], [file('film-1', '山里', { name: '我的片子' })])
    expect(plan).toMatchObject({ added: 1, skipped: 0 })
    expect(plan.put).toHaveLength(1)
    const copy = restoreVideoStudioItem(plan.put[0])
    expect(copy).toMatchObject({ id: 'film-1-imported', name: '我的片子（导入）' })
    expect(copy?.project.settings.idea).toBe('山里')
  })

  it('adds no second copy when the same file is imported again', () => {
    const local = file('film-1', '海边')
    const first = planVideoStudioImport([local], [file('film-1', '山里')])
    expect(planVideoStudioImport([local, ...first.put], [file('film-1', '山里')])).toEqual({ put: [], added: 0, skipped: 0 })
  })

  it('numbers the next copy when the imported one was changed here since', () => {
    const local = file('film-1', '海边')
    const changedCopy = file('film-1-imported', '改过的')
    const plan = planVideoStudioImport([local, changedCopy], [file('film-1', '山里')])
    expect(plan.put.map((entry) => entry.key)).toEqual(['film-1-imported-2'])
  })

  it('keeps a copy key and name within their limits', () => {
    const key = 'k'.repeat(64)
    const plan = planVideoStudioImport([file(key, '海边')], [file(key, '山里', { name: '名'.repeat(40) })])
    const copy = restoreVideoStudioItem(plan.put[0])
    expect(copy?.id).toHaveLength(64)
    expect(copy?.id.endsWith('-imported')).toBe(true)
    expect(copy?.name).toBe(`${'名'.repeat(36)}（导入）`)
  })

  it('counts what does not fit once this computer holds the most videos it keeps, and removes nothing', () => {
    const local = Array.from({ length: maxVideoStudioProjects - 1 }, (_, index) => file(`film-${index}`, `第 ${index} 条`))
    const plan = planVideoStudioImport(local, [file('new-1', '一'), file('new-2', '二'), file('new-3', '三')])
    expect(plan.put.map((entry) => entry.key)).toEqual(['new-1'])
    expect(plan).toMatchObject({ added: 1, skipped: 2 })
  })

  it('ignores files in the import it cannot read', () => {
    expect(planVideoStudioImport([], [{ key: 'broken', content: '{' }])).toEqual({ put: [], added: 0, skipped: 0 })
  })
})

describe('importVideoStudioProjects', () => {
  it('reads what this account has, then writes only the new files in one go', async () => {
    const local = file('film-1', '海边')
    const writes: VideoStudioProjectsWrite[] = []
    const bridge = {
      readVideoStudioProjects: vi.fn(async () => ({ index: null, projects: [local] })),
      writeVideoStudioProjects: vi.fn(async (write: VideoStudioProjectsWrite) => { writes.push(write) }),
    }
    await expect(importVideoStudioProjects(bridge, 'xm-account:7', [local, file('film-2', '山里')])).resolves.toEqual({ added: 1, skipped: 0 })
    expect(writes).toEqual([{ scope: 'xm-account:7', put: [file('film-2', '山里')], remove: [] }])
  })

  it('writes nothing when it cannot read what is here', async () => {
    const bridge = {
      readVideoStudioProjects: vi.fn(async () => { throw new Error('locked') }),
      writeVideoStudioProjects: vi.fn(async () => undefined),
    }
    await expect(importVideoStudioProjects(bridge, 'xm-account:7', [file('film-2', '山里')])).rejects.toThrow('locked')
    expect(bridge.writeVideoStudioProjects).not.toHaveBeenCalled()
  })

  it('does not even read when the file has no videos', async () => {
    const bridge = { readVideoStudioProjects: vi.fn(), writeVideoStudioProjects: vi.fn() }
    await expect(importVideoStudioProjects(bridge, 'xm-account:7', [])).resolves.toEqual({ added: 0, skipped: 0 })
    expect(bridge.readVideoStudioProjects).not.toHaveBeenCalled()
  })
})
