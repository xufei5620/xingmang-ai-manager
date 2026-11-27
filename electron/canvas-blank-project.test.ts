import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBlankCanvasProjectName, createBlankCanvasProjectCreator } from './canvas-blank-project'
import { CanvasProjectStore } from './canvas-project-store'

const roots: string[] = []
const userId = 7
const clicked = new Date(2026, 10, 27, 14, 30, 5)

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label))
  roots.push(root)
  return root
}

function setup(now = () => clicked) {
  const projects = new CanvasProjectStore(temporaryRoot('xingmang-blank-projects-'))
  const defaultRoot = path.join(temporaryRoot('xingmang-blank-documents-'), '星芒画布')
  const create = createBlankCanvasProjectCreator({ projects, defaultProjectsDirectory: () => defaultRoot, now })
  return { projects, defaultRoot, create }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('buildBlankCanvasProjectName', () => {
  it('names the project after the moment it was made, in the local clock', () => {
    expect(buildBlankCanvasProjectName(clicked)).toBe('未命名画布 11 月 27 日 14:30')
    expect(buildBlankCanvasProjectName(new Date(2027, 0, 3, 9, 5))).toBe('未命名画布 1 月 3 日 09:05')
  })
})

describe('createBlankCanvasProjectCreator', () => {
  it('registers an empty project for this account in a new folder under the default canvas folder, and hands back only its id and name', async () => {
    const { projects, defaultRoot, create } = setup()
    const created = await create(userId)
    expect(created).toEqual({ projectId: expect.any(String), projectName: '未命名画布 11 月 27 日 14:30' })
    expect(Object.keys(created).sort()).toEqual(['projectId', 'projectName'])

    const listed = await projects.list(userId)
    expect(listed.map((project) => [project.id, project.name])).toEqual([[created.projectId, '未命名画布 11 月 27 日 14:30']])
    // The colon cannot go into a Windows folder name; the folder is the project's own and nothing else is in it but its library.
    const folder = path.join(defaultRoot, '未命名画布 11 月 27 日 14 30')
    expect(path.resolve(await projects.getWorkspaceDirectory(userId, created.projectId) ?? '')).toBe(path.resolve(folder))
    expect(fs.readdirSync(defaultRoot)).toEqual(['未命名画布 11 月 27 日 14 30'])
    // Other accounts see nothing.
    expect(await projects.list(8)).toEqual([])
  })

  it('never reuses a folder: two projects made in the same minute get folders of their own', async () => {
    const { projects, defaultRoot, create } = setup()
    const first = await create(userId)
    const second = await create(userId)
    expect(first.projectId).not.toBe(second.projectId)
    expect(fs.readdirSync(defaultRoot).sort()).toEqual(['未命名画布 11 月 27 日 14 30', '未命名画布 11 月 27 日 14 30 (2)'])
    expect((await projects.list(userId)).length).toBe(2)
  })

  it('says in words the page can show why the folder could not be made, and registers nothing', async () => {
    const { projects, defaultRoot } = setup()
    // A file sits where the default folder should be.
    fs.mkdirSync(path.dirname(defaultRoot), { recursive: true })
    fs.writeFileSync(defaultRoot, 'not a folder')
    const create = createBlankCanvasProjectCreator({ projects, defaultProjectsDirectory: () => defaultRoot, now: () => clicked })
    await expect(create(userId)).rejects.toThrow(/^无法在「星芒画布」文件夹中新建项目（.+）。请打开画布，在「项目中心」中新建。$/)
    expect(await projects.list(userId)).toEqual([])
  })

  it('takes the folder it just made back away when the project cannot be registered, and passes the reason on', async () => {
    const defaultRoot = path.join(temporaryRoot('xingmang-blank-documents-'), '星芒画布')
    const refusal = new Error('画布项目数量已达上限，请先归档或删除不需要的项目')
    const projects = { create: vi.fn(async () => { throw refusal }) }
    const create = createBlankCanvasProjectCreator({ projects, defaultProjectsDirectory: () => defaultRoot, now: () => clicked })
    await expect(create(userId)).rejects.toBe(refusal)
    expect(projects.create).toHaveBeenCalledWith(userId, '未命名画布 11 月 27 日 14:30', path.join(defaultRoot, '未命名画布 11 月 27 日 14 30'))
    expect(fs.readdirSync(defaultRoot)).toEqual([])
  })
})
